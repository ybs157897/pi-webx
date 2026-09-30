import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { StoredSession } from '../../src/shared/protocol';
import type { WorkbenchStore } from '../workbench/store';
import type { AgentId } from './contracts';
import type { HostedSession } from '../pi/host';

/** Exact restoration is independent of the paginated recent-conversation list. */
export class ModuleSessionIndex {
  constructor(private readonly store: WorkbenchStore, private readonly workspaceKey: string) {
    store.sqlite.exec(`CREATE TABLE IF NOT EXISTS module_agent_session_index (
      workspace_key TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      session_path TEXT NOT NULL, cwd TEXT NOT NULL,
      PRIMARY KEY (workspace_key, session_id)
    )`);
  }

  remember(agentId: AgentId, hosted: HostedSession): HostedSession {
    const sessionPath = hosted.session.sessionManager.getSessionFile();
    if (sessionPath) this.store.sqlite.prepare(`INSERT INTO module_agent_session_index
      (workspace_key, session_id, agent_id, session_path, cwd) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_key, session_id) DO UPDATE SET
      agent_id=excluded.agent_id, session_path=excluded.session_path, cwd=excluded.cwd`)
      .run(this.workspaceKey, hosted.id, agentId, sessionPath, hosted.cwd);
    return hosted;
  }

  get(sessionId: string): { agentId: AgentId; path: string; cwd: string } | undefined {
    const row = this.store.sqlite.prepare(`SELECT agent_id, session_path, cwd FROM module_agent_session_index
      WHERE workspace_key=? AND session_id=?`).get(this.workspaceKey, sessionId) as
      { agent_id: AgentId; session_path: string; cwd: string } | undefined;
    return row ? { agentId: row.agent_id, path: row.session_path, cwd: row.cwd } : undefined;
  }
}

/** Legacy logs are discovered by header identity, with no recency cutoff or body scan. */
export async function findModuleSession(sessionId: string, root = path.join(getAgentDir(), 'sessions')): Promise<StoredSession | undefined> {
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { directories.push(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      let handle;
      try {
        handle = await open(file, 'r');
        const buffer = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const newline = buffer.subarray(0, bytesRead).indexOf(10);
        if (newline < 0) continue;
        const header = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        if (header?.type !== 'session' || header.id !== sessionId || typeof header.cwd !== 'string') continue;
        const info = await stat(file);
        return { id: sessionId, path: file, cwd: header.cwd, startedAt: header.timestamp ?? '',
          updatedAt: info.mtimeMs, sizeBytes: info.size, preview: null };
      } catch { /* A malformed sibling log cannot hide an otherwise valid session. */ }
      finally { await handle?.close(); }
    }
  }
  return undefined;
}
