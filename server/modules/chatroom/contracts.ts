import type { AgentId } from '../../module-agents/contracts';

export const CHATROOM_ID = 'internal';
export const CHATROOM_NAME = '内部聊天室';
export const CHATROOM_USER_NAME = '我';
export const CHATROOM_MAX_BODY_CHARS = 12_000;
export const CHATROOM_MAX_DEPTH = 12;
export const CHATROOM_MAX_THREAD_MESSAGES = 40;

export const CHATROOM_MEMBER_NAMES: Readonly<Record<AgentId, string>> = {
  requirements: '需求管理',
  assistant: '我的助理',
  codes: '代码开发',
  logs: '日志查询',
};

export type DeliveryStatus = 'none' | 'pending' | 'running' | 'delivered' | 'failed';
export type ChatroomSenderId = AgentId | 'user';

export type ConsumptionStatus = 'pending' | 'evaluating' | 'processing' | 'consumed' | 'skipped' | 'failed';

/** A subscription is acknowledged only after the member's full processing turn succeeds. */
export interface ChatroomConsumption {
  agentId: AgentId;
  agentName: string;
  status: ConsumptionStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/** Internal provenance travels with a delivery, never through the public HTTP projection. */
export interface ChatroomContext {
  requirementId?: string;
  expectedUpdatedAt?: string;
  taskIds?: string[];
  taskVersions?: Record<string, string>;
  /** Explicitly reported complete by codes in this handoff; absence never grants completion. */
  reportedTaskIds?: string[];
}

export interface ChatroomSendInput {
  to?: AgentId;
  body: string;
  entryKey: string;
  requirementId?: string;
  expectedUpdatedAt?: string;
  taskIds?: string[];
}

export interface ChatroomUserSendInput {
  body: string;
  entryKey: string;
  replyTo?: string;
}

export interface ChatroomPublicMessage {
  id: string;
  seq: number;
  threadId: string;
  replyTo: string | null;
  senderId: ChatroomSenderId;
  senderName: string;
  recipientId: AgentId | null;
  body: string;
  createdAt: string;
  deliveryStatus: DeliveryStatus;
  error: string | null;
  consumptions: ChatroomConsumption[];
}

export interface ChatroomMessage extends ChatroomPublicMessage {
  senderSessionId: string;
  entryKey: string;
  requestHash: string;
  depth: number;
  context: ChatroomContext;
  /** Members that self-claimed an unaddressed user broadcast; internal routing fact, never public. */
  claimants: AgentId[];
}

export interface ChatroomReadResult {
  room: { id: typeof CHATROOM_ID; name: typeof CHATROOM_NAME };
  members: Array<{ id: ChatroomSenderId; name: string }>;
  messages: ChatroomPublicMessage[];
  nextCursor: number;
  hasMore: boolean;
  updates: ChatroomPublicMessage[];
}

export type ChatroomRunner = (message: ChatroomMessage) => Promise<void>;
