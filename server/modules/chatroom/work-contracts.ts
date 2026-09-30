import type { AgentId } from '../../module-agents/contracts';
import type { ChatroomRunStatus, ChatroomTaskStatus } from './contracts';

export interface WorkBinding {
  scope: 'discussion' | 'assignment';
  taskId: string | null;
  assignmentId: string | null;
  sessionId: string | null;
  lastProcessedSeq: number;
  needsReview: boolean;
}

export interface WorkRun {
  id: string;
  attempt: number;
  status: ChatroomRunStatus;
  taskId: string | null;
  assignmentId: string | null;
  messageId: string;
  sessionId: string;
  agentId: AgentId;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}
export type WorkRunningRun = Omit<WorkRun, 'status'> & { status: 'running' };

export interface WorkTaskActionInput {
  action: 'resume' | 'cancel' | 'review';
  entryKey: string;
  expectedVersion: number;
  agentId?: AgentId;
  reviewed?: boolean;
  body?: string;
}

export interface WorkAcceptInput { action: 'accept'; title: string; entryKey: string }
export interface WorkUpdateInput {
  action: 'update'; taskId: string; status: ChatroomTaskStatus; summary: string; entryKey: string;
}
export type WorkToolInput = WorkAcceptInput | WorkUpdateInput;
