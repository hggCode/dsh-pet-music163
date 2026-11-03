/**
 * LRC 歌词解析与"当前行"查找。
 *
 * 输入是网易云 `lyric/get/v2` 返回的 `[mm:ss.xxx] 文本` 逐行串；输出按时间升序的行数组。
 * 空行与元信息行（作词/作曲/编曲等）过滤掉——渲染三行歌词时它们只会闪一下。
 * 纯函数，便于单测。
 * @module dsh-pet/src/host/music/lyrics
 */

/** 一行歌词：起始秒 + 文本。 */
export interface LyricLine {
  t: number;
  text: string;
}

const TS = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** 解析 LRC 为升序行数组（无时间戳的行丢弃；元信息行丢弃）。 */
export function parseLrc(raw: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    // 一行可能带多个时间戳（同一句重复出现），逐个产出
    const stamps: number[] = [];
    TS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TS.exec(line)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0;
      stamps.push(min * 60 + sec + frac);
    }
    if (stamps.length === 0) continue;
    const text = line.replace(TS, '').trim();
    if (!text) continue;
    // 元信息行（"作词 : xxx" 之类）没有演唱内容，且通常时间戳挤在开头：按"含：/:"且极短"粗过滤
    if (/^[^:：]{1,8}[:：]/.test(text)) continue;
    for (const t of stamps) out.push({ t, text });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * 当前行下标：满足 `t <= pos` 的最后一个；pos 早于第一行返回 -1。
 * @param lines - 升序行数组。
 * @param pos - 播放进度（秒）。
 */
export function lineIndexAt(lines: LyricLine[], pos: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 取当前行前后三行；不足时补空。
 * @returns `{ prev, cur, next }`，cur 为当前行文本（无则空串）。
 */
export function window3(lines: LyricLine[], pos: number): { prev: string; cur: string; next: string } {
  const i = lineIndexAt(lines, pos);
  if (i < 0) return { prev: '', cur: lines[0]?.text ?? '', next: lines[1]?.text ?? '' };
  return {
    prev: i > 0 ? lines[i - 1].text : '',
    cur: lines[i]?.text ?? '',
    next: lines[i + 1]?.text ?? '',
  };
}
