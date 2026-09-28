import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Stages every replacement before publishing; restores original bytes if any rename or validation fails. */
export async function replaceFiles(changes: Map<string, string | Buffer>, validate: () => Promise<void>): Promise<void> {
  const originals = new Map<string, Buffer | null>();
  const staged = new Map<string, string>();
  const published: string[] = [];
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
    await validate();
    committed = true;
  } catch (error) {
    try {
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
