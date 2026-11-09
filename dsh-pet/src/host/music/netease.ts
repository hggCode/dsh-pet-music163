/**
 * 网易云开放平台最小客户端：匿名/扫码登录、搜索、歌词、红心。
 *
 * 网关与 device 参数来自实测（文档示例的 openapi.music.163.com 与 iotapitest 均不可用）。
 * 所有业务参数塞进 `bizContent`，公共参数与签名走 query、POST、body 空。
 * 不持有登录态与缓存（归 ./service），这里只做一次请求。
 * @module dsh-pet/src/host/music/netease
 */
import { canonical, rsaSign } from './sign.ts';

/** 实测可用的网关。 */
export const HOST = 'https://openncm.music.163.com';

/** 登录/内容接口返回的原始 data。 */
interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

/** 搜索命中的歌曲条目（只列本模块用到的字段）。 */
export interface ApiSong {
  id: string;
  name: string;
  artists?: { name?: string }[];
  fullArtists?: { name?: string }[];
  originCoverType?: number;
  visible?: boolean;
  duration?: number;
  liked?: boolean;
}

/** 客户端构造参数。 */
export interface NeteaseOptions {
  appId: string;
  appSecret: string;
  privateKey: string;
  deviceId: string;
}

/** 起一次 POST 调用的结果：code 非 200 或网络错误都收成 `{ok:false}`。 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: number; message: string };

export class NeteaseClient {
  private readonly opts: NeteaseOptions;

  constructor(opts: NeteaseOptions) {
    this.opts = opts;
  }

  private deviceJson(): string {
    return JSON.stringify({
      deviceType: 'openapi',
      os: 'ncmcli',
      channel: 'ncmcli',
      brand: 'ncmcli',
      model: 'Windows_x64_cli',
      appVer: '0.1.7',
      osVer: '10.0.26300',
      clientIp: '127.0.0.1',
      deviceId: this.opts.deviceId,
    });
  }

  private async request<T>(path: string, biz: Record<string, unknown>, token?: string): Promise<ApiResult<T>> {
    const params: Record<string, string | undefined> = {
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      signType: 'RSA_SHA256',
      timestamp: String(Date.now()),
      device: this.deviceJson(),
      bizContent: JSON.stringify(biz),
    };
    // 只有真拿到 token 才放进对象：null/undefined 留在对象里时，URLSearchParams 会把它序列化成
    // 字面量 "accessToken=undefined" 拼进查询串，服务端签名校验随即失败（1402 非法sign）。
    if (token) params.accessToken = token;
    params.sign = rsaSign(canonical(params), this.opts.privateKey);
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    try {
      const res = await fetch(`${HOST}${path}?${qs}`, { method: 'POST', signal: AbortSignal.timeout(8000) });
      const body = (await res.json()) as ApiEnvelope<T>;
      if (body.code === 200) return { ok: true, data: body.data as T };
      return { ok: false, code: body.code, message: body.message ?? '' };
    } catch (e) {
      return { ok: false, code: -1, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 匿名 token：仅用于换取二维码（内容接口一律 301）。 */
  async anonymousToken(): Promise<ApiResult<string>> {
    const r = await this.request<{ accessToken: string }>('/openapi/music/basic/oauth2/login/anonymous', {
      clientId: this.opts.appId,
    });
    return r.ok ? { ok: true, data: r.data.accessToken } : r;
  }

  /** 取登录二维码（需要匿名 token 作为 accessToken）。 */
  async qrCode(anonToken: string): Promise<ApiResult<{ url: string; key: string }>> {
    const r = await this.request<{ qrCodeUrl: string; uniKey: string }>(
      '/openapi/music/basic/user/oauth2/qrcodekey/get/v2',
      { type: 2, expiredKey: '300' },
      anonToken,
    );
    return r.ok ? { ok: true, data: { url: r.data.qrCodeUrl, key: r.data.uniKey } } : r;
  }

  /** 轮询扫码：返回用户 token；status=803 才带 token。 */
  async pollLogin(
    anonToken: string,
    key: string,
  ): Promise<ApiResult<{ status: number; token?: string; refresh?: string }>> {
    const r = await this.request<{ status: number; accessToken?: { accessToken: string; refreshToken: string } }>(
      '/openapi/music/basic/oauth2/device/login/qrcode/get',
      { key, clientId: this.opts.appId },
      anonToken,
    );
    if (!r.ok) return r;
    const at = r.data.accessToken;
    return { ok: true, data: { status: r.data.status, token: at?.accessToken, refresh: at?.refreshToken } };
  }

  /**
   * 用 refreshToken 续期 accessToken（AT/RT 同时刷新）。不传 accessToken——续期靠
   * clientId + clientSecret + refreshToken 认证；带上已过期的 AT 反而可能被判 1406。
   */
  async refresh(
    refreshToken: string,
  ): Promise<ApiResult<{ accessToken: string; refreshToken: string; expiresTime?: number }>> {
    return this.request<{ accessToken: string; refreshToken: string; expiresTime?: number }>(
      '/openapi/music/basic/user/oauth2/token/refresh/v2',
      { clientId: this.opts.appId, clientSecret: this.opts.appSecret, refreshToken },
    );
  }

  /** 关键字搜索歌曲。 */
  async search(keyword: string, limit = 5): Promise<ApiResult<ApiSong[]>> {
    const r = await this.request<{ records?: ApiSong[] }>(
      '/openapi/music/basic/search/song/get/v3',
      { keyword, limit: String(limit), offset: '0' },
      this.token,
    );
    return r.ok ? { ok: true, data: r.data.records ?? [] } : r;
  }

  /** 逐行歌词（LRC）；无歌词时 data.lyric 为空。 */
  async lyric(songId: string): Promise<ApiResult<string>> {
    const r = await this.request<{ lyric?: string | null; noLyric?: boolean }>(
      '/openapi/music/basic/song/lyric/get/v2',
      { songId },
      this.token,
    );
    return r.ok ? { ok: true, data: r.data.noLyric ? '' : (r.data.lyric ?? '') } : r;
  }

  /** 收藏/取消收藏。 */
  async like(songId: string, isLike: boolean): Promise<ApiResult<null>> {
    const r = await this.request<null>('/openapi/music/basic/playlist/song/like/v2', { songId, isLike }, this.token);
    return r.ok ? { ok: true, data: null } : r;
  }

  /** 当前用户 token（由 service 注入，避免每次传参）。 */
  token = '';
}
