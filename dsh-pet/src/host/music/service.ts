/**
 * 音乐服务：把 SMTC 采样、网易云 API、歌词缓存与"进度时钟"揉成一个可查询的状态源。
 *
 * 进度时钟：SMTC 不给进度（客户端不上报时间轴），只能从"检测到曲目变化"起算。
 * 已知缺陷：宠物启动时若歌已在播、或用户拖动进度条，进度会偏，直到下一首或手动 align。
 * 只做网易云桌面客户端这一种来源；不碰播放内核。
 * @module dsh-pet/src/host/music/service
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAllConfig } from '../config.ts';
import type { ConfigPaths } from '../config.ts';
import { NeteaseClient, type ApiResult } from './netease.ts';
import { pickBest } from './match.ts';
import { parseLrc, window3, type LyricLine } from './lyrics.ts';
import { SmtcReader, smtcControl, type SmtcSample } from './smtc.ts';

/** 对外状态（helper 轮询这个）。 */
export interface MusicState {
  enabled: boolean;
  loggedIn: boolean;
  playing: boolean;
  app: string;
  title: string;
  artist: string;
  positionSec: number;
  prev: string;
  cur: string;
  next: string;
  liked: boolean;
  /** 无法显示时的原因（未配置/未登录/未匹配/纯音乐）。 */
  reason: '' | 'disabled' | 'unconfigured' | 'not-logged-in' | 'no-client' | 'no-lyric';
}

interface MusicConfig {
  enabled: boolean;
  appId: string;
  privateKey: string;
  appSecret: string;
}

/** 服务依赖。 */
export interface MusicDeps {
  configPaths: ConfigPaths;
  userRoot: string;
  log: (level: 'info' | 'warn', message: string) => void;
}

const TOKEN_FILE = 'music-token.json';

export class MusicService {
  private reader: SmtcReader | null = null;
  private client: NeteaseClient | null = null;
  private cfg: MusicConfig = { enabled: false, appId: '', privateKey: '', appSecret: '' };
  /** 用户登录的 refreshToken：accessToken 过期时用它自动续期（AT/RT 同时刷新）。 */
  private refreshToken = '';

  // 采样与时钟
  private sample: SmtcSample = { app: '', title: '', artist: '', status: '' };
  private trackKey = '';
  private baseSec = 0;
  private baseAt = 0;
  private paused = true;

  // 当前曲目的解析结果
  private songId = '';
  private lines: LyricLine[] = [];
  private liked = false;
  private resolving = false;
  private resolvedKey = '';

  private readonly deps: MusicDeps;

  constructor(deps: MusicDeps) {
    this.deps = deps;
  }

  /** 读配置并（在启用且填了密钥时）拉起 SMTC 读取器。读配置失败只告警，绝不拖垮插件装配。 */
  start(): void {
    try {
      this.cfg = this.readConfig();
    } catch (e) {
      this.deps.log('warn', '[dsh-pet] music: 配置读取失败，音乐功能停用 ' + String(e));
      return;
    }
    if (!this.cfg.enabled || !this.cfg.appId || !this.cfg.privateKey) return;
    this.client = new NeteaseClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      privateKey: this.cfg.privateKey,
      deviceId: 'dshpet_' + this.cfg.appId.slice(-12),
    });
    const stored = this.loadToken();
    this.client.token = stored.token;
    this.refreshToken = stored.refresh;
    this.reader = new SmtcReader((s) => this.onSample(s));
    this.reader.start();
    this.deps.log(
      'info',
      `[dsh-pet] music: SMTC 读取器已启动（appId=${this.cfg.appId.length} appSecret=${this.cfg.appSecret.length} key=${this.cfg.privateKey.length}）`,
    );
  }

  /**
   * 用**当前磁盘配置**重建客户端（保留已存 token）。用户可能在插件运行后才填好 appSecret，
   * 或启动时配置尚未就绪导致 appSecret 为空——那会让签名缺 appSecret、被判"非法 sign"。
   * 登录/收藏这类低频用户操作用它拿最新凭证，避免重建整个插件。
   */
  private refreshClient(): void {
    try {
      this.cfg = this.readConfig();
    } catch (e) {
      this.deps.log('warn', '[dsh-pet] music: 刷新配置失败 ' + String(e));
      return;
    }
    if (!this.cfg.appId || !this.cfg.privateKey) return;
    const stored = this.loadToken();
    const token = this.client?.token || stored.token;
    this.refreshToken = this.refreshToken || stored.refresh;
    this.client = new NeteaseClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      privateKey: this.cfg.privateKey,
      deviceId: 'dshpet_' + this.cfg.appId.slice(-12),
    });
    this.client.token = token;
  }

  stop(): void {
    this.reader?.stop();
    this.reader = null;
  }

  private readConfig(): MusicConfig {
    const main = readAllConfig(this.deps.configPaths).main ?? {};
    const appId = typeof main.musicAppId === 'string' ? main.musicAppId.trim() : '';
    const privateKey = typeof main.musicPrivateKey === 'string' ? main.musicPrivateKey.trim() : '';
    return {
      enabled: main.musicEnabled === true,
      appId,
      privateKey,
      // 应用级 appSecret 在匿名登录/签名里都要带；用户没单独配时按空串（签名仍可，若上游不要）
      appSecret: typeof main.musicAppSecret === 'string' ? main.musicAppSecret.trim() : '',
    };
  }

  private tokenPath(): string {
    return join(this.deps.userRoot, TOKEN_FILE);
  }

  private loadToken(): { token: string; refresh: string } {
    try {
      if (!existsSync(this.tokenPath())) return { token: '', refresh: '' };
      const o = JSON.parse(readFileSync(this.tokenPath(), 'utf8')) as { token?: string; refresh?: string };
      return { token: o.token ?? '', refresh: o.refresh ?? '' };
    } catch {
      return { token: '', refresh: '' };
    }
  }

  private saveToken(token: string, refresh?: string): void {
    try {
      writeFileSync(this.tokenPath(), JSON.stringify({ token, refresh: refresh ?? this.refreshToken }), 'utf8');
    } catch (e) {
      this.deps.log('warn', '[dsh-pet] music: token 落盘失败 ' + String(e));
    }
  }

  /** 用 refreshToken 续期；成功则更新内存与磁盘。 */
  private async doRefresh(): Promise<boolean> {
    if (!this.client || !this.refreshToken) return false;
    const r = await this.client.refresh(this.refreshToken);
    if (!r.ok) {
      // 1407/1408 = 账号或授权失效，刷新无用，只能重登；此处仅记日志，由调用方回落到"未授权"。
      this.deps.log('warn', `[dsh-pet] music: token 续期失败(${r.code}): ${r.message}`);
      return false;
    }
    this.client.token = r.data.accessToken;
    this.refreshToken = r.data.refreshToken;
    this.saveToken(r.data.accessToken, r.data.refreshToken);
    return true;
  }

  /**
   * 带自动续期的调用：先执行；若返回 1406（AT/RT 过期）或 1408（AT 无效），
   * 用 refreshToken 续期后重试一次。1407（账号被封/授权失效）不重试，直接返回。
   */
  private async callWithRefresh<T>(fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    const first = await fn();
    if (first.ok) return first;
    if ((first.code === 1406 || first.code === 1408) && (await this.doRefresh())) return fn();
    return first;
  }

  /** 收到一次 SMTC 采样：维护时钟与曲目切换。 */
  private onSample(s: SmtcSample): void {
    const key = s.title && s.artist ? `${s.title}\u0000${s.artist}` : '';
    const now = Date.now();
    if (key !== this.trackKey) {
      // 换曲：锚点归零（已知缺陷：启动晚于歌曲时会偏）
      this.trackKey = key;
      this.baseSec = 0;
      this.baseAt = now;
      this.paused = s.status !== 'playing';
      this.songId = '';
      this.lines = [];
      this.liked = false;
      this.resolvedKey = '';
      if (key) void this.resolveTrack(s);
    } else if (s.status === 'playing' && this.paused) {
      this.baseAt = now;
      this.paused = false;
    } else if (s.status !== 'playing' && !this.paused) {
      this.baseSec = this.position();
      this.paused = true;
    }
    this.sample = s;
  }

  private position(): number {
    return this.paused ? this.baseSec : this.baseSec + (Date.now() - this.baseAt) / 1000;
  }

  /** 反查 songId + 取歌词，按曲目缓存。 */
  private async resolveTrack(s: SmtcSample): Promise<void> {
    const key = `${s.title}\u0000${s.artist}`;
    if (this.resolving || this.resolvedKey === key || !this.client) return;
    this.resolving = true;
    try {
      const found = await this.callWithRefresh(() => this.client!.search(`${s.artist} ${s.title}`, 5));
      if (found.ok) {
        const best = pickBest(found.data, s.title, s.artist);
        if (best) {
          this.songId = best.id;
          this.liked = best.liked === true;
          const ly = await this.callWithRefresh(() => this.client!.lyric(best.id));
          if (ly.ok) this.lines = parseLrc(ly.data);
        }
      }
      this.resolvedKey = key;
    } finally {
      this.resolving = false;
    }
  }

  /** 手动对齐：把进度锚定到指定秒（用户点歌词列表里某句）。 */
  align(sec: number): void {
    this.baseSec = Math.max(0, sec);
    this.baseAt = Date.now();
  }

  /** 当前状态快照。 */
  getState(): MusicState {
    const base: MusicState = {
      enabled: this.cfg.enabled,
      loggedIn: !!this.client?.token,
      playing: this.sample.status === 'playing',
      app: this.sample.app,
      title: this.sample.title,
      artist: this.sample.artist,
      positionSec: 0,
      prev: '',
      cur: '',
      next: '',
      liked: this.liked,
      reason: '',
    };
    if (!this.cfg.enabled) return { ...base, reason: 'disabled' };
    if (!this.cfg.appId || !this.cfg.privateKey) return { ...base, reason: 'unconfigured' };
    if (!this.client?.token) return { ...base, reason: 'not-logged-in' };
    if (!this.sample.app) return { ...base, reason: 'no-client' };
    const pos = this.position();
    const w = window3(this.lines, pos);
    return {
      ...base,
      positionSec: pos,
      prev: w.prev,
      cur: w.cur,
      next: w.next,
      reason: this.lines.length === 0 ? 'no-lyric' : '',
    };
  }

  /** 播放控制（乐观更新由 helper 负责）。 */
  control(action: 'playpause' | 'next' | 'prev'): void {
    smtcControl(action);
    if (action === 'playpause') {
      if (this.sample.status === 'playing') {
        this.baseSec = this.position();
        this.paused = true;
      } else {
        this.baseAt = Date.now();
        this.paused = false;
      }
    }
  }

  /** 收藏/取消收藏当前曲目。 */
  async like(): Promise<{ ok: boolean; liked: boolean; message?: string }> {
    if (!this.client) return { ok: false, liked: this.liked, message: '未配置' };
    if (!this.client.token) return { ok: false, liked: this.liked, message: '未登录' };
    if (!this.songId) return { ok: false, liked: this.liked, message: '未匹配到当前歌曲' };
    const want = !this.liked;
    const r = await this.callWithRefresh(() => this.client!.like(this.songId, want));
    if (!r.ok) return { ok: false, liked: this.liked, message: r.message };
    this.liked = want;
    return { ok: true, liked: this.liked };
  }

  /** 生成登录二维码（P2）。 */
  async loginQr(): Promise<{ ok: boolean; url?: string; key?: string; anonToken?: string; message?: string }> {
    this.refreshClient();
    if (!this.client) return { ok: false, message: '未配置（缺少 AppID/私钥）' };
    if (!this.cfg.appSecret) return { ok: false, message: '缺少 musicAppSecret（设置页未填写，签名会非法）' };
    const anon = await this.client.anonymousToken();
    if (!anon.ok) return { ok: false, message: `匿名登录失败(${anon.code}): ${anon.message}` };
    const qr = await this.client.qrCode(anon.data);
    if (!qr.ok) return { ok: false, message: `取二维码失败(${qr.code}): ${qr.message}` };
    return { ok: true, url: qr.data.url, key: qr.data.key, anonToken: anon.data };
  }

  /** 轮询登录结果（P2）。 */
  async pollLogin(
    anonToken: string,
    key: string,
  ): Promise<{ ok: boolean; status?: number; loggedIn?: boolean; message?: string }> {
    if (!this.client) return { ok: false, message: '未配置' };
    const r = await this.client.pollLogin(anonToken, key);
    if (!r.ok) return { ok: false, message: r.message };
    if (r.data.token) {
      this.client.token = r.data.token;
      this.refreshToken = r.data.refresh ?? this.refreshToken;
      this.saveToken(r.data.token, this.refreshToken);
      this.resolvedKey = '';
      return { ok: true, status: r.data.status, loggedIn: true };
    }
    return { ok: true, status: r.data.status, loggedIn: false };
  }
}
