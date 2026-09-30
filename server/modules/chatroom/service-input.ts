import { createHash } from 'node:crypto';
import { WorkbenchInputError } from '../../workbench/store';
import { AGENT_IDS, type AgentId } from '../../module-agents/contracts';
import { CHATROOM_MAX_BODY_CHARS, CHATROOM_MAX_THREAD_MESSAGES, CHATROOM_MEMBER_NAMES, type ChatroomSendInput, type ChatroomUserSendInput } from './contracts';
import { parseChatroomMentions } from '../../../src/shared/chatroom-mentions.mjs';

const SEND_KEYS = new Set(['to', 'body', 'entryKey', 'requirementId', 'requirementVersion', 'expectedUpdatedAt', 'taskIds']);
const USER_SEND_KEYS = new Set(['body', 'entryKey', 'replyTo', 'threadId', 'collaborationTaskId']);
export function validAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

export function bad(message: string, status = 400): never {
  throw new WorkbenchInputError(message, status);
}

export function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > CHATROOM_MAX_THREAD_MESSAGES
    || value.some(id => typeof id !== 'string' || id.trim() === '' || id.length > 200)) {
    return bad('待办 ID 列表不合法');
  }
  const unique = [...new Set(value as string[])];
  if (unique.length !== value.length) return bad('待办 ID 不能重复');
  return unique;
}

export function normalizeInput(raw: ChatroomSendInput): ChatroomSendInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !SEND_KEYS.has(key))) return bad('群消息参数包含未知字段');
  if (typeof raw.body !== 'string') return bad('群消息正文必须是文本');
  const body = raw.body.trim();
  if (!body || body.length > CHATROOM_MAX_BODY_CHARS) return bad('群消息正文须为 1 到 12000 字');
  if (typeof raw.entryKey !== 'string' || !raw.entryKey.trim() || raw.entryKey.length > 200) {
    return bad('entryKey 须为 1 到 200 字');
  }
  if (raw.to !== undefined && !validAgentId(raw.to)) return bad('未知收件 Agent');
  if (raw.requirementId !== undefined && (typeof raw.requirementId !== 'string' || !raw.requirementId.trim())) {
    return bad('需求 ID 不合法');
  }
  if (raw.requirementVersion !== undefined
    && (!Number.isSafeInteger(raw.requirementVersion) || raw.requirementVersion < 1)) {
    return bad('需求修订号不合法');
  }
  if (raw.expectedUpdatedAt !== undefined && (typeof raw.expectedUpdatedAt !== 'string' || !raw.expectedUpdatedAt.trim())) {
    return bad('需求版本不合法');
  }
  return {
    ...(raw.to === undefined ? {} : { to: raw.to }), body, entryKey: raw.entryKey.trim(),
    ...(raw.requirementId === undefined ? {} : { requirementId: raw.requirementId }),
    ...(raw.requirementVersion === undefined ? {} : { requirementVersion: raw.requirementVersion }),
    ...(raw.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: raw.expectedUpdatedAt }),
    ...(raw.taskIds === undefined ? {} : { taskIds: ids(raw.taskIds) }),
  };
}

export function recipientFromBody(body: string): AgentId | null {
  const parsed = parseChatroomMentions(body);
  if (parsed.unknownMentions.length > 0) bad(`未知 @成员：${parsed.unknownMentions.join('、')}`);
  if (parsed.multipleRecipients) bad('一条群消息只能 @ 一位接收成员');
  const recipient = parsed.recipientId;
  if (recipient !== null && !validAgentId(recipient)) bad('未知收件 Agent');
  return recipient;
}

export function routedAgentInput(input: ChatroomSendInput): ChatroomSendInput {
  const mentioned = recipientFromBody(input.body);
  if (input.to && mentioned && input.to !== mentioned) bad('正文 @成员与 to 指定的接收成员不一致');
  const to = input.to ?? mentioned;
  if (!to) return input;
  const body = mentioned ? input.body : `@${CHATROOM_MEMBER_NAMES[to]} ${input.body}`;
  if (body.length > CHATROOM_MAX_BODY_CHARS) bad('群消息正文须为 1 到 12000 字');
  return { ...input, to, body };
}

export function normalizeUserInput(raw: ChatroomUserSendInput): ChatroomUserSendInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !USER_SEND_KEYS.has(key))) return bad('用户群消息包含未知字段');
  if (typeof raw.body !== 'string') return bad('群消息正文必须是文本');
  const body = raw.body.trim();
  if (!body || body.length > CHATROOM_MAX_BODY_CHARS) return bad('群消息正文须为 1 到 12000 字');
  if (typeof raw.entryKey !== 'string' || !raw.entryKey.trim() || raw.entryKey.length > 200) {
    return bad('entryKey 须为 1 到 200 字');
  }
  if (raw.replyTo !== undefined && (typeof raw.replyTo !== 'string' || !raw.replyTo.trim() || raw.replyTo.length > 200)) {
    return bad('回复目标消息 ID 不合法');
  }
  if (raw.threadId !== undefined && (typeof raw.threadId !== 'string' || !raw.threadId.trim() || raw.threadId.length > 200)) {
    return bad('群话题 ID 不合法');
  }
  if (raw.collaborationTaskId !== undefined && (typeof raw.collaborationTaskId !== 'string'
    || !raw.collaborationTaskId.trim() || raw.collaborationTaskId.length > 200)) return bad('协作任务 ID 不合法');
  return { body, entryKey: raw.entryKey.trim(),
    ...(raw.replyTo === undefined ? {} : { replyTo: raw.replyTo }),
    ...(raw.threadId === undefined ? {} : { threadId: raw.threadId }),
    ...(raw.collaborationTaskId === undefined ? {} : { collaborationTaskId: raw.collaborationTaskId }) };
}

export function requestHash(input: ChatroomSendInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.to ?? null, input.body, input.requirementId ?? null,
    input.requirementVersion ?? null, input.expectedUpdatedAt ?? null, input.taskIds ?? null,
  ])).digest('hex');
}

export function userRequestHash(input: ChatroomUserSendInput, recipientId: AgentId | null): string {
  return createHash('sha256').update(JSON.stringify([input.body, recipientId, input.replyTo ?? null,
    input.threadId ?? null, input.collaborationTaskId ?? null])).digest('hex');
}
