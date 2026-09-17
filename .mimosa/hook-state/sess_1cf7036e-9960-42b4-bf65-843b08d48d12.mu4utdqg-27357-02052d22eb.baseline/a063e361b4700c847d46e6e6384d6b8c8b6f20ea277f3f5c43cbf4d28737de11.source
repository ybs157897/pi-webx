import { promises as fsp, statSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Request, Response, Router } from 'express';
import {
  PI_THINKING_LEVELS,
  type CommandResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type FsListResponse,
  type ListSessionsResponse,
  type ListStoredSessionsResponse,
  type PiCommandEnvelope,
  type PiThinkingLevel,
  type ServerFrame,
} from '../src/shared/protocol';
import { buildServerConfig } from './config';
import {
  ModelConfigError,
  deleteModel as deleteModelEntry,
  deleteProvider as deleteProviderEntry,
  describeModelConfig,
  upsertModel as upsertModelEntry,
  upsertProvider as upsertProviderEntry,
} from './models-config';
import {
  HostError,
  PiHost,
  type HostSubscriber,
} from './pi/host';
import { clampStoredLimit, deleteStoredSession, listStoredSessions, recentStoredCwds, StoredSessionError } from './stored-sessions';

/** SSE keep-alive cadence. */
const HEARTBEAT_MS = 15_000;
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

  router.get('/fs/list', async (req: Request, res: Response) => {
    const raw = typeof req.query.path === 'string' ? req.query.path : '';
    if (raw.trim().length === 0) {
      return sendError(res, 400, 'query parameter "path" is required');
    }
    if (!path.isAbsolute(raw)) {
      return sendError(res, 400, 'path must be an absolute path');
    }

    const dir = path.resolve(raw);

    let stats;
    try {
      stats = await fsp.stat(dir);
    } catch {
      return sendError(res, 400, `path does not exist: ${dir}`);
    }
    if (!stats.isDirectory()) {
      return sendError(res, 400, `not a directory: ${dir}`);
    }

    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      return sendError(res, 400, `cannot read directory: ${errorMessage(error)}`);
    }

    const entries = dirents
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => ({ name: dirent.name, path: path.join(dir, dirent.name) }))
      .sort((a, b) => compareNames(a.name, b.name));

    const parent = path.dirname(dir);
    const payload: FsListResponse = {
      path: dir,
      parent: parent === dir ? null : parent,
      entries,
    };
    res.json(payload);
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

  router.delete('/stored-sessions', async (req: Request, res: Response) => {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      // deleteStoredSession is async: without the await its guard errors would
      // surface as unhandled rejections after the 200 has already been sent.
      await deleteStoredSession(target);
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof StoredSessionError) {
        return sendError(res, error.status, error.message);
      }
      sendError(res, 500, errorMessage(error));
    }
  });

  /* ------------------------------------------------ pi models.json editing */

  router.get('/models-config', (_req: Request, res: Response) => {
    res.json(describeModelConfig());
  });

  router.put('/models-config/providers/:id', async (req: Request, res: Response) => {
    try {
      const payload = await upsertProviderEntry(paramId(req), req.body as Record<string, unknown>);
      res.json(payload);
    } catch (error) {
      sendModelConfigError(res, error);
    }
  });

  router.delete('/models-config/providers/:id', async (req: Request, res: Response) => {
    try {
      res.json(await deleteProviderEntry(paramId(req)));
    } catch (error) {
      sendModelConfigError(res, error);
    }
  });

  router.put('/models-config/providers/:id/models/:modelId', async (req: Request, res: Response) => {
    try {
      const body = { ...(req.body as Record<string, unknown>), id: String(req.params['modelId'] ?? '') };
      res.json(await upsertModelEntry(paramId(req), body));
    } catch (error) {
      sendModelConfigError(res, error);
    }
  });

  router.delete('/models-config/providers/:id/models/:modelId', async (req: Request, res: Response) => {
    try {
      res.json(await deleteModelEntry(paramId(req), String(req.params['modelId'] ?? '')));
    } catch (error) {
      sendModelConfigError(res, error);
    }
  });

  router.post('/sessions', async (req: Request, res: Response) => {
    const parsed = parseCreateSessionRequest(req.body);
    if (!parsed.ok) {
      return sendError(res, 400, parsed.error);
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

  router.get('/sessions', (_req: Request, res: Response) => {
    const payload: ListSessionsResponse = {
      sessions: manager.list().map((session) => manager.summary(session)),
    };
    res.json(payload);
  });

  router.delete('/sessions/:id', async (req: Request, res: Response) => {
    const id = paramId(req);
    if (!(await manager.kill(id))) {
      return sendError(res, 404, `unknown session: ${id}`);
    }
    res.json({ ok: true });
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

  router.get('/sessions/:id/events', (req: Request, res: Response) => {
    const id = paramId(req);
    const session = manager.get(id);
    if (!session) {
      return sendError(res, 404, `unknown session: ${id}`);
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    const hello: ServerFrame = {
      t: 'hello',
      sessionId: session.id,
      pid: null,
      cwd: session.cwd,
      sessionFile: session.sessionFile,
      resumed: session.resumed,
    };
    res.write(`data: ${JSON.stringify(hello)}\n\n`);

    let heartbeat: NodeJS.Timeout | null = null;
    let detached = false;

    const detach = (): void => {
      if (detached) return;
      detached = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      manager.unsubscribe(session, subscriber);
    };

    const subscriber: HostSubscriber = {
      frame: (frame) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      },
      close: () => {
        detach();
        if (!res.writableEnded) res.end();
      },
    };

    manager.subscribe(session, subscriber);

    // Both events fire when the client goes away; detach() is idempotent.
    req.on('close', detach);
    res.on('close', detach);

    heartbeat = setInterval(() => {
      if (res.writableEnded) {
        detach();
        return;
      }
      res.write(': ping\n\n');
    }, HEARTBEAT_MS);
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

function compareNames(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
