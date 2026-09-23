import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { WorkbenchStore, defaultWorkbenchDbPath } from '../server/workbench/store';

const sourcePath = process.argv[2];
const replace = process.argv.includes('--replace');
if (!sourcePath || !sourcePath.endsWith('.json')) {
  console.error('用法：npm run import:workbench-json -- /绝对路径/data/workbench.json [--replace]');
  process.exit(2);
}

const source = resolve(sourcePath);
const uploadsDir = resolve(dirname(source), 'uploads');
const mimeByExt: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};
let converted = 0;

function imageUrl(url: unknown): unknown {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return url;
  const name = decodeURIComponent(url.slice('/uploads/'.length));
  const target = resolve(uploadsDir, name);
  if (!target.startsWith(uploadsDir + sep)) throw new Error('图片路径不在 uploads 目录内');
  const mime = mimeByExt[extname(target).toLowerCase()];
  if (!mime || !existsSync(target) || !statSync(target).isFile()) throw new Error('旧版图片缺失或类型不支持');
  const bytes = readFileSync(target);
  if (bytes.length > 5 * 1024 * 1024) throw new Error('旧版图片超过 5MB 上限');
  converted += 1;
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

const raw = JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>;
const state = structuredClone(raw);
for (const module of ['pets', 'relationships'] as const) {
  const atom = state[module] as { profile?: { avatarUrl?: string }; records?: Array<{ photoUrl?: string }> } | undefined;
  if (!atom) continue;
  if (atom.profile) atom.profile.avatarUrl = imageUrl(atom.profile.avatarUrl) as string | undefined;
  for (const record of atom.records ?? []) record.photoUrl = imageUrl(record.photoUrl) as string | undefined;
}

const store = new WorkbenchStore();
try {
  const current = store.read();
  const occupied = ['tasks', 'works', 'hotspots', 'exercises', 'meals', 'finance', 'reviews']
    .some((module) => (current[module as keyof typeof current] as unknown[]).length > 0)
    || current.pets.records.length > 0 || current.relationships.records.length > 0;
  if (occupied && !replace) throw new Error('目标 SQLite 已有记录；先导出备份，确认后再加 --replace');
  store.import(state);
  const imported = store.read();
  const total = imported.tasks.length + imported.works.length + imported.hotspots.length
    + imported.exercises.length + imported.meals.length + imported.finance.length
    + imported.reviews.length + imported.pets.records.length + imported.relationships.records.length;
  console.log(`已迁移 ${total} 条记录、${converted} 张图片 → ${defaultWorkbenchDbPath()}`);
} finally {
  store.close();
}
