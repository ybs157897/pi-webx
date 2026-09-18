import { statSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Request, Response, Router } from 'express';
import {
  PI_THINKING_LEVELS,
  type CommandResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ListSessionsResponse,
  type ListStoredSessionsResponse,
  type PickDirectoryResponse,
  type PiCommandEnvelope,
  type PiThinkingLevel,
} from '../src/shared/protocol';
import { buildServerConfig } from './config';
import { DirectoryPickerUnsupportedError, pickNativeDirectory } from './directory-picker';
import { ModelCatalogError, buildModelCatalog, saveDefaultModelSelection } from './model-catalog';
import { ModelDiscoveryError, assertPublicHttpUrl, discoverModels } from './model-discovery';
import {
  ModelConfigError,
  deleteModel as deleteModelEntry,
  deleteProvider as deleteProviderEntry,
  describeModelConfig,
  upsertModel as upsertModelEntry,
  upsertProvider as upsertProviderEntry,
} from './models-config';
import { GitError, checkoutBranch, readGitBranches } from './git';
import { HostError, PiHost } from './pi/host';
import {
  ProviderError,
  listProviders,
  removeProviderCredential,
  setProviderCredential,
} from './providers';
import type { CredentialWriteResponse, ListProvidersResponse } from '../src/shared/providers';
import { clampStoredLimit, listStoredSessions, recentStoredCwds, sessionsRoot } from './stored-sessions';

/** Upper bound on a request body; large enough for pasted images. */
export const JSON_BODY_LIMIT = '1mb';

/**
 * Optional defaults applied to sessions created without an explicit provider or
 * model, so a bridge instance can be pinned to one working configuration.
 * Explicit request values always win.
 */
const DEFAULT_PROVIDER = process.env['PI_WEBX_PROVIDER']?.trim();
const DEFAULT_MODEL = process.env['PI_WEBX_MODEL']?.trim();

/**
 * Every command pi documents in docs/rpc.md. The `PiCommand` union in the
 * shared protocol models the subset the UI drives; the server accepts the full
 * documented set so newer commands can be proxied without a wire change.
 */
const KNOWN_COMMANDS = new Set<string>([
  'prompt',
  'steer',
  'follow_up',
  'abort',
  'clear_queue',
  'new_session',
  'get_state',
  'get_messages',
  'set_model',
  'cycle_model',
  'get_available_models',
  'set_thinking_level',
  'cycle_thinking_level',
  'get_available_thinking_levels',
  'set_steering_mode',
  'set_follow_up_mode',
  'compact',
  'set_auto_compaction',
  'set_auto_retry',
  'abort_retry',
  'bash',
  'abort_bash',
  'get_session_stats',
  'get_commands',
  'get_tools',
  'set_tools',
  'set_session_name',
  'extension_ui_response',
  'switch_session',
  'export_html',
  'fork',
  'clone',
  'get_fork_messages',
  'get_entries',
  'get_tree',
  'get_last_assistant_text',
]);

export function createApiRouter(manager: PiHost): Router {
  const router = express.Router();

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  router.get('/config', async (_req: Request, res: Response) => {
    const storedCwds = await recentStoredCwds().catch(() => []);
    res.json(buildServerConfig(storedCwds));
  });

  /**
   * Open the OS directory chooser on the bridge host and report what it returned.
   *
   * A cancel is a normal outcome (`path: null`) and has to stay distinguishable
   * from a failure: "the user changed their mind" must not raise an error
   * surface, while "this host has no picker" must. The dialog lives on the
   * server, so the path it yields is a real directory there — the client never
   * has to guess about a machine it cannot see.
   */
  router.post('/workspace/pick', async (req: Request, res: Response) => {
    const body: unknown = req.body;
    const initial = isRecord(body) && typeof body['initial'] === 'string' ? body['initial'] : undefined;
    const controller = new AbortController();
    // A dialog outlives the request that raised it by design, so the connection
    // is its lifetime: a tab that goes away must not leave a chooser on screen.
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const picked = await pickNativeDirectory({ initial, signal: controller.signal });
      const payload: PickDirectoryResponse = { path: picked };
      res.json(payload);
    } catch (error) {
      if (controller.signal.aborted) return;
      sendError(
        res,
        error instanceof DirectoryPickerUnsupportedError ? 501 : 500,
        `cannot open the system directory picker: ${errorMessage(error)}`,
      );
    }
  });

  router.get('/stored-sessions', async (req: Request, res: Response) => {
    const cwdRaw = typeof req.query.cwd === 'string' ? req.query.cwd.trim() : '';
    if (cwdRaw.length > 0 && !path.isAbsolute(cwdRaw)) {
      return sendError(res, 400, 'query parameter "cwd" must be an absolute path');
    }

    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const sessions = await listStoredSessions({
      cwd: cwdRaw.length > 0 ? cwdRaw : undefined,
      limit: clampStoredLimit(limitRaw),
    });

    const payload: ListStoredSessionsResponse = { sessions };
    res.json(payload);
  });

  /* ------------------------------------------------ pi models.json editing */

  /**
   * Re-read `models.json` into the shared runtime after a config write.
   *
   * pi reads the file once per process — `ModelConfig.load()` runs when the
   * runtime is created — so a provider or model the editor adds stays invisible
   * to the picker (and to every session that resolves against the runtime) until
   * the bridge restarts. That is the "配置好了却选不到" failure: the file says one
   * thing, the running deployment answers with its boot-time snapshot.
   *
   * `allowNetwork: false` keeps this a local re-read. The flag exists because
   * `refresh()` can also refetch catalogs over the network, which a file edit
   * does not ask for and this bridge does not do to the user.
   */
  async function reloadModelsConfig(): Promise<void> {
    try {
      const runtime = await manager.getModelRuntime();
      await runtime.refresh({ allowNetwork: false });
    } catch (error) {
      // The file is already written. A runtime that cannot be re-read is a stale
      // catalog, not a failed save, so it is reported and stepped over rather
      // than answering an error for an edit that did land.
      console.warn(
        '[pi-webx] models.json 重新载入失败：',
        error instanceof Error ? error.message : error,
      );
    }
  }

  router.get('/models-config', (_req: Request, res: Response) => {
    res.json(describeModelConfig());
  });

  router.post('/models-config/discover', async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    try {
      // The base URL is validated at the entry (protocol + literal host) before
      // it flows anywhere; discovery re-validates and DNS-checks at fetch time.
      const baseUrl = optionalString(body['baseUrl']);
      const providerId = optionalString(body['providerId']);
      const apiKey = apiKeyFormValue(body['apiKey']);
      const models = await discoverModels({
        ...(baseUrl === undefined ? {} : { baseUrl: assertPublicHttpBaseUrl(baseUrl) }),
        ...(providerId === undefined ? {} : { providerId }),
        ...(apiKey === undefined ? {} : { apiKey }),
      });
      res.json({ models });
    } catch (error) {
      sendModelDiscoveryError(res, error);
    }
  });

  router.put('/models-config/providers/:id', async (req: Request, res: Response) => {
    try {
      const payload = await upsertProviderEntry(paramId(req), req.body as Record<string, unknown>);
      await reloadModelsConfig();
      res.json(payload);
    } catch (error) {
      sendModelConfigError(res, error);
    }
  });

  router.delete('/models-config/providers/:id', async (req: Request, res: Response) => {
    try {
      const payload = await deleteProviderEntry(paramId(req));
      await reloadModelsConfig();
      res.json(payload);
    } catch (error) {
      sendModelConfigError(res, error);
    }
  });

  router.put('/models-config/providers/:id/models/:modelId', async (req: Request, res: Response) => {
    try {
      const body = { ...(req.body as Record<string, unknown>), id: String(req.params['modelId'] ?? '') };
      const payload = await upsertModelEntry(paramId(req), body);
      await reloadModelsConfig();
      res.json(payload);
    } catch (error) {
      sendModelConfigError(res, error);
    }
  });

  router.delete('/models-config/providers/:id/models/:modelId', async (req: Request, res: Response) => {
    try {
      const payload = await deleteModelEntry(paramId(req), String(req.params['modelId'] ?? ''));
      await reloadModelsConfig();
      res.json(payload);
    } catch (error) {
      sendModelConfigError(res, error);
    }
  });

  /* ------------------------------------------------------------------ git */

  /**
   * The workspace's branch and the branches it could switch to.
   *
   * Read-only and request-scoped: no watcher, no cache, nothing to invalidate —
   * the composer asks again when the workspace changes or a run finishes.
   */
  router.get('/git', async (req: Request, res: Response) => {
    const cwdRaw = typeof req.query['cwd'] === 'string' ? req.query['cwd'].trim() : '';
    if (cwdRaw.length === 0 || !path.isAbsolute(cwdRaw)) {
      return sendError(res, 400, 'query parameter "cwd" must be an absolute path');
    }
    try {
      res.json(await readGitBranches(cwdRaw));
    } catch (error) {
      sendGitError(res, error);
    }
  });

  /** Switch the workspace to one of its own local branches. */
  router.post('/git/checkout', async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    const cwdRaw = optionalString(body['cwd']);
    if (cwdRaw === undefined || !path.isAbsolute(cwdRaw)) {
      return sendError(res, 400, 'cwd must be an absolute path');
    }
    try {
      const branch = typeof body['branch'] === 'string' ? body['branch'] : '';
      res.json(await checkoutBranch(cwdRaw, branch));
    } catch (error) {
      sendGitError(res, error);
    }
  });

  /* ------------------------------------------------- model catalog / default */

  /**
   * The picker's catalog. Needs no session: it reads the shared model runtime
   * and pi's settings, so it answers in the detached state a lazy session
   * starts in — which is exactly when a user needs to choose a model.
   */
  router.get('/models', async (req: Request, res: Response) => {
    const cwdRaw = typeof req.query.cwd === 'string' ? req.query.cwd.trim() : '';
    if (cwdRaw.length > 0 && !path.isAbsolute(cwdRaw)) {
      return sendError(res, 400, 'query parameter "cwd" must be an absolute path');
    }
    try {
      const runtime = await manager.getModelRuntime();
      res.json(await buildModelCatalog(runtime, cwdRaw.length > 0 ? cwdRaw : process.cwd()));
    } catch (error) {
      sendModelCatalogError(res, error);
    }
  });

  /**
   * The picker saving its choice as the deployment default — dsh's
   * `agentDefaultModel.saveSelection()`. Without this the picker's choice died
   * with the session and the next session fell back to settings.json.
   */
  router.put('/models/default', async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    const cwdRaw = optionalString(body['cwd']);
    if (cwdRaw !== undefined && !path.isAbsolute(cwdRaw)) {
      return sendError(res, 400, 'cwd must be an absolute path');
    }
    try {
      const runtime = await manager.getModelRuntime();
      const payload = await saveDefaultModelSelection(runtime, cwdRaw ?? process.cwd(), {
        provider: typeof body['provider'] === 'string' ? body['provider'] : '',
        model: typeof body['model'] === 'string' ? body['model'] : '',
        ...(typeof body['thinkingLevel'] === 'string'
          ? { thinkingLevel: body['thinkingLevel'] as PiThinkingLevel }
          : body['thinkingLevel'] === null
            ? { thinkingLevel: null }
            : {}),
      });
      res.json(payload);
    } catch (error) {
      sendModelCatalogError(res, error);
    }
  });

  /* ------------------------------------------------ providers and credentials */

  /**
   * Every provider the runtime knows, with its credential state. Read-only and
   * session-independent, like the catalog beside it.
   */
  router.get('/providers', async (_req: Request, res: Response) => {
    try {
      const runtime = await manager.getModelRuntime();
      const payload: ListProvidersResponse = {
        providers: await listProviders(runtime, declaredProviderIds()),
      };
      res.json(payload);
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  /**
   * Store an API key through the provider's own login flow. pi persists it
   * through its locked credential store, so the CLI sees the same key.
   */
  router.put('/providers/:id/credential', async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    try {
      const runtime = await manager.getModelRuntime();
      const payload: CredentialWriteResponse = {
        providers: await setProviderCredential(
          runtime,
          paramId(req),
          { apiKey: typeof body['apiKey'] === 'string' ? body['apiKey'] : '' },
          declaredProviderIds(),
        ),
      };
      res.json(payload);
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  /** Remove the stored credential for one provider. */
  router.delete('/providers/:id/credential', async (req: Request, res: Response) => {
    try {
      const runtime = await manager.getModelRuntime();
      const payload: CredentialWriteResponse = {
        providers: await removeProviderCredential(runtime, paramId(req), declaredProviderIds()),
      };
      res.json(payload);
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  router.post('/sessions', async (req: Request, res: Response) => {
    const parsed = parseCreateSessionRequest(req.body);
    if (!parsed.ok) {
      return sendError(res, 400, parsed.error);
    }

    // Resuming a log that is already hosted hands back the session hosting it.
    // Two hosts on one log would append to the same file, and the caller asked
    // to open that conversation — not for a second copy of it.
    if (parsed.value.sessionPath !== undefined) {
      const path = parsed.value.sessionPath;
      const hosted = manager.list().find((session) => session.sessionFile === path);
      if (hosted !== undefined) {
        const payload: CreateSessionResponse = { session: manager.summary(hosted) };
        return res.json(payload);
      }
    }

    try {
      const session = await manager.create(parsed.value);
      const payload: CreateSessionResponse = { session: manager.summary(session) };
      res.status(201).json(payload);
    } catch (error) {
      if (error instanceof HostError) {
        return sendError(res, error.status, error.message);
      }
      return sendError(res, 500, errorMessage(error));
    }
  });

  /**
   * Fork a transcript into a new session — dsh's `分叉会话`, which both its live
   * and stored rows offer. The source is either a hosted session (its own file)
   * or a stored transcript, whose path must sit inside pi's session store: the
   * same containment rule the delete route uses, because this is another
   * operation the client addresses by path.
   */
  router.post('/sessions/fork', async (req: Request, res: Response) => {
    const body = isRecord(req.body) ? req.body : {};
    const sessionId = optionalString(body['sessionId']);
    const rawPath = optionalString(body['path']);
    const cwdRaw = optionalString(body['cwd']);
    if (cwdRaw !== undefined && !path.isAbsolute(cwdRaw)) {
      return sendError(res, 400, 'cwd must be an absolute path');
    }

    let source: string | undefined;
    if (sessionId !== undefined) {
      const hosted = manager.get(sessionId);
      if (!hosted) return sendError(res, 404, `unknown session: ${sessionId}`);
      if (hosted.sessionFile === null) {
        return sendError(res, 400, '该会话没有转录文件（未持久化），无法分叉');
      }
      source = hosted.sessionFile;
    } else if (rawPath !== undefined) {
      if (!isInsideSessionsRoot(rawPath)) {
        return sendError(res, 400, '只能分叉 pi 会话目录里的转录文件');
      }
      source = path.resolve(rawPath.trim());
    }
    if (source === undefined) {
      return sendError(res, 400, 'sessionId 与 path 至少提供一个');
    }

    try {
      const session = await manager.fork({
        source,
        ...(cwdRaw === undefined ? {} : { cwd: cwdRaw }),
      });
      const payload: CreateSessionResponse = { session: manager.summary(session) };
      res.status(201).json(payload);
    } catch (error) {
      if (error instanceof HostError) {
        return sendError(res, error.status, error.message);
      }
      sendError(res, 500, errorMessage(error));
    }
  });

  router.get('/sessions', (_req: Request, res: Response) => {
    const payload: ListSessionsResponse = {
      sessions: manager.list().map((session) => manager.summary(session)),
    };
    res.json(payload);
  });

  router.post('/sessions/:id/command', async (req: Request, res: Response) => {
    const id = paramId(req);

    if (!isRecord(req.body)) {
      return sendError(res, 400, 'request body must be a JSON object');
    }
    const command = req.body.command;
    if (!isRecord(command)) {
      return sendError(res, 400, 'body.command must be an object');
    }
    const type = command.type;
    if (typeof type !== 'string' || !KNOWN_COMMANDS.has(type)) {
      return sendError(
        res,
        400,
        `unknown pi command type: ${typeof type === 'string' ? type : '(missing or not a string)'}`,
      );
    }
    if (!manager.get(id)) {
      return sendError(res, 404, `unknown session: ${id}`);
    }

    // Validated above: the extra documented commands are not part of the
    // `PiCommand` union yet, so the envelope is widened after the type check.
    const envelope = command as unknown as PiCommandEnvelope;

    try {
      const response = await manager.command(id, envelope);
      const payload: CommandResponse = { response };
      res.json(payload);
    } catch (error) {
      // The child died while the command was in flight: keep the command wire
      // shape instead of a 5xx so the client can render the failure in place.
      const payload: CommandResponse = {
        response: {
          type: 'response',
          command: type,
          success: false,
          error: errorMessage(error),
        },
      };
      res.json(payload);
    }
  });

  return router;
}

type ParseResult =
  | { ok: true; value: CreateSessionRequest }
  | { ok: false; error: string };

function parseCreateSessionRequest(raw: unknown): ParseResult {
  if (!isRecord(raw)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }

  const value: CreateSessionRequest = {};

  if (raw.cwd !== undefined) {
    const cwd = requireString(raw.cwd, 'cwd');
    if (typeof cwd !== 'string') return { ok: false, error: cwd.error };
    if (!path.isAbsolute(cwd)) return { ok: false, error: 'cwd must be an absolute path' };
    if (!isDirectory(cwd)) {
      return { ok: false, error: `cwd is not an existing directory: ${cwd}` };
    }
    value.cwd = cwd;
  }

  if (raw.noSession !== undefined) {
    if (typeof raw.noSession !== 'boolean') {
      return { ok: false, error: 'noSession must be a boolean' };
    }
    value.noSession = raw.noSession;
  }

  for (const key of ['name', 'provider', 'model', 'sessionPath'] as const) {
    const candidate = raw[key];
    if (candidate === undefined) continue;
    const checked = requireString(candidate, key);
    if (typeof checked !== 'string') return { ok: false, error: checked.error };
    value[key] = checked;
  }

  if (value.provider === undefined && DEFAULT_PROVIDER) value.provider = DEFAULT_PROVIDER;
  if (value.model === undefined && DEFAULT_MODEL) value.model = DEFAULT_MODEL;

  if (raw.thinking !== undefined) {
    const thinking = requireString(raw.thinking, 'thinking');
    if (typeof thinking !== 'string') return { ok: false, error: thinking.error };
    if (!isThinkingLevel(thinking)) {
      return {
        ok: false,
        error: `thinking must be one of: ${PI_THINKING_LEVELS.join(', ')}`,
      };
    }
    value.thinking = thinking;
  }

  if (raw.extraArgs !== undefined) {
    if (!Array.isArray(raw.extraArgs)) {
      return { ok: false, error: 'extraArgs must be an array of strings' };
    }
    for (const extra of raw.extraArgs) {
      if (typeof extra !== 'string') {
        return { ok: false, error: 'extraArgs must be an array of strings' };
      }
    }
    value.extraArgs = raw.extraArgs as string[];
  }

  // The browser's tool preset. Builtin names only: the host merges extension
  // tools in, and a resumed session's own record wins over this anyway.
  if (raw.toolNames !== undefined) {
    if (!Array.isArray(raw.toolNames)) {
      return { ok: false, error: 'toolNames must be an array of strings' };
    }
    for (const name of raw.toolNames) {
      if (typeof name !== 'string') {
        return { ok: false, error: 'toolNames must be an array of strings' };
      }
    }
    value.toolNames = raw.toolNames as string[];
  }

  return { ok: true, value };
}

/** Local, synchronous directory check: the spawn would fail confusingly otherwise. */
function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function requireString(value: unknown, field: string): string | { error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: `${field} must be a non-empty string` };
  }
  return value;
}

function isThinkingLevel(value: string): value is PiThinkingLevel {
  return (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

function paramId(req: Request): string {
  const raw = req.params['id'];
  return typeof raw === 'string' ? raw : '';
}

function sendError(res: Response, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: message });
}

function sendModelConfigError(res: Response, error: unknown): void {
  if (error instanceof ModelConfigError) {
    sendError(res, error.status, error.message);
    return;
  }
  sendError(res, 500, errorMessage(error));
}

function sendGitError(res: Response, error: unknown): void {
  if (error instanceof GitError) {
    sendError(res, error.status, error.message);
    return;
  }
  sendError(res, 500, errorMessage(error));
}

function sendModelDiscoveryError(res: Response, error: unknown): void {
  if (error instanceof ModelDiscoveryError) {
    sendError(res, error.status, error.message);
    return;
  }
  sendModelConfigError(res, error);
}

function sendModelCatalogError(res: Response, error: unknown): void {
  if (error instanceof ModelCatalogError) {
    sendError(res, error.status, error.message);
    return;
  }
  sendError(res, 500, errorMessage(error));
}

function sendProviderError(res: Response, error: unknown): void {
  if (error instanceof ProviderError) {
    sendError(res, error.status, error.message);
    return;
  }
  sendError(res, 500, errorMessage(error));
}

/**
 * Provider ids owned by `models.json` — the ones the custom-provider editor may
 * edit. A malformed file yields none rather than failing the whole list: the
 * catalog providers are still worth showing.
 */
function declaredProviderIds(): string[] {
  try {
    return Object.keys(describeModelConfig().providers);
  } catch {
    return [];
  }
}

/** Optional free-form string field: blank means "not supplied". */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** `body.apiKey` is the editor form's shape; a blank value falls back upstream. */
function apiKeyFormValue(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return optionalString(value['value']);
}

/**
 * Entry-visible URL admission for discovery: protocol + literal-host checks
 * (no DNS yet), returning the trailing-slash-normalized URL on success.
 */
function assertPublicHttpBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  assertPublicHttpUrl(trimmed);
  return trimmed;
}

/**
 * Entry-visible containment for stored-session deletion: the candidate must
 * resolve strictly inside pi's sessions directory. The callee re-runs its own
 * (stricter, format-aware) checks; this keeps the boundary at the route.
 */
function isInsideSessionsRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate.trim());
  const relative = path.relative(sessionsRoot(), resolved);
  if (relative.length === 0) return false;
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
