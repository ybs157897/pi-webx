import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.PI_WEBX_WEB_IDEA_DIR ?? path.resolve(projectRoot, '../web-idea');
const web = path.join(repo, 'apps/web');
const gateway = path.join(repo, 'apps/gateway');
const binary = path.join(repo, '.local/bin/web-idea-gateway');

await access(path.join(web, 'package.json'));
await access(path.join(gateway, 'go.mod'));
await mkdir(path.dirname(binary), { recursive: true });

await run('pnpm', ['install', '--frozen-lockfile'], web);
await run('pnpm', ['exec', 'tsc', '-b'], web);
await run('pnpm', ['exec', 'vite', 'build', '--base=/api/codes/ide/'], web);
await run('go', ['build', '-o', binary, '.'], gateway);
await access(path.join(web, 'dist/index.html'));
await access(binary);
console.log(`[pi-webx] web-idea 已构建：${repo}`);

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed: ${signal ?? code}`));
    });
  });
}
