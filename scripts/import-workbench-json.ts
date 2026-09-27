import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkbenchStore, defaultWorkbenchDbPath } from '../server/workbench/store';

const sourcePath = process.argv[2];
const replace = process.argv.includes('--replace');
if (!sourcePath || !sourcePath.endsWith('.json')) {
  console.error('用法：npm run import:workbench-json -- /绝对路径/data/workbench.json [--replace]');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(resolve(sourcePath), 'utf8')) as Record<string, unknown>;

const store = new WorkbenchStore();
try {
  const current = store.read();
  // 已退役的生活模块（hotspots/exercises/meals/finance/reviews/pets/relationships）
  // 不在导入范围：store.import 只认现役模块键，旧导出里的这些键会被静默丢弃。
  const occupied = ['tasks', 'works', 'fixes', 'logs', 'requirements', 'codes', 'knowledge']
    .some((module) => (current[module as keyof typeof current] as unknown[]).length > 0);
  if (occupied && !replace) throw new Error('目标 SQLite 已有记录；先导出备份，确认后再加 --replace');
  store.import(raw);
  const imported = store.read();
  const total = (['tasks', 'works', 'fixes', 'logs', 'requirements', 'codes', 'knowledge', 'knowledgeBases', 'knowledgeFolders'] as const)
    .reduce((sum, module) => sum + imported[module].length, 0);
  console.log(`已迁移 ${total} 条记录 → ${defaultWorkbenchDbPath()}`);
} finally {
  store.close();
}
