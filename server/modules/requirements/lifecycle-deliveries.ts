import { createHash, randomUUID } from 'node:crypto';
import { WorkbenchInputError } from '../../workbench/store';
import type { DeliveryEvidence, LifecycleStore, PublicDelivery, RequirementTrace, ReviewInput } from './lifecycle-contracts';
import { lifecycleRoot, recordRequirementEvent } from './lifecycle-events';
import { readRequirementTrace } from './lifecycle-trace';

const KINDS = new Set(['file', 'commit', 'pull_request', 'test', 'report']);
function bad(message: string, status = 400): never { throw new WorkbenchInputError(message, status); }
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) bad(`${label}不合法`);
  return value.trim();
}
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) bad('交付操作包含未知字段');
}
function stamp(prior?: string): string { return new Date(Math.max(Date.now(), Date.parse(prior ?? '') + 1 || 0)).toISOString(); }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function previousOperation(store: LifecycleStore, requirementId: string, actor: string, entryKey: string, hash: string) {
  const row = store.sqlite.prepare(`SELECT * FROM requirement_lifecycle_operations
    WHERE requirement_id=? AND actor_key=? AND entry_key=?`).get(requirementId, actor, entryKey) as
    { request_hash: string; delivery_id: string; operation: string } | undefined;
  if (row && row.request_hash !== hash) bad('entryKey 已用于不同交付操作', 409);
  return row;
}
function result(store: LifecycleStore, requirementId: string, deliveryId: string): { delivery: PublicDelivery; trace: RequirementTrace } {
  const trace = readRequirementTrace(store, requirementId, 'id');
  const delivery = trace.deliveries.find(item => item.id === deliveryId);
  if (!delivery) bad('交付记录不存在', 404);
  return { delivery, trace };
}

export function submitRequirementDelivery(store: LifecycleStore, id: string, raw: unknown, actor = 'user') {
  fields(raw, ['entryKey', 'expectedUpdatedAt', 'expectedRequirementVersion', 'summary', 'evidence', 'runIds']);
  const entryKey = text(raw.entryKey, 'entryKey', 200), summary = text(raw.summary, '交付摘要', 4000);
  const expectedUpdatedAt = text(raw.expectedUpdatedAt, '需求版本时间', 100);
  const expectedRequirementVersion = raw.expectedRequirementVersion;
  if (!Number.isSafeInteger(expectedRequirementVersion) || Number(expectedRequirementVersion) < 1) bad('须指定需求修订版本');
  if (!Array.isArray(raw.evidence) || raw.evidence.length < 1 || raw.evidence.length > 30) bad('须提供 1 至 30 条交付证据');
  const evidence = raw.evidence.map(value => {
    fields(value, ['kind', 'ref', 'label', 'runId', 'toolCallId']);
    if (!KINDS.has(String(value.kind))) bad('未知交付证据类型');
    const clean = { kind: value.kind, ref: text(value.ref, '证据引用', 2000),
      ...(value.label === undefined ? {} : { label: text(value.label, '证据说明', 500) }),
      ...(value.runId === undefined ? {} : { runId: text(value.runId, '执行 ID', 200) }),
      ...(value.toolCallId === undefined ? {} : { toolCallId: text(value.toolCallId, '工具调用 ID', 200) }) };
    if (clean.kind === 'pull_request') {
      let url; try { url = new URL(clean.ref); } catch { bad('PR 引用须为 http/https 链接'); }
      if (!['https:', 'http:'].includes(url!.protocol)) bad('PR 引用须为 http/https 链接');
    }
    if (clean.toolCallId && !clean.runId) bad('工具证据须同时关联执行 ID');
    return clean as Omit<DeliveryEvidence, 'verification'>;
  });
  if (raw.runIds !== undefined && (!Array.isArray(raw.runIds) || raw.runIds.length > 30
    || raw.runIds.some(value => typeof value !== 'string' || !value.trim()))) bad('执行 ID 列表不合法');
  const runIds = [...new Set([...(raw.runIds as string[] | undefined ?? []),
    ...evidence.flatMap(item => item.runId ? [item.runId] : [])])];
  const root = lifecycleRoot(store, id);
  const hash = digest({ expectedUpdatedAt, expectedRequirementVersion, summary, evidence, runIds });
  return store.sqlite.transaction(() => {
    const prior = previousOperation(store, root.requirement_id, actor, entryKey, hash);
    if (prior) return result(store, root.requirement_id, prior.delivery_id);
    const trace = readRequirementTrace(store, root.requirement_id, 'id');
    if (trace.archived) bad('需求已删除，不能提交交付', 409);
    if (trace.requirement.updatedAt !== expectedUpdatedAt || trace.requirementVersion !== expectedRequirementVersion) {
      bad('需求已修订，请刷新后重新提交', 409);
    }
    for (const runId of runIds) {
      const run = trace.links.runs.find(item => item.id === runId);
      if (!run || !run.recorded || run.requirementVersion !== trace.requirementVersion) bad('交付执行不属于当前需求版本', 409);
    }
    const annotated: DeliveryEvidence[] = evidence.map(item => {
      const tool = item.runId && item.toolCallId ? trace.links.tools.find(value => value.runId === item.runId
        && value.toolCallId === item.toolCallId) : undefined;
      if (item.toolCallId && (!tool || !tool.recorded || tool.status !== 'succeeded')) bad('工具证据尚无成功结束记录', 409);
      return { ...item, verification: tool ? 'observed' : 'reported' };
    });
    const deliveryId = randomUUID(), timestamp = stamp();
    store.sqlite.prepare(`INSERT INTO requirement_deliveries
      (id,requirement_id,requirement_version,status,summary,evidence,run_ids,actor,created_at,updated_at)
      VALUES (?,?,?,'submitted',?,?,?,?,?,?)`).run(deliveryId, root.requirement_id, trace.requirementVersion,
        summary, JSON.stringify(annotated), JSON.stringify(runIds), actor.split(':')[0]!, timestamp, timestamp);
    store.sqlite.prepare(`INSERT INTO requirement_lifecycle_operations
      (requirement_id,actor_key,entry_key,request_hash,delivery_id,operation) VALUES (?,?,?,?,?,'submit')`)
      .run(root.requirement_id, actor, entryKey, hash, deliveryId);
    recordRequirementEvent(store, root.requirement_id, { eventKey: `delivery:${deliveryId}:submitted`,
      type: 'delivery.submitted', actor: actor.split(':')[0], summary, refs: { deliveryId, runIds, evidenceCount: evidence.length } });
    return result(store, root.requirement_id, deliveryId);
  }).immediate();
}

export function reviewRequirementDelivery(store: LifecycleStore, id: string, deliveryId: string, raw: unknown, actorKey = 'user') {
  fields(raw, ['decision', 'expectedUpdatedAt', 'entryKey', 'comment']);
  if (raw.decision !== 'accept' && raw.decision !== 'reject') bad('未知交付审阅决定');
  const decision = raw.decision as ReviewInput['decision'], entryKey = text(raw.entryKey, 'entryKey', 200);
  const expectedUpdatedAt = text(raw.expectedUpdatedAt, '交付版本时间', 100);
  const comment = raw.comment === undefined || raw.comment === '' ? '' : text(raw.comment, '审阅说明', 4000);
  const root = lifecycleRoot(store, id), hash = digest({ deliveryId, decision, expectedUpdatedAt, comment });
  return store.sqlite.transaction(() => {
    const prior = previousOperation(store, root.requirement_id, actorKey, entryKey, hash);
    if (prior) return result(store, root.requirement_id, prior.delivery_id);
    const current = result(store, root.requirement_id, deliveryId);
    const { delivery, trace } = current;
    if (delivery.status !== 'submitted' || delivery.updatedAt !== expectedUpdatedAt) bad('交付状态已变化，请重新确认', 409);
    if (decision === 'accept') {
      if (delivery.requirementVersion !== trace.requirementVersion) bad('需求已修订，不能接受旧版本交付', 409);
      if (!trace.acceptanceReady) bad(trace.blockers.join('；'), 409);
      if (!delivery.runIds.length) bad('正式交付须关联实际执行记录', 409);
      for (const runId of delivery.runIds) {
        const run = trace.links.runs.find(item => item.id === runId);
        if (!run || !run.recorded || run.status !== 'succeeded' || run.requirementVersion !== trace.requirementVersion) {
          bad('交付执行尚未成功结束或属于旧需求版本', 409);
        }
      }
    }
    const timestamp = stamp(delivery.updatedAt), reviewId = randomUUID();
    if (decision === 'accept' && trace.requirement.status !== 'done') {
      const payload = { ...trace.requirement, status: 'done', updatedAt: stamp(String(trace.requirement.updatedAt)) };
      store.sqlite.prepare("UPDATE workbench_records SET payload=? WHERE module='requirements' AND id=?")
        .run(JSON.stringify(payload), root.requirement_id);
    }
    store.sqlite.prepare('UPDATE requirement_deliveries SET status=?,updated_at=? WHERE id=?')
      .run(decision === 'accept' ? 'accepted' : 'rejected', timestamp, deliveryId);
    store.sqlite.prepare(`INSERT INTO requirement_delivery_reviews(id,delivery_id,decision,comment,actor,created_at)
      VALUES (?,?,?,?, 'user', ?)`).run(reviewId, deliveryId, decision, comment, timestamp);
    store.sqlite.prepare(`INSERT INTO requirement_lifecycle_operations
      (requirement_id,actor_key,entry_key,request_hash,delivery_id,operation) VALUES (?,?,?,?,?,'review')`)
      .run(root.requirement_id, actorKey, entryKey, hash, deliveryId);
    recordRequirementEvent(store, root.requirement_id, { eventKey: `delivery:${deliveryId}:${reviewId}`,
      type: decision === 'accept' ? 'delivery.accepted' : 'delivery.rejected', actor: 'user',
      summary: comment || (decision === 'accept' ? '用户明确接受交付' : '用户退回交付'),
      refs: { deliveryId, reviewId }, requirementVersion: delivery.requirementVersion });
    return result(store, root.requirement_id, deliveryId);
  }).immediate();
}
