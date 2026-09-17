// design: rule-files §7 — 条目级文件的读取：解析 YAML、按 schema 校验、失败给 XF-MODEL-001。
import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { ModelError } from './errors.js';
import { validate, type SchemaName } from './schemas.js';

export function parseYaml<T>(text: string, schema: SchemaName, where: string): T {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new ModelError('XF-MODEL-001', `${where}: 无法解析 YAML`, [String((error as Error).message)]);
  }
  const result = validate(schema, data);
  if (!result.ok) throw new ModelError('XF-MODEL-001', `${where}: 不符合 ${schema} 的形状`, result.errors);
  return data as T;
}

export async function readYaml<T>(path: string, schema: SchemaName): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ModelError('XF-MODEL-001', `${path}: 读不到文件`, [String((error as Error).message)]);
  }
  return parseYaml<T>(text, schema, path);
}

/** 序列化：键序保持插入序，不排序、不加时间戳；确定性由调用方保证。 */
export function toYaml(data: unknown): string {
  return stringify(data, { lineWidth: 0 });
}
