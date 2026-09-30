import type Database from 'better-sqlite3';
import { AGENT_IDS, type AgentId } from '../../module-agents/contracts';
import { WorkbenchInputError } from '../../workbench/store';
import { CHATROOM_MEMBER_NAMES, type ChatroomConsumption, type ConsumptionStatus } from './contracts';

type Row = {
  agent_id: AgentId; status: ConsumptionStatus; started_at: string | null;
  finished_at: string | null; error: string | null;
};

const allowed: Record<ConsumptionStatus, readonly ConsumptionStatus[]> = {
  pending: ['evaluating', 'processing', 'failed'],
  evaluating: ['processing', 'skipped', 'failed'],
  processing: ['consumed', 'failed'],
  consumed: [], skipped: [], failed: [],
};

/** Separate member acknowledgements preserve partial results without replaying side effects. */
export class ChatroomConsumptionStore {
  constructor(private readonly sqlite: Database.Database, private readonly workspaceKey: string) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS chatroom_consumptions (
      workspace_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','evaluating','processing','consumed','skipped','failed')),
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      PRIMARY KEY(workspace_key, message_id, agent_id)
    )`);
  }

  list(messageId: string): ChatroomConsumption[] {
    const rows = this.sqlite.prepare(`SELECT agent_id, status, started_at, finished_at, error
      FROM chatroom_consumptions WHERE workspace_key = ? AND message_id = ? ORDER BY ordinal`)
      .all(this.workspaceKey, messageId) as Row[];
    return rows.map(row => ({
      agentId: row.agent_id, agentName: CHATROOM_MEMBER_NAMES[row.agent_id] ?? row.agent_id,
      status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, error: row.error,
    }));
  }

  prepare(messageId: string, agents: readonly AgentId[]): ChatroomConsumption[] {
    return this.sqlite.transaction(() => {
      const message = this.running(messageId);
      const existing = this.list(messageId);
      if (existing.length) return existing;
      const unique = [...new Set(agents)];
      if (!unique.length || unique.some(id => !(AGENT_IDS as readonly string[]).includes(id))
        || (message.recipient_id !== null && (unique.length !== 1 || unique[0] !== message.recipient_id))
        || (message.recipient_id === null && unique.includes(message.sender_id as AgentId))) {
        throw new WorkbenchInputError('消费成员不合法');
      }
      const insert = this.sqlite.prepare(`INSERT INTO chatroom_consumptions
        (workspace_key, message_id, agent_id, ordinal, status) VALUES (?, ?, ?, ?, 'pending')`);
      unique.forEach((id, index) => insert.run(this.workspaceKey, messageId, id, index));
      return this.list(messageId);
    }).immediate();
  }

  update(messageId: string, agentId: AgentId, status: Exclude<ConsumptionStatus, 'pending'>, error?: string): void {
    this.sqlite.transaction(() => {
      this.running(messageId);
      const current = this.list(messageId).find(item => item.agentId === agentId);
      if (!current) throw new WorkbenchInputError('成员未订阅这条消息', 409);
      if (current.status === status) return;
      if (!allowed[current.status].includes(status)) throw new WorkbenchInputError('消费状态转换不合法', 409);
      if (status === 'consumed' && !this.sqlite.prepare(`SELECT 1 FROM chatroom_messages
        WHERE workspace_key = ? AND reply_to = ? AND sender_id = ? LIMIT 1`)
        .get(this.workspaceKey, messageId, agentId)) {
        throw new WorkbenchInputError('成员尚未产生公开回复，不能确认消费成功', 409);
      }
      const terminal = status === 'consumed' || status === 'skipped' || status === 'failed';
      const now = new Date().toISOString();
      this.sqlite.prepare(`UPDATE chatroom_consumptions SET status = ?,
        started_at = COALESCE(started_at, ?), finished_at = ?, error = ?
        WHERE workspace_key = ? AND message_id = ? AND agent_id = ? AND status = ?`)
        .run(status, status === 'failed' ? null : now, terminal ? now : null,
          status === 'failed' ? (error ?? '成员消费失败').slice(0, 500) : null,
          this.workspaceKey, messageId, agentId, current.status);
    }).immediate();
  }

  failOutstanding(messageId: string, error: string): number {
    return this.sqlite.prepare(`UPDATE chatroom_consumptions SET status = 'failed', finished_at = ?, error = ?
      WHERE workspace_key = ? AND message_id = ? AND status IN ('pending','evaluating','processing')`)
      .run(new Date().toISOString(), error.slice(0, 500), this.workspaceKey, messageId).changes;
  }

  finalizedDelivery(messageId: string): { status: 'delivered' | 'failed'; error: string | null } | undefined {
    const receipts = this.list(messageId);
    if (!receipts.length || receipts.some(item => ['pending', 'evaluating', 'processing'].includes(item.status))) return;
    const failures = receipts.filter(item => item.status === 'failed');
    const summary = failures.length ? `部分成员消费失败：${failures.map(item => `${item.agentName}：${item.error}`).join('；')}`.slice(0, 500) : null;
    return receipts.some(item => item.status === 'consumed')
      ? { status: 'delivered', error: summary }
      : { status: 'failed', error: summary ?? '没有成员完成这条消息的消费' };
  }

  private running(messageId: string): { recipient_id: AgentId | null; sender_id: string } {
    const row = this.sqlite.prepare(`SELECT recipient_id, sender_id FROM chatroom_messages
      WHERE workspace_key = ? AND id = ? AND delivery_status = 'running'`)
      .get(this.workspaceKey, messageId) as { recipient_id: AgentId | null; sender_id: string } | undefined;
    if (!row) throw new WorkbenchInputError('群消息不在可消费状态', 409);
    return row;
  }
}
