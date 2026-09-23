/**
 * Test-only isolated server for the user-subagents integration.
 *
 * This is **not a product entry point**. `server/index.ts` stays the product
 * server; this file exists so one isolated instance can be started against a
 * throwaway `RUN_DIR`.
 *
 * ## Import order is load-bearing
 *
 * `PI_CODING_AGENT_DIR` is read at module scope by `server/models-config.ts`
 * (`CONFIG_PATH`) and by `PiHost`'s `modelsPath` field, and the SDK reads it
 * every time `createAgentSession` builds a resource loader. So the redirect has
 * to happen **before** `server/**` is loaded, and the real path has to be
 * captured **before** the redirect. Hence:
 *
 *   1. import this module's pure helpers (no process-wide path reads);
 *   2. capture the real agent dir with one SDK import;
 *   3. point `PI_CODING_AGENT_DIR` at `RUN_DIR/agent-dir` and create it;
 *   4. only now import `server/**`, which bakes the isolated path in.
 *
 * The model runtime is built from the **captured** real paths, never from the
 * redirected `getAgentDir()`: `modelsPath` stays the user's real read-only
 * `models.json` (so the custom `cmdc` provider definition survives) and the
 * credential adapter reads the real `auth.json`, while the model store and the
 * session directory live in `RUN_DIR`.
 *
 * What this buys: the isolated instance does not load the user's real
 * extensions, skills, or context files, and does not write into the real agent
 * directory. What it does not buy: confinement. The gate is a test guard, not a
 * sandbox for a process that already has the user's shell access.
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readStoredCredential } from '@earendil-works/pi-coding-agent';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import {
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_TEST_PORT,
  attachStaticAssets,
  RunDirError,
  contains,
  describeCredential,
  createReadOnlyCredentialStore,
  decideRequest,
  describeDirectory,
  fingerprintFile,
  readPort,
  resolveRunDir,
  stripApiPrefix,
  type FileFingerprint,
  type StaticAssetOutcome,
  type StaticAssetHost,
  type StaticRequest,
  type StaticResponse,
  type TestGatePolicy,
  type TestModelTarget,
} from './subagents-test-helpers';

import type { NextFunction, Request, Response } from 'express';
import type { PiHost } from '../server/pi/host';

/** Re-exported so the check script imports one module, as the task specifies. */
export * from './subagents-test-helpers';

/** Environment variable the SDK reads for its agent directory. */
const AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

/** The environment this instance runs with; all values are paths or ids. */
export interface TestEnvironment {
  readonly runDir: string;
  readonly agentDir: string;
  readonly realAgentDir: string;
  readonly fixtureRoot: string;
  readonly sessionDir: string;
  readonly definitionsFile: string;
  readonly modelsStorePath: string;
  readonly modelsPath: string;
  readonly authPath: string;
  readonly port: number;
  readonly model: TestModelTarget;
}

/** Paths and metadata recorded before and after startup, for the evidence log. */
export interface IsolationEvidence {
  readonly realAgentDir: string;
  readonly isolatedAgentDir: string;
  readonly agentDirEnv: string;
  readonly definitionsFile: string;
  readonly sessionDir: string;
  readonly modelsStorePath: string;
  readonly fixtures: string;
  readonly credentialType: string;
  readonly authConfigured: boolean;
  readonly availableModelIds: readonly string[];
  readonly preExisting: readonly FileFingerprint[];
}

/** Create `dir` (recursively, owner-only) and return it. */
function mkdirSyncEnsure(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Checkout root, derived from this file's location. */
export function projectRootFromModule(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/**
 * Redirect the SDK's agent directory into the run directory.
 *
 * Must run before `server/**` is imported. Returns the isolated path.
 *
 * @param runDir - the validated run directory.
 */
export function isolateAgentDir(runDir: string): string {
  const agentDir = path.join(runDir, 'agent-dir');
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  process.env[AGENT_DIR_ENV] = agentDir;
  return agentDir;
}

/**
 * Capture the real agent directory, then redirect the SDK away from it.
 *
 * @returns both paths, so the runtime can be built from the real ones.
 */
export async function captureAndIsolateAgentDir(
  runDir: string,
): Promise<{ realAgentDir: string; agentDir: string }> {
  // Captured with a dynamic import so the value is the pre-redirect one even if
  // another module already loaded the SDK.
  const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
  const realAgentDir = getAgentDir();
  const agentDir = isolateAgentDir(runDir);
  return { realAgentDir, agentDir };
}

/** Everything the entry point needs, built from the environment. */
export interface TestBootstrap {
  readonly environment: TestEnvironment;
  readonly policy: TestGatePolicy;
  readonly host: PiHost;
  readonly evidence: IsolationEvidence;
}

/**
 * Assemble the host with the test-only injection surface.
 *
 * Call after {@link captureAndIsolateAgentDir} so `server/**` is imported with
 * the isolated agent directory already in place.
 *
 * @param env - process environment.
 * @param projectRoot - checkout root, used only to reject a project-local RUN_DIR.
 * @param realAgentDir - the captured pre-redirect agent directory.
 * @param agentDir - the isolated agent directory.
 */
export async function createTestBootstrap(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
  realAgentDir: string,
  agentDir: string,
): Promise<TestBootstrap> {
  const runDir = resolveRunDir(env, projectRoot);
  // Canonicalised to match `runDir`: on macOS the temp root is a symlink
  // (`/var` -> `/private/var`), so an uncanonicalised fixture root would reject
  // the very paths the caller is told to use.
  const fixtureRoot = realpathSync(mkdirSyncEnsure(path.join(runDir, 'fixtures')));

  const environment: TestEnvironment = {
    runDir,
    agentDir,
    realAgentDir,
    fixtureRoot,
    sessionDir: path.join(runDir, 'sessions'),
    definitionsFile: env['PI_WEBX_SUBAGENTS_FILE']?.trim() || path.join(runDir, 'agent-definitions.json'),
    modelsStorePath: path.join(runDir, 'models-store.json'),
    // Real models.json stays in play (read-only) so the custom provider survives.
    modelsPath: path.join(realAgentDir, 'models.json'),
    authPath: path.join(realAgentDir, 'auth.json'),
    port: readPort(env['PI_WEBX_PORT']),
    model: {
      providerId: env['PI_WEBX_PROVIDER']?.trim() || 'cmdc',
      modelId: env['PI_WEBX_MODEL']?.trim() || 'deepseek/deepseek-v4.1-flash',
    },
  };
  mkdirSync(environment.sessionDir, { recursive: true, mode: 0o700 });

  // Report the credential kind only. An absent store entry is normal — the key
  // may live in the model config the SDK loads read-only from the real
  // models.json — and only an OAuth credential, which this adapter cannot serve,
  // blocks startup.
  const credentialType = describeCredential(
    environment.authPath,
    environment.model.providerId,
    readStoredCredential,
  );

  // Imported here, after the redirect: these modules bake the agent dir in.
  const { AgentDefinitionStore } = await import('../server/agent-definitions');
  const { PiHost: Host } = await import('../server/pi/host');

  const definitions = new AgentDefinitionStore({ filePath: environment.definitionsFile });
  const credentials = createReadOnlyCredentialStore(
    environment.authPath,
    environment.model.providerId,
    readStoredCredential,
  );

  // Built once and shared: the preflight and the host must interrogate the same
  // runtime, or the metadata checked here would not be the one serving requests.
  const runtime = await ModelRuntime.create({
    credentials,
    // Explicit real path: never inferred from the redirected agent dir. The SDK
    // loads it read-only, which is how a provider key stored in models.json
    // reaches request auth without this harness reading it.
    modelsPath: environment.modelsPath,
    modelsStorePath: environment.modelsStorePath,
    allowModelNetwork: false,
  });

  // Preflight from SDK metadata only: no file is read here, and no secret value
  // is available to these calls. A missing model is a real failure; a missing
  // credential store entry is not, because config-supplied auth is legitimate.
  const authConfigured = runtime.hasConfiguredAuth(environment.model.providerId);
  const available = await runtime.getAvailable(environment.model.providerId);
  const availableIds = available.map((model) => model.id);
  if (!availableIds.includes(environment.model.modelId)) {
    throw new Error(
      `model ${environment.model.providerId}/${environment.model.modelId} is not available ` +
        `(configured auth: ${String(authConfigured)}; provider exposes: ${availableIds.join(', ') || 'none'})`,
    );
  }

  const host = new Host({
    definitions,
    sessionDir: environment.sessionDir,
    // Each session gets its own in-memory settings: nothing can persist defaults.
    settingsManagerFactory: () => SettingsManager.inMemory(),
    modelRuntimeFactory: () => Promise.resolve(runtime),
  });

  const policy: TestGatePolicy = {
    runDir: environment.runDir,
    fixtureRoot: environment.fixtureRoot,
    model: environment.model,
    allowedCommands: new Set(DEFAULT_ALLOWED_COMMANDS),
  };

  const preExisting = await Promise.all(
    [environment.modelsPath, environment.authPath, path.join(realAgentDir, 'settings.json')].map((file) =>
      fingerprintFile(file),
    ),
  );

  const evidence: IsolationEvidence = {
    realAgentDir,
    isolatedAgentDir: agentDir,
    agentDirEnv: env[AGENT_DIR_ENV] ?? '',
    definitionsFile: environment.definitionsFile,
    sessionDir: environment.sessionDir,
    modelsStorePath: environment.modelsStorePath,
    fixtures: environment.fixtureRoot,
    credentialType,
    authConfigured,
    availableModelIds: availableIds,
    preExisting,
  };

  return { environment, policy, host, evidence };
}

/** Express middleware form of {@link decideRequest}. */
export function testGate(policy: TestGatePolicy) {
  return function gate(req: Request, res: Response, next: NextFunction): void {
    const decision = decideRequest(policy, {
      method: req.method,
      path: req.path,
      body: req.body,
      query: req.query as Record<string, unknown>,
    });

    if (decision.kind === 'deny') {
      res.status(403).json({ error: decision.reason });
      return;
    }
    if (decision.kind === 'allow-empty-sessions') {
      res.json({ sessions: [] });
      return;
    }

    normaliseCreateSessionCwd(policy, req);
    next();
  };
}

/** Fill in the fixture cwd so the SDK never inherits the process cwd. */
function normaliseCreateSessionCwd(policy: TestGatePolicy, req: Request): void {
  if (req.method.toUpperCase() !== 'POST' || stripApiPrefix(req.path) !== '/sessions') return;
  const body = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
  const record = body as Record<string, unknown>;
  if (record['cwd'] !== undefined) return;
  record['cwd'] = policy.fixtureRoot;
}

/**
 * Start the isolated instance; returns a disposer that stops only this server.
 *
 * @param bootstrap - assembled host, environment, and gate policy.
 * @param options.distDir - built UI directory; absent means API-only.
 * @param options.requireStatic - fail instead of degrading when `dist/index.html`
 *   is missing. The UI acceptance run needs the real page.
 */
export async function startTestServer(
  bootstrap: TestBootstrap,
  options: { distDir?: string; requireStatic?: boolean } = {},
): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly staticAssets: StaticAssetOutcome | undefined;
}> {
  const { default: express } = await import('express');
  const { JSON_BODY_LIMIT, createApiRouter } = await import('../server/routes');
  const { attachWebSocketGateway } = await import('../server/ws');
  const { environment, policy, host } = bootstrap;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  // The guard runs before every route: nothing downstream is reachable directly.
  app.use('/api', testGate(policy));
  app.use('/api', createApiRouter(host));
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'unknown API endpoint' });
  });

  let staticAssets: StaticAssetOutcome | undefined;
  if (options.distDir !== undefined) {
    staticAssets = attachStaticAssets(
      app as unknown as StaticAssetHost,
      options.distDir,
      existsSync,
      express.static(options.distDir, { index: 'index.html' }) as unknown as (
        req: StaticRequest,
        res: StaticResponse,
        next: () => void,
      ) => void,
    );
    if (staticAssets.kind === 'missing' && options.requireStatic === true) {
      throw new Error(
        `static assets required but ${staticAssets.indexHtml} is missing; run \`npm run build\` first`,
      );
    }
    console.log(
      `[subagents-test] static ${staticAssets.kind}: ${staticAssets.kind === 'served' ? 'serving' : 'skipped'} ${staticAssets.indexHtml}`,
    );
  }

  const server = app.listen(environment.port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const disposeWebSocket = attachWebSocketGateway(server, host);

  return {
    url: `http://127.0.0.1:${environment.port}`,
    staticAssets,
    close: async () => {
      disposeWebSocket();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await host.disposeAll();
    },
  };
}

/** Print paths and metadata only: no file contents, no credentials. */
export function reportEvidence(evidence: IsolationEvidence): void {
  console.log(`[subagents-test] real agent dir (read-only) ${evidence.realAgentDir}`);
  console.log(`[subagents-test] ${AGENT_DIR_ENV}=${evidence.agentDirEnv}`);
  console.log(`[subagents-test] isolated agent dir ${evidence.isolatedAgentDir}`);
  console.log(
    `[subagents-test] credentials store=${evidence.credentialType} configuredAuth=${String(evidence.authConfigured)} (SDK metadata only)`,
  );
  console.log(`[subagents-test] provider models: ${evidence.availableModelIds.join(', ') || 'none'}`);
  console.log(`[subagents-test] definitions ${evidence.definitionsFile}`);
  console.log(`[subagents-test] sessions ${evidence.sessionDir}`);
  console.log(`[subagents-test] models store ${evidence.modelsStorePath}`);
  console.log(`[subagents-test] fixtures ${evidence.fixtures}`);
  for (const entry of evidence.preExisting) {
    console.log(
      `[subagents-test] pre-existing ${entry.path} exists=${String(entry.exists)}` +
        ` size=${entry.sizeBytes ?? '-'} mtimeMs=${entry.mtimeMs ?? '-'} sha256=${entry.sha256 ?? '-'}`,
    );
  }
  for (const dir of [describeDirectory(evidence.realAgentDir), describeDirectory(evidence.isolatedAgentDir)]) {
    console.log(`[subagents-test] dir ${dir.path} exists=${String(dir.exists)} mode=${dir.mode ?? '-'}`);
  }
}

async function main(): Promise<void> {
  const projectRoot = projectRootFromModule();
  const runDir = resolveRunDir(process.env, projectRoot);
  const { realAgentDir, agentDir } = await captureAndIsolateAgentDir(runDir);

  const bootstrap = await createTestBootstrap(process.env, projectRoot, realAgentDir, agentDir);
  // The UI acceptance run drives the real page, so a missing build is fatal here
  // even though the product server would degrade to /api only.
  const { url, close } = await startTestServer(bootstrap, {
    distDir: path.join(projectRoot, 'dist'),
    requireStatic: true,
  });

  console.log(`[subagents-test] RUN_DIR=${bootstrap.environment.runDir}`);
  console.log(`[subagents-test] listening on ${url}`);
  console.log(
    `[subagents-test] model ${bootstrap.environment.model.providerId}/${bootstrap.environment.model.modelId}`,
  );
  reportEvidence(bootstrap.evidence);

  const shutdown = (): void => {
    void close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(
      `[subagents-test] failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

/** Re-exported for the check script: the gate and the error type it asserts on. */
export { RunDirError, DEFAULT_TEST_PORT, contains };
