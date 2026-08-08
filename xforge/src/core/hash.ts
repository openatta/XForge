import { createHash } from 'node:crypto';

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      if (seen.has(item)) throw new TypeError('Cannot stringify a circular value');
      seen.add(item);
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value), null, 2);
}
