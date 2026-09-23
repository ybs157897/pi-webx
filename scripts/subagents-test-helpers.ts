/**
 * Pure helpers for the isolated subagents test instance.
 *
 * Nothing here reads a process-wide path or the environment of the real agent
 * directory, so this module is safe to import *before* the test process
 * redirects `PI_CODING_AGENT_DIR`. `scripts/subagents-test-server.ts` is the
 * entry point that performs that redirect and then loads `server/**`; the split
 * exists precisely to keep the ordering possible (see the entry point's header).
 *
 * Scope note, stated once: the guard here narrows one test run. It is not a
 * sandbox, and it is not a security boundary for the product.
 */

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';

/* --------------------------------------------------------------- the policy */

/** The single provider/model this test instance is allowed to reach. */
export interface TestModelTarget {
  readonly providerId: string;
  readonly modelId: string;
}

/** Everything the guard needs to decide, and nothing it does not. */
export interface TestGatePolicy {
  readonly runDir: string;
  readonly fixtureRoot: string;
  readonly model: TestModelTarget;
  readonly allowedCommands: ReadonlySet<string>;
}

/** Commands that cannot change model/route, load a stored session, or run a shell. */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'prompt',
  'steer',
  'follow_up',
  'abort',
  'get_state',
  'get_messages',
  'get_available_models',
  'get_available_thinking_levels',
  'get_session_stats',
  'get_tools',
  'get_commands',
  // Allowed so a test can narrow the tool surface to `read`; the guard below
  // still refuses any widening to bash/write/edit.
  'set_tools',
];

/**
 * Management surfaces a test run must never write through.
 *
 * These are rejected for *every* method, including GET: reading them is how a
 * harness would end up holding model configuration it has no business using.
 */
export const DENIED_PATH_PREFIXES: readonly string[] = [
  '/models-config',
  '/providers',
  '/git',
  '/workspace',
  '/attachments',
];

/** Read-only GETs the test run legitimately needs. */
export const ALLOWED_GET_PATHS: ReadonlySet<string> = new Set(['/health', '/config', '/models']);

/** Writes the test run is allowed to perform. */
export const ALLOWED_WRITE_PREFIXES: readonly string[] = ['/agent-definitions', '/sessions'];

/** Commands refused by name even if they ever enter the allowlist. */
export const DENIED_COMMANDS: ReadonlySet<string> = new Set(['bash', 'abort_bash', 'set_model']);

/** Default test port; deliberately not the product's 8787. */
export const DEFAULT_TEST_PORT = 8899;

/* ------------------------------------------------------------- RUN_DIR rules */

/** The requested run directory is unusable; the message says which rule failed. */
export class RunDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunDirError';
  }
}

/**
 * Resolve `RUN_DIR` out of the environment, creating it with owner-only access.
 *
 * @param env - process environment (injected so tests never touch the real one).
 * @param projectRoot - checkout root, rejected as a run dir location.
 * @returns the real (symlink-resolved) run directory.
 */
export function resolveRunDir(env: NodeJS.ProcessEnv, projectRoot: string): string {
  const raw = env['RUN_DIR']?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new RunDirError('RUN_DIR must be set and non-empty');
  }
  if (!path.isAbsolute(raw)) {
    throw new RunDirError(`RUN_DIR must be an absolute path: ${raw}`);
  }

  mkdirSync(raw, { recursive: true, mode: 0o700 });
  const resolved = realpathSync(raw);

  // Containment is checked after realpath so a symlink cannot smuggle the run
  // directory into the home directory or the project tree.
  const home = realpathSync(homedir());
  if (resolved === home) {
    throw new RunDirError('RUN_DIR must not be the home directory');
  }
  const realProject = realpathSync(projectRoot);
  if (contains(realProject, resolved)) {
    throw new RunDirError(`RUN_DIR must not be inside the project: ${resolved}`);
  }

  const realTmp = realpathSync(tmpdir());
  if (!contains(realTmp, resolved)) {
    throw new RunDirError(`RUN_DIR must be under the OS temp root ${realTmp}: ${resolved}`);
  }
  return resolved;
}

/**
 * Canonicalise a path for containment comparison.
 *
 * On macOS the OS temp root is a symlink (`/var` -> `/private/var`), so a caller
 * that legitimately passes a fixture path can still fail a naive prefix check.
 * Falls back to the resolved path when the target does not exist yet.
 */
export function canonicalize(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Whether `candidate` is `parent` itself or lies beneath it. */
export function contains(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Parse `PI_WEBX_PORT`, refusing anything unusable rather than guessing. */
export function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_TEST_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new RunDirError(`PI_WEBX_PORT must be a valid port number: ${raw}`);
  }
  return parsed;
}

/* --------------------------------------------------------- credential store */

/**
 * Reads one credential from the real store; injected so tests never read a file.
 *
 * The SDK's own `readStoredCredential` is a plain JSON read (`auth-storage.js`
 * 417-425) — it never executes a configured key command. Resolution of a
 * command or env reference happens later, inside `Models.getAuth()`.
 */
export type CredentialReader = (
  providerId: string,
  authPath: string,
  options?: AuthOperationOptions,
) => Credential | undefined;

/** The only credential kind this adapter can honestly serve. */
const SUPPORTED_CREDENTIAL_TYPE = 'api_key';

/**
 * A credential this test instance refuses to inject rather than guess about.
 *
 * A `"!cmd"` key reference or an OAuth credential needs SDK-internal resolution
 * that the public surface does not offer, so the run stops and reports instead
 * of reading or printing anything to work around it.
 */
export class UnsupportedCredentialError extends Error {
  constructor(providerId: string, credentialType: string) {
    super(
      `provider "${providerId}" stores a "${credentialType}" credential; the public ` +
        'read-only adapter serves api_key only, so this instance stops here instead of ' +
        'reading or printing a secret to work around it.',
    );
    this.name = 'UnsupportedCredentialError';
  }
}

/**
 * A `CredentialStore` that can only ever read, and only for one provider.
 *
 * Scope, stated honestly: this adapter exists for the single `api_key`-style
 * provider this test run uses. It does **not** implement OAuth refresh and must
 * not be read as a general provider adapter.
 *
 *   - `read` serves one provider; anything else reads as "not configured", so
 *     this instance cannot be steered at another account.
 *   - `list` returns metadata only (`{providerId, type}`). It calls the reader,
 *     which is a JSON read — it never executes a configured key command. The
 *     `CredentialStore` interface requires that independently of this code.
 *   - `modify`/`delete` throw. That is what makes the read-only claim checkable
 *     rather than aspirational.
 *
 * The credential object is handed to `ModelRuntime` in memory only: never
 * logged, never serialized, never attached to a response, never written.
 *
 * @param authPath - the real `auth.json`, read by the SDK's public reader.
 * @param providerId - the single provider this run may use.
 * @param read - credential reader; defaults to the SDK's public one.
 */
export function createReadOnlyCredentialStore(
  authPath: string,
  providerId: string,
  read: CredentialReader,
): CredentialStore {
  const refuse = (): never => {
    throw new Error('Read-only test credential store cannot modify credentials');
  };

  return {
    async read(candidate: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
      return candidate === providerId ? read(providerId, authPath, options) : undefined;
    },
    async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
      const credential = read(providerId, authPath, options);
      // Metadata only: the type, never the secret and never a value.
      return credential === undefined ? [] : [{ providerId, type: credential.type }];
    },
    modify: refuse,
    delete: refuse,
  };
}

/**
 * Describe the stored credential without treating "absent" as a failure.
 *
 * An absent store entry is normal: the provider's key may live in the model
 * configuration the SDK loads read-only from the real `models.json`, and the
 * resolver accepts `credential: undefined` for exactly that case. Only a
 * credential kind this adapter cannot serve (OAuth) is refused.
 *
 * @returns the credential type, or `'absent'` when the store has no entry.
 */
export function describeCredential(
  authPath: string,
  providerId: string,
  read: CredentialReader,
): string {
  const credential = read(providerId, authPath);
  if (credential === undefined) return 'absent';
  if (credential.type !== SUPPORTED_CREDENTIAL_TYPE) {
    throw new UnsupportedCredentialError(providerId, credential.type);
  }
  return credential.type;
}

/* ------------------------------------------------------------- the test gate */

/** What the guard decided for one request. */
export type GateDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'allow-empty-sessions' }
  | { readonly kind: 'deny'; readonly reason: string };

const DENY = (reason: string): GateDecision => ({ kind: 'deny', reason });

/**
 * Decide one request from method, path, body, and query alone.
 *
 * Deliberately pure: the whole bypass surface is then a table-driven unit test
 * instead of an integration run, and the same function is what the middleware
 * executes when the script actually serves.
 */
export function decideRequest(
  policy: TestGatePolicy,
  request: {
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
    readonly query?: Record<string, unknown>;
  },
): GateDecision {
  const method = request.method.toUpperCase();
  const apiPath = stripApiPrefix(request.path);

  for (const denied of DENIED_PATH_PREFIXES) {
    if (apiPath === denied || apiPath.startsWith(`${denied}/`)) {
      return DENY(`${apiPath} is a management surface and is disabled in the test instance`);
    }
  }

  if (method === 'GET' || method === 'HEAD') {
    // The stored-session list would enumerate the user's real transcripts.
    if (apiPath === '/stored-sessions') return { kind: 'allow-empty-sessions' };
    if (ALLOWED_GET_PATHS.has(apiPath)) return { kind: 'allow' };
    if (apiPath === '/agent-definitions' || apiPath.startsWith('/agent-definitions/')) {
      return { kind: 'allow' };
    }
    if (apiPath === '/sessions') {
      // Checked before the allow: a query naming a real transcript must be
      // refused, not silently ignored by the route it happens to precede.
      if (requestsRealSession(apiPath, request.query)) {
        return DENY('stored sessions are not readable in the test instance');
      }
      return { kind: 'allow' };
    }
    return DENY(`${method} ${apiPath} is not on the test allowlist`);
  }

  if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
    return DENY(`${method} ${apiPath} is not on the test allowlist`);
  }

  if (!ALLOWED_WRITE_PREFIXES.some((prefix) => apiPath === prefix || apiPath.startsWith(`${prefix}/`))) {
    return DENY(`${method} ${apiPath} must not write in the test instance`);
  }

  if (apiPath === '/sessions') return decideCreateSession(policy, request.body);
  if (apiPath === '/sessions/fork') return decideFork(policy, request.body);
  if (/^\/sessions\/[^/]+\/command$/.test(apiPath)) return decideCommand(policy, request.body);
  if (apiPath === '/agent-definitions' || apiPath.startsWith('/agent-definitions/')) {
    return { kind: 'allow' };
  }
  return DENY(`${method} ${apiPath} is not on the test allowlist`);
}

/** Reject the resume-by-path/by-id fields that reach the user's real transcripts. */
function requestsRealSession(apiPath: string, query: Record<string, unknown> | undefined): boolean {
  if (apiPath.startsWith('/sessions/')) return true;
  if (query === undefined) return false;
  return query['sessionPath'] !== undefined || query['sessionId'] !== undefined;
}

/** A new session must land in the fixture root, never in the ambient cwd. */
function decideCreateSession(policy: TestGatePolicy, body: unknown): GateDecision {
  const record = isRecord(body) ? body : {};
  for (const field of ['sessionPath', 'sessionId'] as const) {
    if (record[field] !== undefined) {
      return DENY(`${field} would restore a real session; the test instance creates new ones only`);
    }
  }
  const cwd = record['cwd'];
  if (cwd === undefined) {
    // The middleware fills this in before the route sees it, so reaching here
    // means the body was not rewritten.
    return DENY('cwd is required: it must be inside the fixture root');
  }
  if (typeof cwd !== 'string' || !contains(policy.fixtureRoot, canonicalize(cwd))) {
    return DENY(`cwd must be inside ${policy.fixtureRoot}`);
  }
  return { kind: 'allow' };
}

/** Only an internal fork of a session this process already hosts. */
function decideFork(policy: TestGatePolicy, body: unknown): GateDecision {
  const record = isRecord(body) ? body : {};
  if (record['path'] !== undefined) {
    return DENY('fork by path would read a real transcript; use an in-process sessionId');
  }
  const sessionId = record['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return DENY('fork requires an in-process sessionId');
  }
  const cwd = record['cwd'];
  if (cwd !== undefined && (typeof cwd !== 'string' || !contains(policy.fixtureRoot, canonicalize(cwd)))) {
    return DENY(`fork cwd must be inside ${policy.fixtureRoot}`);
  }
  return { kind: 'allow' };
}

/** Reject route/shell changes and verify any model the command names. */
function decideCommand(policy: TestGatePolicy, body: unknown): GateDecision {
  const record = isRecord(body) ? body : {};
  const command = isRecord(record['command']) ? record['command'] : {};
  const type = command['type'];
  if (typeof type !== 'string') return DENY('command.type is required');
  if (DENIED_COMMANDS.has(type)) return DENY(`command ${type} is disabled in the test instance`);
  if (!policy.allowedCommands.has(type)) return DENY(`command ${type} is not on the test allowlist`);

  // `set_tools` is the one allowed command that can widen the tool surface; the
  // test run reads and prompts only, so bash/write must not appear.
  if (type === 'set_tools') {
    const names = command['toolNames'];
    if (!isStringArray(names)) return DENY('set_tools requires a toolNames array');
    const forbidden = names.filter((name) => name === 'bash' || name === 'write' || name === 'edit');
    if (forbidden.length > 0) return DENY(`tools ${forbidden.join(', ')} are disabled in the test instance`);
  }

  const provider = command['provider'];
  const modelId = command['modelId'];
  if (provider !== undefined && provider !== policy.model.providerId) {
    return DENY(`provider must stay ${policy.model.providerId}`);
  }
  if (modelId !== undefined && modelId !== policy.model.modelId) {
    return DENY(`model must stay ${policy.model.modelId}`);
  }
  return { kind: 'allow' };
}

/** Strip the `/api` mount prefix so one decision covers both call shapes. */
export function stripApiPrefix(requestPath: string): string {
  return requestPath.startsWith('/api') ? requestPath.slice('/api'.length) || '/' : requestPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/* --------------------------------------------------------- static SPA assets */

/** Outcome of wiring the production build into the test instance. */
export type StaticAssetOutcome =
  | { readonly kind: 'served'; readonly indexHtml: string }
  | { readonly kind: 'missing'; readonly indexHtml: string };

/** Express shape needed to serve the build; avoids importing express here. */
export interface StaticAssetHost {
  use(...handlers: readonly ((req: StaticRequest, res: StaticResponse, next: () => void) => void)[]): void;
}

/** Minimal request surface the SPA fallback reads. */
export interface StaticRequest {
  readonly method: string;
  readonly path: string;
}

/** Minimal response surface the SPA fallback writes. */
export interface StaticResponse {
  sendFile(filePath: string, callback?: (error?: Error) => void): void;
}

/**
 * Serve the production build with an SPA fallback, exactly as `server/index.ts`
 * does for the product.
 *
 * The UI acceptance run needs the real page, so a missing `dist/index.html` is
 * reported rather than silently degraded the way the product server does — the
 * caller decides whether that is fatal.
 *
 * @param app - express app to attach to.
 * @param distDir - absolute `dist` directory.
 * @param exists - existence predicate, injected so tests never touch `dist`.
 * @param staticMiddleware - express static middleware for `distDir`.
 */
export function attachStaticAssets(
  app: StaticAssetHost,
  distDir: string,
  exists: (candidate: string) => boolean,
  staticMiddleware: (req: StaticRequest, res: StaticResponse, next: () => void) => void,
): StaticAssetOutcome {
  const indexHtml = path.join(distDir, 'index.html');
  if (!exists(indexHtml)) return { kind: 'missing', indexHtml };

  app.use(staticMiddleware);
  app.use((req: StaticRequest, res: StaticResponse, next: () => void) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (req.path.startsWith('/api')) {
      next();
      return;
    }
    // Express 5 dropped the `*` wildcard, so the SPA fallback is middleware.
    res.sendFile(indexHtml, (error?: Error) => {
      if (error) next();
    });
  });
  return { kind: 'served', indexHtml };
}

/* ----------------------------------------------------------------- metadata */

/** One file's identity, recorded from stat only — contents are never read. */
export interface FileFingerprint {
  readonly path: string;
  readonly exists: boolean;
  readonly sizeBytes?: number;
  readonly mtimeMs?: number;
  readonly sha256?: string;
}

/**
 * Record a file's identity *without reading its contents into the harness*.
 *
 * The hash streams the file through `createHash`, so no key material is copied
 * into a buffer this process can print. Callers log the digest, never the bytes.
 */
export async function fingerprintFile(filePath: string): Promise<FileFingerprint> {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return { path: filePath, exists: false };
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      createReadStream(filePath)
        .on('data', (chunk: string | Buffer) => {
          hash.update(chunk as Buffer);
        })
        .on('error', reject)
        .on('end', () => resolve());
    });
    return {
      path: filePath,
      exists: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: hash.digest('hex'),
    };
  } catch {
    return { path: filePath, exists: false };
  }
}

/** A directory's identity from stat only — used for the run dir and agent dir. */
export function describeDirectory(dirPath: string): { path: string; exists: boolean; mode?: string } {
  try {
    const stat = statSync(dirPath);
    return { path: dirPath, exists: stat.isDirectory(), mode: (stat.mode & 0o777).toString(8) };
  } catch {
    return { path: dirPath, exists: false };
  }
}
