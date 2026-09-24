/**
 * HTTP management surface for sub-agent definitions.
 *
 * Mounted once from `server/routes.ts` as `/api/agent-definitions`. Three rules
 * shape this file:
 *
 *   1. **Management is HTTP-only.** There is no `PiCommand` variant and no model
 *      tool that creates, edits or deletes a definition. A model can *dispatch*
 *      an agent (a later phase); it can never author one. The checks assert this
 *      by construction: nothing here imports the command vocabulary.
 *   2. **CSRF hygiene, not authentication.** A browser page on another origin
 *      must not be able to drive these writes through a form or a fetch that
 *      escapes the same-origin policy, so cross-site callers are refused and
 *      writes require `application/json` (a simple-form POST cannot set that
 *      content type). A caller with no `Origin` at all — a native client, curl,
 *      the tests below — is allowed: this is a loopback, single-user bridge, and
 *      inventing a token would be security theatre rather than access control.
 *      Same-UID processes are *not* isolated from each other.
 *   3. **Errors are uniform.** Every failure is `{ error: string }` with 400,
 *      404, 409, 500 — or 403 for the cross-site refusal above.
 */

import express from 'express';
import type { Request, Response, Router } from 'express';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';

import type { AgentToolOption, AgentToolsResponse } from '../src/shared/agent-definitions';
import {
  AgentDefinitionError,
  RESTRICTED_AGENT_TOOL_DISPLAY_NAMES,
  type AgentDefinitionStore,
  isRestrictedAgentTool,
} from './agent-definitions';
import { buildModelCatalog } from './model-catalog';
import type { PiHost } from './pi/host';

export interface AgentDefinitionsRouterDeps {
  store: AgentDefinitionStore;
  host: PiHost;
  /**
   * Whether a `fixed` provider/model is currently visible and routable.
   *
   * Optional so a test can exercise the write path without a model runtime and
   * without reading the real agent directory; production leaves it unset and the
   * check goes through the same `buildModelCatalog` the picker uses.
   */
  resolveModel?: (providerId: string, modelId: string) => Promise<boolean>;
}

/**
 * The builtin tool names, as pi documents them.
 *
 * Classification uses this *known* set rather than "whatever the factories
 * built": a factory can fail on a platform (no PowerShell on macOS) and a
 * session tool must still be labelled `builtin`, not demoted to `extension`
 * because the catalogue could not construct one definition.
 */
const BUILTIN_TOOL_NAMES: readonly string[] = [
  'read',
  'write',
  'edit',
  'bash',
  'powershell',
  'grep',
  'find',
  'ls',
];

/** The builtin tools pi ships, as definition factories (no session, no model). */
const BUILTIN_TOOL_FACTORIES = [
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
] as const;

/* ------------------------------------------------------------------- helpers */

function sendError(res: Response, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: message });
}

function sendAgentDefinitionError(res: Response, error: unknown): void {
  if (error instanceof AgentDefinitionError) {
    sendError(res, error.status, error.message);
    return;
  }
  sendError(res, 500, error instanceof Error ? error.message : String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function paramId(req: Request): string {
  const raw = req.params['id'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new AgentDefinitionError(400, '缺少智能体 id');
  }
  return raw;
}

/**
 * Explicit extra origins that may drive writes, from `PI_WEBX_ALLOWED_ORIGIN`
 * (comma-separated, exact `scheme://host[:port]`).
 *
 * This exists so a proxied or test deployment can be allowed *deliberately*. It
 * is never populated from request headers: trusting something a caller sends
 * (`X-Forwarded-Host` and friends) would turn the check into a formality, and
 * nothing here quietly widens same-origin for everyone.
 */
function configuredAllowedOrigins(): string[] {
  const raw = process.env['PI_WEBX_ALLOWED_ORIGIN'];
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Refuse cross-site writers.
 *
 * `Origin` is compared against the request's own `Host`, so a page served from a
 * different origin cannot address this bridge even though it can reach
 * 127.0.0.1. This is safe through the dev proxy because `vite.config.ts` sets
 * `changeOrigin: false`: the Host the bridge sees is the browser's
 * `127.0.0.1:5173`, which is exactly the Origin the browser sends. A deployment
 * whose proxy *does* rewrite Host must name the real origin in
 * `PI_WEBX_ALLOWED_ORIGIN` rather than have this check guessed at.
 *
 * DNS names are case-insensitive, so the comparison folds case on both sides —
 * `URL` already lowercases its host, while a `Host` header arrives as written
 * (`Host: LocalHost:8787` from a hand-written client or a preserving proxy).
 * Comparing them raw refused same-origin callers. The **port is still part of
 * the comparison**: only the case is relaxed, never the port or the scheme the
 * origin names.
 *
 * `X-Forwarded-Host` is deliberately never consulted: it is caller-supplied, so
 * trusting it would turn this check into a formality.
 *
 * `PI_WEBX_ALLOWED_ORIGIN` stays an **exact** match list (no path containment,
 * no wildcards); an operator listing a proxied origin writes it the way the
 * browser sends it, i.e. with a lowercase host.
 *
 * `Sec-Fetch-Site: cross-site` is the second opinion for browsers that send it;
 * the header's absence (native caller, curl, tests) is not a refusal.
 */
function isCrossSite(req: Request): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite.trim().toLowerCase() === 'cross-site') {
    return true;
  }
  const origin = req.headers['origin'];
  if (typeof origin !== 'string' || origin.trim().length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // An unparseable Origin is not something a same-origin caller sends.
    return true;
  }
  const normalized = parsed.origin;
  if (configuredAllowedOrigins().includes(normalized)) return false;
  const host = req.headers['host'];
  if (typeof host !== 'string' || host.length === 0) return true;
  return parsed.host.toLowerCase() !== host.trim().toLowerCase();
}

function guardWrite(req: Request, res: Response, next: () => void): void {
  if (isCrossSite(req)) {
    sendError(res, 403, '拒绝跨站写入：该管理接口只接受同源或本机原生调用。');
    return;
  }
  const contentType = req.headers['content-type'];
  const mediaType =
    typeof contentType === 'string' ? contentType.split(';')[0]?.trim().toLowerCase() : undefined;
  if (mediaType !== 'application/json') {
    sendError(res, 400, '写入请求必须使用 application/json。');
    return;
  }
  next();
}

/* -------------------------------------------------------------- tool catalog */

function builtinToolOptions(cwd: string): AgentToolOption[] {
  const options: AgentToolOption[] = [];
  for (const factory of BUILTIN_TOOL_FACTORIES) {
    try {
      const definition = factory(cwd);
      options.push({
        name: definition.name,
        description: typeof definition.description === 'string' ? definition.description : '',
        source: 'builtin',
      });
    } catch {
      // A platform that cannot build one builtin (no PowerShell on macOS, say)
      // must still get a catalog for the others.
    }
  }
  return options;
}

function sortAndDedupe(options: readonly AgentToolOption[]): AgentToolOption[] {
  const byName = new Map<string, AgentToolOption>();
  for (const option of options) {
    if (isRestrictedAgentTool(option.name)) continue;
    if (!byName.has(option.name)) byName.set(option.name, option);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

/* ------------------------------------------------------- fixed-model check */

/**
 * A `fixed` model must be one this bridge can actually route to right now.
 *
 * Checked *before* the store writes, so a definition never lands describing a
 * model the user cannot select — the failure mode the shared contract calls out
 * as "an error, never a silent fallback". `inherit` needs no check: it follows
 * whatever the parent runs.
 */
async function fixedModelIsRoutable(
  host: PiHost,
  providerId: string,
  modelId: string,
): Promise<boolean> {
  const runtime = await host.getModelRuntime();
  let catalog;
  try {
    catalog = await buildModelCatalog(runtime, process.cwd());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentDefinitionError(500, `读取模型目录失败：${message}`);
  }
  return catalog.groups.some(
    (group) =>
      group.provider === providerId &&
      group.models.some((model) => model.id === modelId && model.provider === providerId),
  );
}

function fixedModelOf(value: unknown): { providerId: string; modelId: string } | undefined {
  if (!isRecord(value) || value['mode'] !== 'fixed') return undefined;
  const providerId = value['providerId'];
  const modelId = value['modelId'];
  if (typeof providerId !== 'string' || typeof modelId !== 'string') return undefined;
  return { providerId, modelId };
}

/* -------------------------------------------------------------------- router */

export function createAgentDefinitionsRouter(deps: AgentDefinitionsRouterDeps): Router {
  const { store, host } = deps;
  const router = express.Router();

  const routableModel = deps.resolveModel ?? ((providerId, modelId) => fixedModelIsRoutable(host, providerId, modelId));

  /** Reject a `fixed` model the bridge cannot route, before anything is written. */
  async function assertFixedModel(fixed: { providerId: string; modelId: string }): Promise<void> {
    const ok = await routableModel(fixed.providerId, fixed.modelId);
    if (!ok) {
      throw new AgentDefinitionError(
        400,
        `模型不可用：${fixed.providerId}/${fixed.modelId}（不在当前可见且可用的模型目录中）`,
      );
    }
  }

  /**
   * The tool catalog the settings UI offers for `selected` mode.
   *
   * With `?sessionId`, extension tools become visible — they only exist per
   * session — and the answer is flagged `sessionScoped`. Without it the catalog
   * is the SDK's builtin set, which needs no session and no model call. A name
   * the UI cannot prove exists is still saveable: the file carries the intent,
   * and the runtime checks it against the live session before dispatch.
   */
  router.get('/tools', async (req: Request, res: Response) => {
    try {
      const rawSessionId = req.query['sessionId'];
      const sessionId =
        typeof rawSessionId === 'string' && rawSessionId.trim().length > 0
          ? rawSessionId.trim()
          : undefined;
      if (sessionId === undefined) {
        res.json({
          tools: sortAndDedupe(builtinToolOptions(process.cwd())),
          sessionScoped: false,
          excluded: [...RESTRICTED_AGENT_TOOL_DISPLAY_NAMES],
        } satisfies AgentToolsResponse);
        return;
      }
      const hosted = host.get(sessionId);
      if (hosted === undefined) {
        sendError(res, 404, `没有这个会话：${sessionId}`);
        return;
      }
      const builtinNames = new Set(BUILTIN_TOOL_NAMES);
      const tools: AgentToolOption[] = [];
      for (const info of hosted.session.getAllTools()) {
        const name = typeof info.name === 'string' ? info.name.trim() : '';
        if (name.length === 0) continue;
        tools.push({
          name,
          description: typeof info.description === 'string' ? info.description : '',
          source: builtinNames.has(name) ? 'builtin' : 'extension',
        });
      }
      res.json({
        tools: sortAndDedupe(tools),
        sessionScoped: true,
        excluded: [...RESTRICTED_AGENT_TOOL_DISPLAY_NAMES],
      } satisfies AgentToolsResponse);
    } catch (error) {
      sendAgentDefinitionError(res, error);
    }
  });

  router.get('/', async (_req: Request, res: Response) => {
    try {
      res.json(await store.read());
    } catch (error) {
      sendAgentDefinitionError(res, error);
    }
  });

  router.post('/', guardWrite, async (req: Request, res: Response) => {
    try {
      // `model` hangs off the definition (POST) or the patch (PATCH); reading the
      // wrong nesting level here would silently skip the check entirely.
      const definition = isRecord(req.body) ? req.body['definition'] : undefined;
      const fixed = isRecord(definition) ? fixedModelOf(definition['model']) : undefined;
      if (fixed !== undefined) {
        await assertFixedModel(fixed);
      }
      res.status(201).json(await store.create(req.body));
    } catch (error) {
      sendAgentDefinitionError(res, error);
    }
  });

  router.patch('/:id', guardWrite, async (req: Request, res: Response) => {
    try {
      const id = paramId(req);
      const patch = isRecord(req.body) ? req.body['patch'] : undefined;
      const fixed = isRecord(patch) ? fixedModelOf(patch['model']) : undefined;
      if (fixed !== undefined) {
        await assertFixedModel(fixed);
      }
      res.json(await store.update(id, req.body));
    } catch (error) {
      sendAgentDefinitionError(res, error);
    }
  });

  router.delete('/:id', guardWrite, async (req: Request, res: Response) => {
    try {
      const id = paramId(req);
      res.json(await store.delete(id, req.body));
    } catch (error) {
      sendAgentDefinitionError(res, error);
    }
  });

  return router;
}
