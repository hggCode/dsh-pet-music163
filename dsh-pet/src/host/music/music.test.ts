/**
 * 音乐纯函数单测：签名拼接、LRC 解析与当前行、反查打分。
 * 只测不依赖网络/系统的部分（SMTC、HTTP 归集成验证）。
 * @module dsh-pet/src/host/music/music.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from './sign.ts';
import { parseLrc, lineIndexAt, window3 } from './lyrics.ts';
import { normTitle, scoreCandidate, pickBest } from './match.ts';

test('canonical: 剔除 sign 与空值，ASCII 升序，k=v 以 & 连接', () => {
  const s = canonical({ b: '2', a: '1', sign: 'x', empty: '', undef: undefined, c: '3' });
  assert.equal(s, 'a=1&b=2&c=3');
});

test('parseLrc: 解析时间戳、过滤空行与元信息、按时间升序', () => {
  const raw = [
    '[00:02.153]你坐在窗边看云走散',
    '[00:05.903]我假装翻书心却慌乱',
    '',
    '[00:00.00]作词 : 张三',
    '[00:10.05]',
  ].join('\n');
  const lines = parseLrc(raw);
  assert.deepEqual(
    lines.map((l) => l.text),
    ['你坐在窗边看云走散', '我假装翻书心却慌乱'],
  );
  assert.equal(lines[0].t.toFixed(3), '2.153');
});

test('lineIndexAt: 二分找当前行，早于首行返回 -1', () => {
  const lines = parseLrc('[00:01.00]a\n[00:05.00]b\n[00:09.00]c');
  assert.equal(lineIndexAt(lines, 0), -1);
  assert.equal(lineIndexAt(lines, 1), 0);
  assert.equal(lineIndexAt(lines, 6), 1);
  assert.equal(lineIndexAt(lines, 99), 2);
});

test('window3: 取前后三行，边界补空', () => {
  const lines = parseLrc('[00:01.00]a\n[00:05.00]b\n[00:09.00]c');
  assert.deepEqual(window3(lines, 1), { prev: '', cur: 'a', next: 'b' });
  assert.deepEqual(window3(lines, 6), { prev: 'a', cur: 'b', next: 'c' });
});

test('normTitle: 去括号后缀与 tail', () => {
  assert.equal(normTitle('晴天 (Live)'), '晴天');
  assert.equal(normTitle('Hello - Remastered'), 'hello');
});

test('pickBest: 有原唱时排除翻唱，低分返回 null', () => {
  const cands = [
    { id: 'cover', name: '晴天', fullArtists: [{ name: '某人' }], originCoverType: 0, visible: true },
    { id: 'orig', name: '晴天', fullArtists: [{ name: '周杰伦' }], originCoverType: 1, visible: true },
  ];
  assert.equal(pickBest(cands, '晴天', '周杰伦')?.id, 'orig');
  // 完全不同名 → null（不瞎猜）
  assert.equal(pickBest(cands, '七里香', '周杰伦'), null);
});

test('scoreCandidate: 歌名+歌手都中得分最高', () => {
  const a = scoreCandidate(
    { id: '1', name: '晴天', fullArtists: [{ name: '周杰伦' }], originCoverType: 1 },
    '晴天',
    '周杰伦',
  );
  const b = scoreCandidate(
    { id: '2', name: '晴天', fullArtists: [{ name: '翻唱歌手' }], originCoverType: 0 },
    '晴天',
    '周杰伦',
  );
  assert.ok(a > b);
});
