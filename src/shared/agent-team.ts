/** Data returned by the Team projection API. Model-authored content stays wrapped. */

export type TeamMemberStatus =
  | 'running'
  | 'idle'
  | 'cancelling'
  | 'cancelled'
  | 'interrupted'
  | 'failed';

export type TeamTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TeamMessageKind = 'instruction' | 'question' | 'answer' | 'result';
export type TeamDeliveryState = 'queued' | 'inflight' | 'candidate' | 'fresh-reader-visible' | 'failed';
export type TeamMessageOrigin = 'member-settle' | 'member-message' | 'lead-message';
export type TeamDeliveryMode = 'turn-started' | 'steered';

export interface TeamMemberView {
  readonly memberId: string;
  readonly definitionId: string;
  readonly definitionRevision: number;
  readonly definitionSnapshotHash: string;
  /** An in-memory run identifier, never a resumable pi session id. */
  readonly sessionId: string;
  readonly status: TeamMemberStatus;
  readonly createdAt: number;
  readonly lastSeq: number;
  readonly hasResult: boolean;
  readonly statusReason?: string;
  /** Bounded member output. It is model-authored data, not a host assertion. */
  readonly untrustedResult?: { readonly text: string; readonly truncated: boolean };
}

export interface TeamTaskView {
  readonly taskId: string;
  readonly revision: number;
  readonly status: TeamTaskStatus;
  readonly ownerMemberId?: string;
  readonly blockedBy: readonly string[];
  readonly writeScopes: readonly string[];
  readonly untrusted: { readonly title: string; readonly description: string };
}

export interface TeamMessageView {
  readonly messageId: string;
  readonly seq: number;
  readonly from: string;
  readonly to: string;
  readonly kind: TeamMessageKind;
  readonly deliveryState: TeamDeliveryState;
  readonly origin?: TeamMessageOrigin;
  readonly deliveredAsToolResult?: boolean;
  readonly pendingReason?: string;
  readonly failureReason?: string;
  readonly deliveryMode?: TeamDeliveryMode;
  readonly untrustedPayload: unknown;
}

export interface TeamProjection {
  readonly teamId: string;
  readonly parentSessionId: string;
  readonly createdAt: number;
  readonly members: readonly TeamMemberView[];
  readonly tasks: readonly TeamTaskView[];
  readonly messages: readonly TeamMessageView[];
  readonly notes: readonly string[];
}

export interface CancelTeamResponse {
  readonly teamId: string;
  /** Members asked to stop; cancellation may still be in progress. */
  readonly cancelled: number;
  readonly reason: string | null;
}
