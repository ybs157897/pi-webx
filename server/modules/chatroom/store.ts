import type Database from 'better-sqlite3';
import type { WorkbenchStore } from '../../workbench/store';
import type { AgentId } from '../../module-agents/contracts';
import type { ChatroomConsumption, ChatroomContext, ChatroomMessage, ChatroomPublicMessage, ChatroomSenderId, DeliveryStatus } from './contracts';
import { ChatroomConsumptionStore } from './consumption-store';
import { traceMessageCreated, traceMessageSettled } from './trace-links';

type Row = {
  seq: number; id: string; workspace_key: string; thread_id: string; reply_to: string | null;
  sender_id: ChatroomSenderId; sender_name: string; recipient_id: AgentId | null;
  sender_session_id: string; entry_key: string; request_hash: string; body: string;
  created_at: string; delivery_status: DeliveryStatus; error: string | null;
  depth: number; context: string; claimants: string | null;
  input_requirement_id: string | null; input_requirement_version: number | null;
};

function decodeClaimants(raw: string | null): AgentId[] {
  const parsed = raw ? JSON.parse(raw) : [];
  return Array.isArray(parsed) ? parsed.filter((id): id is AgentId => typeof id === 'string') : [];
}

function decode(row: Row, consumptions: ChatroomConsumption[]): ChatroomMessage {
  return {
    id: row.id, seq: row.seq, threadId: row.thread_id, replyTo: row.reply_to,
    senderId: row.sender_id, senderName: row.sender_name, recipientId: row.recipient_id,
    senderSessionId: row.sender_session_id, entryKey: row.entry_key, requestHash: row.request_hash,
    body: row.body, createdAt: row.created_at, deliveryStatus: row.delivery_status,
    error: row.error, depth: row.depth, context: JSON.parse(row.context) as ChatroomContext,
    inputRequirementId: row.input_requirement_id,
    inputRequirementVersion: row.input_requirement_version,
    claimants: decodeClaimants(row.claimants),
    consumptions,
  };
}

export function publicMessage(message: ChatroomMessage): ChatroomPublicMessage {
  const { id, seq, threadId, replyTo, senderId, senderName, recipientId, body, createdAt, deliveryStatus, error, consumptions } = message;
  return { id, seq, threadId, collaborationTaskId: message.context.collaborationTaskId ?? null,
    replyTo, senderId, senderName, recipientId, body, createdAt, deliveryStatus, error, consumptions };
}

/** Dedicated message table: workbench_records import/export cannot rewrite delivery history. */
export class ChatroomStore {
  readonly sqlite: Database.Database;
  readonly consumptions: ChatroomConsumptionStore;

  constructor(private readonly store: WorkbenchStore, readonly workspaceKey: string) {
    this.sqlite = store.sqlite;
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS chatroom_user_sessions (
        workspace_key TEXT NOT NULL,
        session_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_key, session_key)
      );
      CREATE TABLE IF NOT EXISTS chatroom_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        workspace_key TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        reply_to TEXT,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        recipient_id TEXT,
        sender_session_id TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivery_status TEXT NOT NULL CHECK(delivery_status IN ('none','pending','running','delivered','failed')),
        error TEXT,
        depth INTEGER NOT NULL,
        context TEXT NOT NULL CHECK(json_valid(context)),
        input_requirement_id TEXT,
        input_requirement_version INTEGER,
        UNIQUE(workspace_key, sender_session_id, entry_key)
      );
      CREATE INDEX IF NOT EXISTS chatroom_messages_feed ON chatroom_messages(workspace_key, seq);
      CREATE INDEX IF NOT EXISTS chatroom_messages_queue ON chatroom_messages(workspace_key, delivery_status, seq);
      CREATE INDEX IF NOT EXISTS chatroom_messages_thread ON chatroom_messages(workspace_key, thread_id);
    `);
    // Databases created before broadcast self-claiming lack the claimants column.
    if (!(this.sqlite.pragma('table_info(chatroom_messages)') as Array<{ name: string }>)
      .some(column => column.name === 'claimants')) {
      this.sqlite.exec(`ALTER TABLE chatroom_messages ADD COLUMN claimants TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!(this.sqlite.pragma('table_info(chatroom_messages)') as Array<{ name: string }>)
      .some(column => column.name === 'input_requirement_version')) {
      this.sqlite.exec('ALTER TABLE chatroom_messages ADD COLUMN input_requirement_version INTEGER');
    }
    if (!(this.sqlite.pragma('table_info(chatroom_messages)') as Array<{ name: string }>)
      .some(column => column.name === 'input_requirement_id')) {
      this.sqlite.exec('ALTER TABLE chatroom_messages ADD COLUMN input_requirement_id TEXT');
    }
    this.consumptions = new ChatroomConsumptionStore(this.sqlite, workspaceKey);
    this.transaction(() => {
      const error = '服务重启中断了投递；请检查目标会话后人工重新发送';
      const running = this.sqlite.prepare(`SELECT id FROM chatroom_messages
        WHERE workspace_key = ? AND delivery_status = 'running'`).all(workspaceKey) as Array<{ id: string }>;
      for (const message of running) {
        const finalized = this.consumptions.finalizedDelivery(message.id);
        if (finalized) this.settle(message.id, finalized.status, finalized.error);
        else {
          this.consumptions.failOutstanding(message.id, error);
          this.settle(message.id, 'failed', error);
        }
      }
    });
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn).immediate();
  }

  byEntry(sessionId: string, entryKey: string): ChatroomMessage | undefined {
    const row = this.sqlite.prepare(`SELECT * FROM chatroom_messages
      WHERE workspace_key = ? AND sender_session_id = ? AND entry_key = ?`)
      .get(this.workspaceKey, sessionId, entryKey) as Row | undefined;
    return row ? this.decode(row) : undefined;
  }

  byId(id: string): ChatroomMessage | undefined {
    const row = this.sqlite.prepare('SELECT * FROM chatroom_messages WHERE workspace_key = ? AND id = ?')
      .get(this.workspaceKey, id) as Row | undefined;
    return row ? this.decode(row) : undefined;
  }

  countThread(threadId: string): number {
    return (this.sqlite.prepare('SELECT COUNT(*) AS n FROM chatroom_messages WHERE workspace_key = ? AND thread_id = ?')
      .get(this.workspaceKey, threadId) as { n: number }).n;
  }

  /** A user's new entry reopens a topic without reopening an unlimited agent loop. */
  countSinceUserAnchor(threadId: string): number {
    const row = this.sqlite.prepare(`SELECT COUNT(*) AS n FROM chatroom_messages
      WHERE workspace_key = ? AND thread_id = ? AND seq >= COALESCE((
        SELECT MAX(seq) FROM chatroom_messages
        WHERE workspace_key = ? AND thread_id = ? AND sender_id = 'user'
      ), 0)`).get(this.workspaceKey, threadId, this.workspaceKey, threadId) as { n: number };
    return row.n;
  }

  hasUserSession(sessionKey: string): boolean {
    return this.sqlite.prepare(`SELECT 1 FROM chatroom_user_sessions
      WHERE workspace_key = ? AND session_key = ?`)
      .get(this.workspaceKey, sessionKey) !== undefined;
  }

  createUserSession(sessionKey: string): void {
    this.sqlite.prepare(`INSERT INTO chatroom_user_sessions(workspace_key, session_key, created_at)
      VALUES (?, ?, ?)`).run(this.workspaceKey, sessionKey, new Date().toISOString());
  }

  hasReply(messageId: string, senderId: AgentId): boolean {
    return this.sqlite.prepare(`SELECT 1 FROM chatroom_messages
      WHERE workspace_key = ? AND reply_to = ? AND sender_id = ? LIMIT 1`)
      .get(this.workspaceKey, messageId, senderId) !== undefined;
  }

  insert(message: Omit<ChatroomMessage, 'seq' | 'consumptions'>): ChatroomMessage {
    return this.transaction(() => {
      const result = this.sqlite.prepare(`INSERT INTO chatroom_messages (
      id, workspace_key, thread_id, reply_to, sender_id, sender_name, recipient_id,
      sender_session_id, entry_key, request_hash, body, created_at, delivery_status,
      error, depth, context, claimants, input_requirement_id, input_requirement_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      message.id, this.workspaceKey, message.threadId, message.replyTo, message.senderId,
      message.senderName, message.recipientId, message.senderSessionId, message.entryKey,
      message.requestHash, message.body, message.createdAt, message.deliveryStatus,
      message.error, message.depth, JSON.stringify(message.context),
      JSON.stringify(message.claimants ?? []), message.context.requirementId ?? null,
      message.context.requirementVersion ?? null,
    );
      const saved = { ...message, seq: Number(result.lastInsertRowid), consumptions: [],
        inputRequirementId: message.context.requirementId ?? null,
        inputRequirementVersion: message.context.requirementVersion ?? null };
      traceMessageCreated(this.store, this.workspaceKey, saved);
      return saved;
    });
  }

  setClaimants(id: string, claimants: readonly AgentId[]): void {
    this.sqlite.prepare('UPDATE chatroom_messages SET claimants = ? WHERE workspace_key = ? AND id = ?')
      .run(JSON.stringify(claimants), this.workspaceKey, id);
  }

  nextPending(): ChatroomMessage | undefined {
    const row = this.sqlite.prepare(`SELECT * FROM chatroom_messages
      WHERE workspace_key = ? AND delivery_status = 'pending' ORDER BY seq LIMIT 1`)
      .get(this.workspaceKey) as Row | undefined;
    return row ? this.decode(row) : undefined;
  }

  pendingAfter(afterSeq: number, limit: number): ChatroomMessage[] {
    return (this.sqlite.prepare(`SELECT * FROM chatroom_messages
      WHERE workspace_key = ? AND delivery_status = 'pending' AND seq > ? ORDER BY seq LIMIT ?`)
      .all(this.workspaceKey, afterSeq, limit) as Row[]).map(row => this.decode(row));
  }

  claim(id: string): ChatroomMessage | undefined {
    const changed = this.sqlite.prepare(`UPDATE chatroom_messages SET delivery_status = 'running'
      WHERE workspace_key = ? AND id = ? AND delivery_status = 'pending'`).run(this.workspaceKey, id);
    return changed.changes ? this.byId(id) : undefined;
  }

  settle(id: string, status: 'delivered' | 'failed', error: string | null): void {
    this.transaction(() => {
      const changed = this.sqlite.prepare(`UPDATE chatroom_messages SET delivery_status = ?, error = ?
      WHERE workspace_key = ? AND id = ? AND delivery_status = 'running'`)
        .run(status, error, this.workspaceKey, id);
      if (changed.changes) {
        const message = this.byId(id);
        if (message) traceMessageSettled(this.store, this.workspaceKey, message, status);
      }
    });
  }

  updateContext(id: string, context: ChatroomContext): void {
    this.sqlite.prepare('UPDATE chatroom_messages SET context = ? WHERE workspace_key = ? AND id = ?')
      .run(JSON.stringify(context), this.workspaceKey, id);
  }

  list(after: number, limit: number): ChatroomMessage[] {
    return (this.sqlite.prepare(`SELECT * FROM chatroom_messages
      WHERE workspace_key = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(this.workspaceKey, after, limit) as Row[]).map(row => this.decode(row));
  }

  history(threadId: string, limit: number): ChatroomMessage[] {
    const rows = this.sqlite.prepare(`SELECT * FROM chatroom_messages
      WHERE workspace_key = ? AND thread_id = ? ORDER BY seq DESC LIMIT ?`)
      .all(this.workspaceKey, threadId, limit) as Row[];
    return rows.reverse().map(row => this.decode(row));
  }

  historySince(threadId: string, afterSeq: number, beforeSeq: number, limit: number): ChatroomMessage[] {
    const rows = this.sqlite.prepare(`SELECT * FROM chatroom_messages
      WHERE workspace_key = ? AND thread_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`)
      .all(this.workspaceKey, threadId, afterSeq, beforeSeq, limit) as Row[];
    return rows.map(row => this.decode(row));
  }

  hasThread(threadId: string): boolean {
    return this.sqlite.prepare(`SELECT 1 FROM chatroom_messages WHERE workspace_key = ? AND thread_id = ? LIMIT 1`)
      .get(this.workspaceKey, threadId) !== undefined;
  }

  watch(ids: readonly string[]): ChatroomMessage[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return (this.sqlite.prepare(`SELECT * FROM chatroom_messages
      WHERE workspace_key = ? AND id IN (${placeholders}) ORDER BY seq`)
      .all(this.workspaceKey, ...ids) as Row[]).map(row => this.decode(row));
  }

  watchSeq(seqs: readonly number[]): ChatroomMessage[] {
    if (seqs.length === 0) return [];
    const placeholders = seqs.map(() => '?').join(',');
    return (this.sqlite.prepare(`SELECT * FROM chatroom_messages
      WHERE workspace_key = ? AND seq IN (${placeholders}) ORDER BY seq`)
      .all(this.workspaceKey, ...seqs) as Row[]).map(row => this.decode(row));
  }

  private decode(row: Row): ChatroomMessage {
    return decode(row, this.consumptions.list(row.id));
  }
}
