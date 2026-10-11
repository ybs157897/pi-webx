import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Stages every replacement (and deletion) before publishing; restores original
 * bytes for writes and re-creates deleted files if any rename or validation fails.
 */
export async function replaceFiles(
  changes: Map<string, string | Buffer>,
  validate: () => Promise<void>,
  deletes: readonly string[] = [],
): Promise<void> {
  const originals = new Map<string, Buffer | null>();
  const staged = new Map<string, string>();
  const published: string[] = [];
  const removed: Array<{ file: string; original: Buffer | null }> = [];
  const createdDirectories: string[] = [];
  async function ensureDirectory(directory: string): Promise<void> {
    try {
      await mkdir(directory, { mode: 0o700 });
      createdDirectories.push(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        await ensureDirectory(path.dirname(directory));
        await ensureDirectory(directory);
      } else if (code === 'EEXIST') {
        const existing = await lstat(directory);
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('资源目录不允许符号链接');
      } else throw error;
    }
  }
  let committed = false;
  try {
    for (const [file, value] of changes) {
      await ensureDirectory(path.dirname(file));
      try { originals.set(file, await readFile(file)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        originals.set(file, null);
      }
      const temporary = `${file}.${randomUUID()}.tmp`;
      staged.set(file, temporary);
      await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
    }
    for (const [file, temporary] of staged) {
      if (originals.get(file) === null) {
        await link(temporary, file);
        published.push(file);
        await rm(temporary);
        continue;
      }
      await rename(temporary, file);
      published.push(file);
    }
    // 删除在写入落位之后、校验之前执行：校验失败时按快照恢复被删文件。
    for (const file of deletes) {
      let original: Buffer | null = null;
      try { original = await readFile(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await unlink(file);
      removed.push({ file, original });
    }
    await validate();
    committed = true;
  } catch (error) {
    try {
      for (const { file, original } of removed.reverse()) {
        if (original === null) continue;
        const temporary = `${file}.${randomUUID()}.rollback`;
        try {
          await writeFile(temporary, original, { flag: 'wx', mode: 0o600 });
          await rename(temporary, file);
        } finally { await rm(temporary, { force: true }); }
      }
      for (const file of published.reverse()) {
        const original = originals.get(file);
        if (original === null) await rm(file, { force: true });
        else if (original) {
          const temporary = `${file}.${randomUUID()}.rollback`;
          try {
            await writeFile(temporary, original, { flag: 'wx', mode: 0o600 });
            await rename(temporary, file);
          } finally { await rm(temporary, { force: true }); }
        }
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], '配置回滚失败');
    }
    throw error;
  } finally {
    await Promise.all([...staged.values()].map(file => rm(file, { force: true })));
    if (!committed) {
      for (const directory of createdDirectories.reverse()) {
        try { await rmdir(directory); }
        catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
    }
  }
}
