/**
 * Team 实体在 journal 里的记录形状：写出（snapshot）与读回（read）。
 *
 * 从 `team-runtime.ts` 拆出（拆分重构，行为不变）：运行时与重放都要用同一套编解码，
 * 所以它们是独立的一层，不持有任何状态。
 */

import type {
  TeamDeliveryMode,
  TeamDeliveryState,
  TeamMember,
  TeamMemberStatus,
  TeamMessage,
  TeamMessageKind,
  TeamMessageOrigin,
  TeamTask,
  TeamTaskStatus,
} from './team-types';

/**
 * The recorded shape of an entity.
 *
 * Snapshots rather than diffs: the replay is then "the last record for this id
 * wins", which is what makes the round-trip assertion meaningful. The copies are
 * shallow-but-explicit so a later in-memory mutation cannot rewrite history.
 */
export function memberSnapshot(member: TeamMember): Record<string, unknown> {
  return {
    id: member.id,
    teamId: member.teamId,
    definitionId: member.definitionId,
    definitionRevision: member.definitionRevision,
    definitionSnapshotHash: member.definitionSnapshotHash,
    sessionId: member.sessionId,
    status: member.status,
    createdAt: member.createdAt,
    ...(member.resultText === undefined ? {} : { resultText: member.resultText }),
    ...(member.statusReason === undefined ? {} : { statusReason: member.statusReason }),
    lastSeq: member.lastSeq,
  };
}

export function taskSnapshot(task: TeamTask): Record<string, unknown> {
  return {
    id: task.id,
    teamId: task.teamId,
    revision: task.revision,
    title: task.title,
    description: task.description,
    status: task.status,
    ...(task.ownerMemberId === undefined ? {} : { ownerMemberId: task.ownerMemberId }),
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
  };
}

export function messageSnapshot(message: TeamMessage): Record<string, unknown> {
  return {
    id: message.id,
    teamId: message.teamId,
    from: message.from,
    to: message.to,
    kind: message.kind,
    payload: message.payload,
    deliveryState: message.deliveryState,
    seq: message.seq,
    ...(message.origin === undefined ? {} : { origin: message.origin }),
    ...(message.deliveredAsToolResult === undefined ? {} : { deliveredAsToolResult: message.deliveredAsToolResult }),
    ...(message.pendingReason === undefined ? {} : { pendingReason: message.pendingReason }),
    ...(message.failureReason === undefined ? {} : { failureReason: message.failureReason }),
    ...(message.deliveryMode === undefined ? {} : { deliveryMode: message.deliveryMode }),
  };
}

/** Read one member snapshot back. A record that does not describe a member is dropped. */
export function readMember(value: unknown, teamId: string): TeamMember | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  const status = record['status'];
  if (typeof id !== 'string' || typeof status !== 'string') return undefined;
  return {
    id,
    teamId,
    definitionId: typeof record['definitionId'] === 'string' ? record['definitionId'] : '',
    definitionRevision: typeof record['definitionRevision'] === 'number' ? record['definitionRevision'] : 0,
    definitionSnapshotHash: typeof record['definitionSnapshotHash'] === 'string' ? record['definitionSnapshotHash'] : '',
    sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : '',
    status: status as TeamMemberStatus,
    createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : 0,
    ...(typeof record['resultText'] === 'string' ? { resultText: record['resultText'] } : {}),
    ...(typeof record['statusReason'] === 'string' ? { statusReason: record['statusReason'] } : {}),
    lastSeq: typeof record['lastSeq'] === 'number' ? record['lastSeq'] : 0,
  };
}

/** Read one task snapshot back. */
export function readTask(value: unknown, teamId: string): TeamTask | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string') return undefined;
  return {
    id,
    teamId,
    revision: typeof record['revision'] === 'number' ? record['revision'] : 1,
    title: typeof record['title'] === 'string' ? record['title'] : '',
    description: typeof record['description'] === 'string' ? record['description'] : '',
    status: (typeof record['status'] === 'string' ? record['status'] : 'pending') as TeamTaskStatus,
    ...(typeof record['ownerMemberId'] === 'string' ? { ownerMemberId: record['ownerMemberId'] } : {}),
    blockedBy: Array.isArray(record['blockedBy']) ? (record['blockedBy'] as string[]) : [],
    writeScopes: Array.isArray(record['writeScopes']) ? (record['writeScopes'] as string[]) : [],
  };
}

/** Read one message snapshot back. */
export function readMessage(value: unknown, teamId: string): TeamMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string') return undefined;
  return {
    id,
    teamId,
    from: typeof record['from'] === 'string' ? record['from'] : '',
    to: typeof record['to'] === 'string' ? record['to'] : '',
    kind: (typeof record['kind'] === 'string' ? record['kind'] : 'result') as TeamMessageKind,
    payload: record['payload'] ?? null,
    deliveryState: (typeof record['deliveryState'] === 'string' ? record['deliveryState'] : 'queued') as TeamDeliveryState,
    seq: typeof record['seq'] === 'number' ? record['seq'] : 0,
    ...(typeof record['origin'] === 'string' ? { origin: record['origin'] as TeamMessageOrigin } : {}),
    ...(typeof record['deliveredAsToolResult'] === 'boolean' ? { deliveredAsToolResult: record['deliveredAsToolResult'] } : {}),
    ...(typeof record['pendingReason'] === 'string' ? { pendingReason: record['pendingReason'] } : {}),
    ...(typeof record['failureReason'] === 'string' ? { failureReason: record['failureReason'] } : {}),
    ...(typeof record['deliveryMode'] === 'string' ? { deliveryMode: record['deliveryMode'] as TeamDeliveryMode } : {}),
  };
}
