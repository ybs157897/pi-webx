import { createHash, randomUUID } from 'node:crypto';
import { WorkbenchInputError, type WorkbenchStore } from '../../workbench/store';
import { getRequirementVersion } from './lifecycle';
import { normalizeRequirementDraftForIdempotency, saveRequirementDraft } from './import-tasks';

type ReceiptRow = {
  receiptId: string;
  sessionId: string;
  entryKey: string | null;
  paramsHash: string;
  requirementId: string;
  resultJson: string;
};

type SavedRequirementDraft = {
  record: Record<string, unknown>;
  requirementId: string;
  requirementVersion?: number;
  alreadySaved: boolean;
};

const ENTRY_KEY_RE = /^[\w.:-]{1,80}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ensureReceiptTables(store: WorkbenchStore): void {
  store.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS requirements_draft_save_receipts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      entry_key TEXT,
      params_hash TEXT NOT NULL,
      requirement_id TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      created_at TEXT NOT NULL,
      UNIQUE(session_id, entry_key)
    );
    CREATE TABLE IF NOT EXISTS requirements_draft_save_calls (
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      receipt_id TEXT NOT NULL REFERENCES requirements_draft_save_receipts(id) ON DELETE CASCADE,
      PRIMARY KEY(session_id, tool_call_id)
    );
    CREATE INDEX IF NOT EXISTS requirements_draft_save_calls_receipt
      ON requirements_draft_save_calls(receipt_id);
  `);
}

function receiptForCall(store: WorkbenchStore, sessionId: string, toolCallId: string): ReceiptRow | undefined {
  return store.sqlite.prepare(`
    SELECT r.id AS receiptId, r.session_id AS sessionId, r.entry_key AS entryKey,
      r.params_hash AS paramsHash, r.requirement_id AS requirementId, r.result_json AS resultJson
    FROM requirements_draft_save_calls c
    JOIN requirements_draft_save_receipts r ON r.id=c.receipt_id
    WHERE c.session_id=? AND c.tool_call_id=?
  `).get(sessionId, toolCallId) as ReceiptRow | undefined;
}

function receiptForEntryKey(store: WorkbenchStore, sessionId: string, entryKey: string): ReceiptRow | undefined {
  return store.sqlite.prepare(`
    SELECT id AS receiptId, session_id AS sessionId, entry_key AS entryKey,
      params_hash AS paramsHash, requirement_id AS requirementId, result_json AS resultJson
    FROM requirements_draft_save_receipts WHERE session_id=? AND entry_key=?
  `).get(sessionId, entryKey) as ReceiptRow | undefined;
}

function conflict(message: string): never {
  throw new WorkbenchInputError(message, 409);
}

function priorResult(
  store: WorkbenchStore,
  sessionId: string,
  toolCallId: string,
  entryKey: string | undefined,
  paramsHash: string,
  byCall: ReceiptRow | undefined,
  byEntryKey: ReceiptRow | undefined,
): SavedRequirementDraft | null {
  if (byCall && byEntryKey && byCall.receiptId !== byEntryKey.receiptId) {
    return conflict('toolCallId 与 entryKey 分别绑定了不同的需求保存结果');
  }
  const receipt = byCall ?? byEntryKey;
  if (!receipt) return null;
  if (receipt.paramsHash !== paramsHash || receipt.entryKey !== (entryKey ?? null)) {
    return conflict('保存键已用于不同的需求参数；请恢复原参数，或为新需求使用新的 entryKey');
  }

  const record = store.listRecords('requirements').find(item => item.id === receipt.requirementId);
  if (!record) return conflict('该保存回执对应的需求已删除，未重新创建；如需新需求请使用新的 entryKey');
  if (record.sourceSessionId !== sessionId) return conflict('该保存回执不属于当前需求会话');

  if (!byCall) {
    store.sqlite.prepare(`INSERT INTO requirements_draft_save_calls (session_id,tool_call_id,receipt_id)
      VALUES (?,?,?)`).run(sessionId, toolCallId, receipt.receiptId);
  }
  const saved = JSON.parse(receipt.resultJson) as Omit<SavedRequirementDraft, 'alreadySaved'>;
  return { ...saved, alreadySaved: true };
}

/** Save once per session/tool call, with an optional stable key for model retries. */
export function saveRequirementDraftIdempotently(
  store: WorkbenchStore,
  sessionId: string,
  toolCallId: string,
  raw: unknown,
): SavedRequirementDraft {
  if (!sessionId) throw new WorkbenchInputError('需求会话身份缺失');
  if (typeof toolCallId !== 'string' || toolCallId.trim() === '' || toolCallId.length > 500) {
    throw new WorkbenchInputError('需求保存需要有效的 toolCallId');
  }
  if (!object(raw)) throw new WorkbenchInputError('需求草稿需要是对象');

  const { entryKey: rawEntryKey, ...businessInput } = raw;
  if (rawEntryKey !== undefined && (typeof rawEntryKey !== 'string' || !ENTRY_KEY_RE.test(rawEntryKey))) {
    throw new WorkbenchInputError('entryKey 需为 1 至 80 位字母、数字、下划线、点、冒号或连字符');
  }
  const entryKey = rawEntryKey as string | undefined;
  const normalized = normalizeRequirementDraftForIdempotency(sessionId, businessInput);
  const paramsHash = createHash('sha256').update(JSON.stringify(normalized.fingerprint)).digest('hex');

  return store.sqlite.transaction(() => {
    ensureReceiptTables(store);

    const byCall = receiptForCall(store, sessionId, toolCallId);
    const byEntryKey = entryKey === undefined ? undefined : receiptForEntryKey(store, sessionId, entryKey);
    const previous = priorResult(store, sessionId, toolCallId, entryKey, paramsHash, byCall, byEntryKey);
    if (previous) return previous;

    // Keep the write and both idempotency aliases in one transaction. If either
    // receipt insert fails, the requirement record and lifecycle version roll back.
    const record = saveRequirementDraft(store, sessionId, normalized.params);
    const requirementVersion = getRequirementVersion(store, record.id);
    const data: SavedRequirementDraft = {
      record: { ...record, requirementVersion },
      requirementId: record.id,
      requirementVersion,
      alreadySaved: false,
    };
    const receiptId = randomUUID();
    store.sqlite.prepare(`INSERT INTO requirements_draft_save_receipts
      (id,session_id,entry_key,params_hash,requirement_id,result_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(receiptId, sessionId, entryKey ?? null, paramsHash,
        record.id, JSON.stringify({ record: data.record, requirementId: data.requirementId,
          requirementVersion: data.requirementVersion }), new Date().toISOString());
    store.sqlite.prepare(`INSERT INTO requirements_draft_save_calls (session_id,tool_call_id,receipt_id)
      VALUES (?,?,?)`).run(sessionId, toolCallId, receiptId);
    return data;
  }).immediate();
}
