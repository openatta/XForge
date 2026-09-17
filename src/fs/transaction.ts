// design: cli §1.2 — 受治理写入：一次命令的多份写入与追加放同一事务，任一失败整体回滚（`写必须能回退`）。
import { copyFile, mkdir, open, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

type Op =
  | { kind: 'write'; path: string; content: string; existed: boolean; backup?: string }
  | { kind: 'append'; path: string; content: string; priorSize: number }
  | { kind: 'rmdir'; path: string };

export class Transaction {
  private readonly ops: Op[] = [];
  private readonly touched = new Set<string>();
  private readonly id = `${process.pid}-${Date.now().toString(36)}`;

  constructor(
    private readonly projectRoot: string,
    private readonly txDir: string,
  ) {}

  write(path: string, content: string): void {
    this.ops.push({ kind: 'write', path, content, existed: false });
    this.touched.add(path);
  }

  append(path: string, content: string): void {
    this.ops.push({ kind: 'append', path, content, priorSize: -1 });
    this.touched.add(path);
  }

  removeDir(path: string): void {
    this.ops.push({ kind: 'rmdir', path });
    this.touched.add(path);
  }

  /** 本事务将改动的路径，相对项目根，供信封 `changed`。 */
  changed(): string[] {
    return [...this.touched].map((p) => relative(this.projectRoot, p)).sort();
  }

  isEmpty(): boolean {
    return this.ops.length === 0;
  }

  /** 尚未落盘的整文件写入（路径 → 内容），让同一事务里后续的计算能看到它们。 */
  pending(): Map<string, string> {
    const out = new Map<string, string>();
    for (const op of this.ops) if (op.kind === 'write') out.set(op.path, op.content);
    return out;
  }

  async commit(): Promise<string[]> {
    if (!this.ops.length) return [];
    const marker = join(this.txDir, `${this.id}.json`);
    await mkdir(this.txDir, { recursive: true });
    await writeFile(marker, JSON.stringify({ id: this.id, paths: this.changed() }) + '\n');
    const done: Op[] = [];
    try {
      for (const op of this.ops) {
        await this.apply(op);
        done.push(op);
      }
      await rm(marker, { force: true });
      await rm(this.txDir, { recursive: true, force: true }).catch(() => undefined);
      return this.changed();
    } catch (error) {
      for (const op of done.reverse()) await this.undo(op).catch(() => undefined);
      await rm(marker, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async apply(op: Op): Promise<void> {
    if (op.kind === 'write') {
      await mkdir(dirname(op.path), { recursive: true });
      try {
        await stat(op.path);
        op.existed = true;
        op.backup = join(this.txDir, `${this.id}-${this.ops.indexOf(op)}.bak`);
        await copyFile(op.path, op.backup);
      } catch {
        op.existed = false;
      }
      const tmp = `${op.path}.${this.id}.tmp`;
      await writeFile(tmp, op.content);
      await rename(tmp, op.path);
      return;
    }
    if (op.kind === 'append') {
      await mkdir(dirname(op.path), { recursive: true });
      const handle = await open(op.path, 'a');
      try {
        op.priorSize = (await handle.stat()).size;
        await handle.writeFile(op.content);
      } finally {
        await handle.close();
      }
      return;
    }
    await rm(op.path, { recursive: true, force: true });
  }

  private async undo(op: Op): Promise<void> {
    if (op.kind === 'write') {
      if (op.existed && op.backup) {
        await copyFile(op.backup, op.path);
        await rm(op.backup, { force: true });
      } else {
        await rm(op.path, { force: true });
      }
      return;
    }
    if (op.kind === 'append' && op.priorSize >= 0) await truncate(op.path, op.priorSize);
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
