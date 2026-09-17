// design: rule-files §0 — D4 内容修订；§5.2 台账摘要；§5.3 receipt 与审计事件的规范哈希。
import { createHash, createHmac } from 'node:crypto';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** D4：按路径排序，逐个 sha256(path + "\0" + bytes)，再对拼接的十六进制整体 sha256。 */
export function contentRevision(files: ReadonlyArray<{ path: string; bytes: Uint8Array | string }>): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts = sorted.map((f) => {
    const h = createHash('sha256');
    h.update(f.path);
    h.update('\0');
    h.update(f.bytes);
    return h.digest('hex');
  });
  return sha256(parts.join(''));
}

/** 规范 JSON：对象键按字典序、无空白；用于 receipt 与审计事件的 hash。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** 对一条记录求 hash，跳过它自己的 hash / hmac 字段。 */
export function recordHash(record: Record<string, unknown>, omit: readonly string[] = ['hash', 'hmac']): string {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (!omit.includes(k)) body[k] = v;
  return sha256(canonicalJson(body));
}

/** RF-22：台账摘要 = 文件内容的 sha256。 */
export function ledgerDigest(text: string): string {
  return sha256(text);
}
