/** Provision pinned rg/fd binaries during Windows npm install; no extra runtime. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const TEAM_WINDOWS_BIN_DIR = join(root, 'node_modules', '.cache', 'pi-webx-team-tools');

const assets = [
  {
    name: 'rg.exe',
    licenses: ['COPYING', 'LICENSE-MIT', 'UNLICENSE'],
    url: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip',
    sha256: 'd0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1',
    exeSha256: 'f162b54de2adfc72d78adb1dbada2dedda111ae0a5e2f6e9500f4f909664c5d2',
  },
  {
    name: 'fd.exe',
    licenses: ['LICENSE-APACHE', 'LICENSE-MIT'],
    url: 'https://github.com/sharkdp/fd/releases/download/v10.3.0/fd-v10.3.0-x86_64-pc-windows-msvc.zip',
    sha256: '318aa2a6fa664325933e81fda60d523fff29444129e91ebf0726b5b3bcd8b059',
    exeSha256: 'fd3d4853da7a319a604e1cb03ede88cbf584edd12b89a0991871fb4d9cd3ba5b',
  },
];

function findFile(directory, name, depth = 0) {
  if (depth > 5) return undefined;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return path;
    if (entry.isDirectory()) {
      const nested = findFile(path, name, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

function ready() {
  const manifestPath = join(TEAM_WINDOWS_BIN_DIR, 'manifest.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return assets.every((asset) => {
      const binary = join(TEAM_WINDOWS_BIN_DIR, asset.name);
      return manifest[asset.name] === asset.sha256 && existsSync(binary)
        && createHash('sha256').update(readFileSync(binary)).digest('hex') === asset.exeSha256
        && asset.licenses.every((name) => existsSync(join(TEAM_WINDOWS_BIN_DIR, `${asset.name}-${name}`)));
    });
  } catch { return false; }
}

async function provision() {
  if (process.platform !== 'win32') return;
  if (process.arch !== 'x64') throw new Error('Agent Team Windows 工具当前仅支持 x64。');
  if (ready()) return;
  const scratch = mkdtempSync(join(tmpdir(), 'pi-webx-team-setup-'));
  mkdirSync(TEAM_WINDOWS_BIN_DIR, { recursive: true });
  try {
    for (const asset of assets) {
      const response = await fetch(asset.url);
      if (!response.ok) throw new Error(`${asset.name} 下载失败：HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== asset.sha256) throw new Error(`${asset.name} SHA-256 校验失败`);
      const archive = join(scratch, `${asset.name}.zip`);
      const extracted = join(scratch, `${asset.name}-extract`);
      mkdirSync(extracted);
      writeFileSync(archive, bytes);
      const unpack = spawnSync('tar.exe', ['-xf', archive, '-C', extracted], { windowsHide: true, encoding: 'utf8' });
      if (unpack.status !== 0) throw new Error(`${asset.name} 解压失败：${unpack.stderr || unpack.error?.message || unpack.status}`);
      const binary = findFile(extracted, asset.name);
      if (!binary) throw new Error(`${asset.name} 压缩包中没有目标程序`);
      if (createHash('sha256').update(readFileSync(binary)).digest('hex') !== asset.exeSha256) {
        throw new Error(`${asset.name} 程序 SHA-256 校验失败`);
      }
      copyFileSync(binary, join(TEAM_WINDOWS_BIN_DIR, asset.name));
      for (const name of asset.licenses) {
        const license = findFile(extracted, name);
        if (!license) throw new Error(`${asset.name} 压缩包中没有 ${name}`);
        copyFileSync(license, join(TEAM_WINDOWS_BIN_DIR, `${asset.name}-${name}`));
      }
    }
    writeFileSync(join(TEAM_WINDOWS_BIN_DIR, 'manifest.json'), JSON.stringify(
      Object.fromEntries(assets.map((asset) => [asset.name, asset.sha256])),
    ));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  provision().catch((cause) => {
    console.error(`Agent Team Windows 工具准备失败：${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  });
}

export { provision as provisionWindowsTeamTools };
