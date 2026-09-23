/** Launch boundary shared by macOS Seatbelt and Windows container tools. */
export interface ToolLaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly toolCwd: string;
  readonly params: unknown;
  readonly env: NodeJS.ProcessEnv;
  stop(pid: number | undefined): void;
  cleanup(): void;
}

export class TeamSandboxUnavailableError extends Error {
  constructor(readonly status: 400 | 501, message: string) {
    super(message);
    this.name = 'TeamSandboxUnavailableError';
  }
}
