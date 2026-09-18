/**
 * Wire contract between the browser and the local pi bridge server.
 *
 * Mirrors the pi coding agent's RPC protocol (pi-coding-agent/docs/rpc.md):
 * commands are JSONL on the child's stdin, events are JSONL on its stdout.
 * The server relays both and wraps them in `ServerFrame`s for the browser.
 *
 * Deliberately permissive: pi adds fields over time, so anything not load-bearing
 * is optional and open-ended maps are used for provider-specific payloads.
 */

/* ------------------------------------------------------------------ primitives */

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Every level the wire accepts, i.e. what pi documents for a thinking level.
 * Wider than the UI on purpose: the three stops a user picks between live in
 * `THINKING_LEVEL_CHOICES` (lib/modelCatalog), while this stays the server's
 * validation set so a client may still send any documented level.
 */
export const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export interface PiImage {
  type: 'image';
  /** base64, no data: prefix */
  data: string;
  mimeType: string;
}

export interface PiModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total?: number;
}

export interface PiModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: PiModelCost;
  [key: string]: unknown;
}

export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: PiModelCost;
}

/* -------------------------------------------------------------------- messages */

export interface PiTextBlock {
  type: 'text';
  text: string;
}

export interface PiThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface PiToolCallBlock {
  type: 'toolCall';
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface PiImageBlock {
  type: 'image';
  data?: string;
  mimeType?: string;
}

export type PiKnownContentBlock =
  | PiTextBlock
  | PiThinkingBlock
  | PiToolCallBlock
  | PiImageBlock;

/** Providers may add block types we do not model; keep a permissive escape hatch. */
export interface PiUnknownContentBlock {
  type: string;
  [key: string]: unknown;
}

export type PiContentBlock = PiKnownContentBlock | PiUnknownContentBlock;

export interface PiUserMessage {
  role: 'user';
  content: string | PiContentBlock[];
  timestamp?: number;
  attachments?: unknown[];
}

export interface PiAssistantMessage {
  role: 'assistant';
  content: PiContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: PiUsage;
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | string;
  errorMessage?: string;
  timestamp?: number;
}

export interface PiToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: PiContentBlock[];
  details?: unknown;
  usage?: PiUsage;
  isError?: boolean;
  timestamp?: number;
}

/** Produced by the direct `bash` RPC command, not by LLM tool calls. */
export interface PiBashExecutionMessage {
  role: 'bashExecution';
  command: string;
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath: string | null;
  timestamp?: number;
}

export type PiAgentMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiBashExecutionMessage;

/* ------------------------------------------------------------- assistant deltas */

export type PiAssistantMessageEvent =
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content?: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; content?: string }
  | { type: 'toolcall_start'; contentIndex: number; id?: string; toolName?: string }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall?: PiToolCallBlock };

/** `partialResult` is cumulative output, not a delta — replace, do not append. */
export interface PiToolResultPayload {
  content?: PiContentBlock[];
  details?: unknown;
}

/* ---------------------------------------------------------------------- events */

export interface PiRpcResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type PiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages?: PiAgentMessage[]; willRetry?: boolean }
  | { type: 'agent_settled' }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message?: PiAgentMessage; toolResults?: PiAgentMessage[] }
  | { type: 'message_start'; message: PiAgentMessage }
  | { type: 'message_end'; message: PiAgentMessage }
  | { type: 'message_update'; usage?: PiUsage; assistantMessageEvent: PiAssistantMessageEvent }
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
    }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
      partialResult?: PiToolResultPayload;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result?: PiToolResultPayload;
      isError?: boolean;
      args?: Record<string, unknown>;
    }
  | { type: 'bash_execution_update'; id?: string; delta: string }
  | { type: 'queue_update'; steering?: string[]; followUp?: string[] }
  | { type: 'compaction_start'; reason?: string }
  | {
      type: 'compaction_end';
      reason?: string;
      summary?: string;
      tokensBefore?: number;
      tokensAfter?: number;
      aborted?: boolean;
    }
  | {
      type: 'auto_retry_start';
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      errorMessage?: string;
    }
  | { type: 'auto_retry_end'; success?: boolean; attempt?: number; finalError?: string }
  | {
      type: 'summarization_retry_scheduled';
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      errorMessage?: string;
    }
  | { type: 'summarization_retry_attempt_start'; attempt?: number }
  | { type: 'summarization_retry_finished' }
  | {
      type: 'extension_error';
      extensionPath?: string;
      event?: string;
      error?: string;
      stack?: string;
    }
  | PiExtensionUiRequest;

/* ------------------------------------------------------- extension UI (dialogs) */

export type PiExtensionUiMethod =
  | 'select'
  | 'confirm'
  | 'input'
  | 'editor'
  | 'notify'
  | 'setStatus'
  | 'setWidget'
  | 'setTitle'
  | 'set_editor_text';

/** Methods that block the agent until the client answers with `extension_ui_response`. */
export const PI_DIALOG_METHODS = ['select', 'confirm', 'input', 'editor'] as const;

/**
 * `extension_ui_response` — the browser's answer to an `extension_ui_request`.
 * Exactly one of the three carries the decision, by dialog kind: `value` for
 * select/input/editor, `confirmed` for confirm, `cancelled` for a dismissal.
 */
export interface PiExtensionUiResponse {
  type: 'extension_ui_response';
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface PiExtensionUiRequest {
  type: 'extension_ui_request';
  id: string;
  method: PiExtensionUiMethod;
  /** dialog methods */
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** ms; the agent auto-resolves with a default when the client stays silent */
  timeout?: number;
  /** notify */
  notifyType?: 'info' | 'warning' | 'error';
  /** setStatus */
  statusKey?: string;
  statusText?: string;
  /** setWidget */
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: 'aboveEditor' | 'belowEditor';
  /** set_editor_text */
  text?: string;
}

/* -------------------------------------------------------------------- commands */

export type PiCommand =
  | {
      type: 'prompt';
      message: string;
      images?: PiImage[];
      streamingBehavior?: 'steer' | 'followUp';
    }
  | { type: 'steer'; message: string; images?: PiImage[] }
  | { type: 'follow_up'; message: string; images?: PiImage[] }
  | { type: 'abort' }
  | { type: 'clear_queue' }
  | { type: 'new_session'; parentSession?: string }
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'cycle_model' }
  | { type: 'get_available_models' }
  | { type: 'set_thinking_level'; level: PiThinkingLevel }
  | { type: 'cycle_thinking_level' }
  | { type: 'get_available_thinking_levels' }
  | { type: 'set_steering_mode'; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_follow_up_mode'; mode: 'all' | 'one-at-a-time' }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'set_auto_compaction'; enabled: boolean }
  | { type: 'set_auto_retry'; enabled: boolean }
  | { type: 'abort_retry' }
  | { type: 'bash'; command: string }
  | { type: 'abort_bash' }
  | { type: 'get_session_stats' }
  | { type: 'get_commands' }
  /* The tool allowlist: which tools this session has at all. `set_tools` carries
     builtin names only — the host merges the extension tools back in, so a preset
     can never switch off a tool an extension registered. */
  | { type: 'get_tools' }
  | { type: 'set_tools'; toolNames: string[] }
  | { type: 'set_session_name'; name: string }
  | { type: 'export_html'; outputPath?: string }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'fork'; entryId: string }
  | { type: 'clone' }
  | {
      type: 'extension_ui_response';
      id: string;
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
    };

/** Commands may carry a correlation id; the matching response echoes it. */
export type PiCommandEnvelope = PiCommand & { id?: string };

/* ----------------------------------------------------------- session + state */

export interface PiSessionState {
  model?: PiModel | null;
  thinkingLevel?: PiThinkingLevel;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: 'all' | 'one-at-a-time';
  followUpMode?: 'all' | 'one-at-a-time';
  sessionFile?: string | null;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
  [key: string]: unknown;
}

export interface PiSessionStats {
  sessionId?: string;
  sessionFile?: string | null;
  model?: PiModel | null;
  thinkingLevel?: PiThinkingLevel;
  totalMessages?: number;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCost?: number;
  contextUsage?: { tokens?: number; contextWindow?: number; percent?: number } | null;
  [key: string]: unknown;
}

/** A slash command registered by pi itself or by an installed extension. */
export interface PiSlashCommand {
  name: string;
  description?: string;
  source?: string;
  [key: string]: unknown;
}

/** One tool, as `get_tools` reports it: what exists, and whether it is on. */
export interface PiToolInfo {
  name: string;
  description?: string;
  active: boolean;
}

/** `get_tools` payload: every tool plus the builtin selection behind the active set. */
export interface PiToolsPayload {
  tools: PiToolInfo[];
  /**
   * The builtin selection this session was configured with. It excludes the
   * extension tools the host merged in, and a resumed session reports the value
   * recorded in its own log.
   */
  selection: string[];
}

/* ------------------------------------------------- browser <-> server transport */

/** Frames pushed to the browser over SSE (`GET /api/sessions/:id/events`). */
export type ServerFrame =
  | {
      t: 'hello';
      sessionId: string;
      pid: number | null;
      cwd: string;
      sessionFile: string | null;
      resumed: boolean;
    }
  | { t: 'pi'; event: PiEvent }
  /** A stdout line that was not valid JSON — surfaced for debugging, never fatal. */
  | { t: 'stdout'; line: string }
  | { t: 'stderr'; chunk: string }
  | { t: 'exit'; code: number | null; signal: string | null }
  | { t: 'error'; message: string };

export interface SessionSummary {
  id: string;
  cwd: string;
  pid: number | null;
  createdAt: number;
  alive: boolean;
  sessionFile: string | null;
  sessionName: string | null;
  provider: string | null;
  model: string | null;
  streaming: boolean;
  /** subscribers currently attached to this session's SSE stream */
  clients: number;
}

export interface CreateSessionRequest {
  cwd?: string;
  name?: string;
  provider?: string;
  model?: string;
  thinking?: PiThinkingLevel;
  /** Resume an existing pi session JSONL file. */
  sessionPath?: string;
  /** Start with session persistence disabled (`--no-session`). */
  noSession?: boolean;
  /**
   * Builtin tools this session should start with — the browser's preset. A
   * resumed session ignores it in favour of the selection in its own log.
   */
  toolNames?: string[];
  extraArgs?: string[];
}

export interface CreateSessionResponse {
  session: SessionSummary;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
}

export interface CommandRequest {
  command: PiCommandEnvelope;
}

export interface CommandResponse {
  response: PiRpcResponse;
}

/** A past pi session file discovered on disk, offered for resume. */
export interface StoredSession {
  /** absolute path to the .jsonl file */
  path: string;
  id: string;
  cwd: string;
  startedAt: string;
  sizeBytes: number;
  preview: string | null;
}

export interface ListStoredSessionsResponse {
  sessions: StoredSession[];
}

/**
 * Answer of `POST /api/workspace/pick`: the directory the OS chooser returned,
 * or null when the user dismissed it — a cancel is an outcome, not an error.
 */
export interface PickDirectoryResponse {
  path: string | null;
}

export interface ServerConfigResponse {
  cwd: string;
  home: string;
  /** default working directory the server was started in */
  defaultCwd: string;
  piVersion: string | null;
  /** candidates offered as quick picks in the directory picker */
  suggestedCwds: string[];
}
