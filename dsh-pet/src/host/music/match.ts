/**
 * 反查打分：把 SMTC 给的「歌名 + 歌手」与搜索结果逐条比对，选最可能是原唱的那条。
 *
 * 实测教训：搜「晴天 周杰伦」首条是 1:52 的翻唱（originCoverType=0），直接取第一条会取错。
 * 规则（分高者胜，同分优先靠前）：歌名归一化后完全相等 > 歌手命中 > 原唱 > 有版权 > 名字包含。
 * 低于阈值一律返回 null，宁可不出歌词也不瞎猜。
 * 纯函数，便于单测。
 * @module dsh-pet/src/host/music/match
 */

/** 搜索结果里本模块用到的字段。 */
export interface SongCandidate {
  id: string;
  name: string;
  artists?: { name?: string }[];
  fullArtists?: { name?: string }[];
  originCoverType?: number;
  visible?: boolean;
  duration?: number;
  liked?: boolean;
}

/** 歌名归一化：去括号后缀（(Live)（电影…）等）、去首尾空白、小写。 */
export function normTitle(s: string): string {
  return s
    .replace(/[（(【].*?[)）】]/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\s*[-–—]\s*(live|remaster(ed)?|伴奏|instrumental).*$/i, '')
    .trim()
    .toLowerCase();
}

function artistNames(c: SongCandidate): string[] {
  const list = c.fullArtists && c.fullArtists.length > 0 ? c.fullArtists : (c.artists ?? []);
  return list.map((a) => (a.name ?? '').toLowerCase()).filter(Boolean);
}

/**
 * 给一个候选打分。
 * @param cand - 搜索结果条目。
 * @param title - 目标歌名（SMTC）。
 * @param artist - 目标歌手（SMTC）。
 */
export function scoreCandidate(cand: SongCandidate, title: string, artist: string): number {
  const nt = normTitle(title);
  const at = artist.toLowerCase();
  let score = 0;
  const cn = normTitle(cand.name);
  if (cn === nt) score += 100;
  else if (cn.includes(nt) || nt.includes(cn)) score += 40;
  const names = artistNames(cand);
  if (at && names.some((n) => n === at || n.includes(at) || at.includes(n))) score += 50;
  if (cand.originCoverType === 1) score += 20; // 原唱
  if (cand.visible === true) score += 5;
  return score;
}

/**
 * 从候选里选最佳；低于阈值返回 null。
 * @param candidates - 搜索结果。
 * @param title - 目标歌名。
 * @param artist - 目标歌手。
 * @param minScore - 最低分，默认 100（要求歌名完全相等，或歌名+歌手都中）。
 */
export function pickBest(
  candidates: SongCandidate[],
  title: string,
  artist: string,
  minScore = 100,
): SongCandidate | null {
  let best: SongCandidate | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const s = scoreCandidate(c, title, artist);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return bestScore >= minScore ? best : null;
}
