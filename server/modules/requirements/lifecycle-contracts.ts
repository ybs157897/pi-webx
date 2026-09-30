import type Database from 'better-sqlite3';

export type LifecycleStore = { sqlite: Database.Database };
export type LifecycleStage = 'draft' | 'ready' | 'developing' | 'verifying' | 'delivered' | 'needs_review' | 'cancelled' | 'deleted';
export type EvidenceKind = 'file' | 'commit' | 'pull_request' | 'test' | 'report';
export type RequirementVersion = number | string | null;
export interface LifecycleEventInput {
  eventKey: string; type: string; actor?: string; summary: string;
  refs?: Record<string, unknown>; requirementVersion?: RequirementVersion; occurredAt?: string;
}
export interface LifecycleLinkInput {
  kind: string; id: string; refs?: Record<string, unknown>;
  requirementVersion?: RequirementVersion; occurredAt?: string;
}
export interface DeliveryEvidence {
  kind: EvidenceKind; ref: string; label?: string; runId?: string; toolCallId?: string;
  verification: 'observed' | 'reported';
}
export interface DeliveryInput {
  entryKey: string; expectedUpdatedAt: string; expectedRequirementVersion: number; summary: string;
  evidence: Array<Omit<DeliveryEvidence, 'verification'>>; runIds?: string[];
}
export interface ReviewInput {
  decision: 'accept' | 'reject'; expectedUpdatedAt: string; entryKey: string; comment?: string;
}
export interface LifecycleRoot {
  seq: number; requirement_id: string; current_version: number; current_updated_at: string;
  payload: string; archived: number; historical: number; created_at: string; updated_at: string;
}
export interface DeliveryRow {
  id: string; requirement_id: string; requirement_version: number;
  status: 'submitted' | 'accepted' | 'rejected'; summary: string; evidence: string; run_ids: string;
  actor: string; created_at: string; updated_at: string;
}
export interface PublicDelivery {
  id: string; status: DeliveryRow['status']; summary: string; evidence: DeliveryEvidence[];
  runIds: string[]; requirementVersion: number; createdAt: string; updatedAt: string;
  reviews: Array<{ id: string; decision: 'accept' | 'reject'; comment: string; createdAt: string; actor: 'user' }>;
}
export interface RequirementTrace {
  requirementId: string; humanId: string; requirementVersion: number; stage: LifecycleStage;
  archived: boolean; requirement: Record<string, unknown> & { id: string };
  events: Array<{ id: string; seq: number; type: string; time: string | null; actor: string;
    summary: string; refs: Record<string, unknown>; requirementVersion: number | null }>;
  links: { tasks: Array<Record<string, unknown>>; collaborationTasks: Array<Record<string, unknown>>;
    assignments: Array<Record<string, unknown>>; runs: Array<Record<string, unknown>>;
    messages: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> };
  deliveries: PublicDelivery[]; acceptanceReady: boolean; blockers: string[];
  coverage: { historical: boolean; warnings: string[] };
}
