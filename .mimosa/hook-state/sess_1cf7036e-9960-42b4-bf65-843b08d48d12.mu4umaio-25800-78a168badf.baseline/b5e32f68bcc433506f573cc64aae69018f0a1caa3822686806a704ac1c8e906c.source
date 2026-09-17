import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { VERSION } from '@earendil-works/pi-coding-agent';
import type { ServerConfigResponse } from '../src/shared/protocol';

/** Cap on quick-pick directories returned to the client. */
const MAX_SUGGESTED_CWDS = 8;

/**
 * Version of the embedded pi SDK — the agent runs in-process, so the version is
 * the dependency's, not whatever CLI happens to be on PATH.
 */
export function resolvePiVersion(): string | null {
  return VERSION;
}

/**
 * Build the `/api/config` payload. `suggestedCwds` is the home directory, the
 * server's own working directory, then directories harvested from recent
 * stored sessions (newest first, existing directories only, deduplicated).
 */
export function buildServerConfig(storedCwds: string[]): ServerConfigResponse {
  const cwd = process.cwd();
  const home = homedir();

  const suggested: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [home, cwd, ...storedCwds]) {
    const resolved = candidate.trim();
    if (resolved.length === 0 || seen.has(resolved)) continue;
    seen.add(resolved);
    if (!isDirectory(resolved)) continue;
    suggested.push(resolved);
    if (suggested.length >= MAX_SUGGESTED_CWDS) break;
  }

  return {
    cwd,
    home,
    defaultCwd: cwd,
    piVersion: resolvePiVersion(),
    suggestedCwds: suggested,
  };
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
