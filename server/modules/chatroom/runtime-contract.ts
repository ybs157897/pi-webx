import type { AgentId, ProfileLoadResult } from '../../module-agents/contracts';
import type { ModuleAgentSessionService } from '../../module-agents/session-service';
import type { PiHost } from '../../pi/host';
import type { ChatroomConsumption, ChatroomMessage, ChatroomPublicMessage, ConsumptionStatus } from './contracts';

export interface ChatroomSessionBinding {
  scope: 'discussion' | 'assignment';
  taskId: string | null;
  assignmentId: string | null;
  sessionId: string | null;
  lastProcessedSeq: number;
  needsReview: boolean;
}

export interface ChatroomRunRef {
  id: string;
}

export interface ChatroomRuntimeWork {
  getBinding(message: ChatroomMessage, agentId: AgentId): ChatroomSessionBinding;
  bindSession(message: ChatroomMessage, agentId: AgentId, sessionId: string, profileRevision?: string): void;
  beginRun(message: ChatroomMessage, agentId: AgentId, sessionId: string): ChatroomRunRef;
  finishRun(runId: string, status: 'succeeded' | 'failed' | 'cancelled' | 'needs_review',
    options?: { error?: string; checkpoint?: string; lastProcessedSeq?: number }): void;
  markToolStart(runId: string, toolCallId: string, toolName: string): void;
  markToolEnd(runId: string, toolCallId: string, isError: boolean,
    facts?: { resultHash: string; resultBytes: number; exitCode: number | null }): void;
  registerCancelRun(handler: (runId: string) => Promise<void> | void): (() => void) | void;
}

export interface ChatroomRuntimeService {
  work: ChatroomRuntimeWork;
  registerRunner(run: (message: ChatroomMessage) => Promise<void>): () => void;
  withDelivery<T>(sessionId: string, message: ChatroomMessage, agentId: AgentId, run: () => Promise<T>): Promise<T>;
  history(threadId: string, limit?: number): ChatroomPublicMessage[];
  historySince(threadId: string, afterSeq: number, beforeSeq?: number, limit?: number): ChatroomPublicMessage[];
  hasReply(messageId: string, senderId: AgentId): boolean;
  publishReply(senderId: AgentId, sessionId: string, input: { body: string; entryKey: string }): ChatroomMessage;
  recordClaimants(messageId: string, claimants: readonly AgentId[]): void;
  prepareConsumptions(messageId: string, agents: readonly AgentId[]): ChatroomConsumption[];
  updateConsumption(messageId: string, agentId: AgentId, status: Exclude<ConsumptionStatus, 'pending'>, error?: string): void;
  stop(): Promise<void>;
}

export interface ChatroomRuntimeDeps {
  host: Pick<PiHost, 'sessions' | 'command' | 'subscribe' | 'unsubscribe' | 'kill'>;
  profiles: Map<AgentId, ProfileLoadResult>;
  workspaceKey: string;
  sessionService: Pick<ModuleAgentSessionService, 'openOrCreate'>;
  chatroom: ChatroomRuntimeService;
  admissionTimeoutMs?: number;
  turnTimeoutMs?: number;
  claimTimeoutMs?: number;
  pollMs?: number;
  maxConcurrentAgents?: number;
}
