/**
 * 网易云开放平台请求签名（RSA_SHA256 / PKCS#1 v1.5）。
 *
 * 规则（实测自官方 python 示例 + 抓包核对）：剔除 `sign` 与空值 → 按 key ASCII 升序 →
 * 拼 `k=v` 用 `&` 连接（值用原始未编码）→ RSA 私钥签名 → Base64。
 * 纯函数，不碰网络与配置，便于单测。
 * @module dsh-pet/src/host/music/sign
 */
import { createSign } from 'node:crypto';

/** 原始私钥（X509 PKCS#8，无 PEM 头尾）包成 PEM。 */
export function toPem(raw: string): string {
  const s = raw.replace(/\s+/g, '');
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 64) lines.push(s.slice(i, i + 64));
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/** 待签名字符串：剔除 sign 与空值，ASCII 升序，`k=v` 以 `&` 连接。 */
export function canonical(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter(([k, v]) => k !== 'sign' && v !== undefined && v !== '')
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** 对 canonical 串签名，返回 Base64。 */
export function rsaSign(canonicalString: string, privateKeyRaw: string): string {
  return createSign('RSA-SHA256').update(canonicalString, 'utf8').sign(toPem(privateKeyRaw), 'base64');
}
