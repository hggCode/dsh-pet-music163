/**
 * 音乐领域路由：状态查询、播放控制、收藏、扫码登录。
 *
 * 与其余领域一致：未命中返回 undefined，命中返回 RouteResult；业务失败用 failResult（200）。
 * @module dsh-pet/src/host/routes/music
 */
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { failResult, methodNotAllowed, okResult } from './result.ts';

/** 音乐领域：`rest` 以 `music` 开头才处理。 */
export async function handleMusicRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { method, rest, url } = input;
  if (!rest.startsWith('music')) return undefined;
  const music = deps.music;

  if (rest === 'music/state') return okResult(music.getState());

  if (rest === 'music/control') {
    const action = url.searchParams.get('action');
    if (action !== 'playpause' && action !== 'next' && action !== 'prev') {
      return failResult('bad-request', 'action 必须是 playpause/next/prev');
    }
    music.control(action);
    return okResult({ ok: true });
  }

  if (rest === 'music/like') {
    if (method !== 'POST') return methodNotAllowed();
    return okResult(await music.like());
  }

  if (rest === 'music/align') {
    const sec = Number(url.searchParams.get('sec'));
    if (!Number.isFinite(sec) || sec < 0) return failResult('bad-request', 'sec 必须是非负数字');
    music.align(sec);
    return okResult({ ok: true });
  }

  if (rest === 'music/login/qr') return okResult(await music.loginQr());

  if (rest === 'music/login/poll') {
    const key = url.searchParams.get('key') ?? '';
    const anon = url.searchParams.get('anon') ?? '';
    if (!key || !anon) return failResult('bad-request', '缺少 key/anon');
    return okResult(await music.pollLogin(anon, key));
  }

  return undefined;
}
