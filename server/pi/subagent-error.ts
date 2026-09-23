/** Why a worker run failed. Every value is a distinct recovery story for the model. */
export type SubagentRunCode =
  | 'parent-aborted'
  | 'timeout'
  /** The whole budget was spent waiting for a concurrency slot. */
  | 'capacity-timeout'
  /** The host's session budget refused the dispatch outright. */
  | 'capacity-full'
  | 'max-turns'
  | 'invalid-model'
  | 'model-error'
  | 'no-output'
  | 'unavailable-tools';

/** A failed worker run, carrying whatever text the worker did produce. */
export class SubagentRunError extends Error {
  readonly code: SubagentRunCode;
  readonly partialText: string | undefined;
  /** Identity of the run, once one was allocated, so a failure is traceable. */
  readonly runId: string | undefined;
  /** The failure without its partial-output appendix, for re-wrapping. */
  private readonly brief: string;

  constructor(code: SubagentRunCode, message: string, partialText?: string, runId?: string) {
    super(partialText === undefined || partialText.length === 0
      ? message
      : `${message}\n\n部分输出（可能不完整）：\n${partialText}`);
    this.name = 'SubagentRunError';
    this.code = code;
    this.partialText = partialText;
    this.runId = runId;
    this.brief = message;
  }

  /** The same failure, now that the run it belongs to has an identity. */
  withRunId(runId: string): SubagentRunError {
    return new SubagentRunError(this.code, this.brief, this.partialText, runId);
  }
}

