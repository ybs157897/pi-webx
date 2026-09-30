import type Database from 'better-sqlite3';
import type { AgentId } from '../../module-agents/contracts';
import type { ChatroomRunStatus, ChatroomTaskStatus } from './contracts';

export interface TaskRow {
  id: string; thread_id: string; title: string; status: ChatroomTaskStatus;
  version: number; source_context: string; created_message_id: string;
  created_at: string; updated_at: string;
}
export interface AssignmentRow {
  id: string; task_id: string; agent_id: AgentId; session_id: string | null;
  status: ChatroomTaskStatus; summary: string | null; last_processed_seq: number;
  profile_revision: string | null; created_at: string; updated_at: string;
}
export interface DiscussionRow {
  thread_id: string; agent_id: AgentId; session_id: string | null;
  last_processed_seq: number; profile_revision: string | null;
}
export interface RunRow {
  id: string; task_id: string | null; assignment_id: string | null;
  requirement_id: string | null; requirement_version: number | null;
  thread_id: string; agent_id: AgentId; session_id: string; message_id: string;
  attempt: number; status: ChatroomRunStatus; checkpoint: string | null;
  last_processed_seq: number; error: string | null; started_at: string; finished_at: string | null;
  reviewed_at: string | null;
}

export class ChatroomWorkStore {
  constructor(readonly sqlite: Database.Database, readonly workspaceKey: string) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS chatroom_discussion_bindings (
        workspace_key TEXT NOT NULL, room_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, session_id TEXT, profile_revision TEXT,
        last_processed_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_key, room_id, thread_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS chatroom_work_tasks (
        workspace_key TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
        source_context TEXT NOT NULL CHECK(json_valid(source_context)),
        created_message_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_key, id)
      );
      CREATE INDEX IF NOT EXISTS chatroom_work_tasks_thread
        ON chatroom_work_tasks(workspace_key, thread_id, updated_at);
      CREATE TABLE IF NOT EXISTS chatroom_work_assignments (
        workspace_key TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, session_id TEXT, profile_revision TEXT,
        status TEXT NOT NULL, summary TEXT, last_processed_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_key, id), UNIQUE(workspace_key, task_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS chatroom_work_runs (
        workspace_key TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT, assignment_id TEXT,
        requirement_id TEXT, requirement_version INTEGER,
        thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
        message_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
        checkpoint TEXT, last_processed_seq INTEGER NOT NULL DEFAULT 0,
        error TEXT, started_at TEXT NOT NULL, finished_at TEXT, reviewed_at TEXT,
        PRIMARY KEY(workspace_key, id), UNIQUE(workspace_key, message_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS chatroom_work_runs_active
        ON chatroom_work_runs(workspace_key, status, session_id);
      CREATE TABLE IF NOT EXISTS chatroom_work_run_tools (
        workspace_key TEXT NOT NULL, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, is_error INTEGER,
        result_hash TEXT, result_bytes INTEGER, exit_code INTEGER,
        PRIMARY KEY(workspace_key, run_id, tool_call_id)
      );
      CREATE TABLE IF NOT EXISTS chatroom_work_tool_actions (
        workspace_key TEXT NOT NULL, session_id TEXT NOT NULL, entry_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, action TEXT NOT NULL, task_id TEXT NOT NULL,
        PRIMARY KEY(workspace_key, session_id, entry_key)
      );
      CREATE TABLE IF NOT EXISTS chatroom_work_handoffs (
        workspace_key TEXT NOT NULL, message_id TEXT NOT NULL, parent_run_id TEXT NOT NULL,
        PRIMARY KEY(workspace_key, message_id)
      );
      CREATE TABLE IF NOT EXISTS chatroom_work_user_actions (
        workspace_key TEXT NOT NULL, user_session_key TEXT NOT NULL, entry_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, action TEXT NOT NULL, task_id TEXT NOT NULL, message_id TEXT,
        PRIMARY KEY(workspace_key, user_session_key, entry_key)
      );
    `);
    const columns = sqlite.pragma('table_info(chatroom_work_runs)') as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'requirement_id')) {
      sqlite.exec('ALTER TABLE chatroom_work_runs ADD COLUMN requirement_id TEXT');
    }
    if (!columns.some(column => column.name === 'requirement_version')) {
      sqlite.exec('ALTER TABLE chatroom_work_runs ADD COLUMN requirement_version INTEGER');
    }
    const toolColumns = sqlite.pragma('table_info(chatroom_work_run_tools)') as Array<{ name: string }>;
    if (!toolColumns.some(column => column.name === 'result_hash')) {
      sqlite.exec('ALTER TABLE chatroom_work_run_tools ADD COLUMN result_hash TEXT');
    }
    if (!toolColumns.some(column => column.name === 'result_bytes')) {
      sqlite.exec('ALTER TABLE chatroom_work_run_tools ADD COLUMN result_bytes INTEGER');
    }
    if (!toolColumns.some(column => column.name === 'exit_code')) {
      sqlite.exec('ALTER TABLE chatroom_work_run_tools ADD COLUMN exit_code INTEGER');
    }
  }

  transaction<T>(fn: () => T): T { return this.sqlite.transaction(fn).immediate(); }

  task(id: string): TaskRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM chatroom_work_tasks WHERE workspace_key = ? AND id = ?`)
      .get(this.workspaceKey, id) as TaskRow | undefined;
  }

  tasks(): TaskRow[] {
    return this.sqlite.prepare(`SELECT * FROM chatroom_work_tasks WHERE workspace_key = ? ORDER BY updated_at DESC, id`)
      .all(this.workspaceKey) as TaskRow[];
  }

  hasUnreviewedRun(taskId: string): boolean {
    return this.sqlite.prepare(`SELECT 1 FROM chatroom_work_runs
      WHERE workspace_key = ? AND task_id = ? AND status = 'needs_review'
        AND reviewed_at IS NULL LIMIT 1`).get(this.workspaceKey, taskId) !== undefined;
  }

  assignments(taskId: string): AssignmentRow[] {
    return this.sqlite.prepare(`SELECT * FROM chatroom_work_assignments
      WHERE workspace_key = ? AND task_id = ? ORDER BY created_at, id`)
      .all(this.workspaceKey, taskId) as AssignmentRow[];
  }

  assignment(taskId: string, agentId: AgentId): AssignmentRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM chatroom_work_assignments
      WHERE workspace_key = ? AND task_id = ? AND agent_id = ?`)
      .get(this.workspaceKey, taskId, agentId) as AssignmentRow | undefined;
  }

  discussion(threadId: string, agentId: AgentId): DiscussionRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM chatroom_discussion_bindings
      WHERE workspace_key = ? AND room_id = 'internal' AND thread_id = ? AND agent_id = ?`)
      .get(this.workspaceKey, threadId, agentId) as DiscussionRow | undefined;
  }

  run(id: string): RunRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM chatroom_work_runs WHERE workspace_key = ? AND id = ?`)
      .get(this.workspaceKey, id) as RunRow | undefined;
  }

  runningRun(sessionId: string): RunRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM chatroom_work_runs
      WHERE workspace_key = ? AND session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`)
      .get(this.workspaceKey, sessionId) as RunRow | undefined;
  }

  lastRun(assignmentId: string): RunRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM chatroom_work_runs
      WHERE workspace_key = ? AND assignment_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`)
      .get(this.workspaceKey, assignmentId) as RunRow | undefined;
  }

  boundSession(sessionId: string): boolean {
    return this.sqlite.prepare(`SELECT 1 FROM chatroom_discussion_bindings
      WHERE workspace_key = ? AND session_id = ? LIMIT 1`).get(this.workspaceKey, sessionId) !== undefined
      || this.sqlite.prepare(`SELECT 1 FROM chatroom_work_assignments
        WHERE workspace_key = ? AND session_id = ? LIMIT 1`).get(this.workspaceKey, sessionId) !== undefined;
  }
}
