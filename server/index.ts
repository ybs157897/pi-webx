import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { resolvePiVersion } from './config';
import { PiHost } from './pi/host';
import { JSON_BODY_LIMIT, createApiRouter } from './routes';
import { responseErrorMessage, statusFromError } from './http-errors';
import { attachWebSocketGateway } from './ws';

/** Default port; override with PI_WEBX_PORT. */
const DEFAULT_PORT = 8787;
/** Loopback only: this process spawns a coding agent with the user's shell access. */
const HOST = '127.0.0.1';
/** How long shutdown waits for children before forcing exit. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(serverDir);
const distDir = path.join(projectRoot, 'dist');
const isProduction = process.env.NODE_ENV === 'production';

async function main(): Promise<void> {
  const manager = new PiHost();
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use('/api', createApiRouter(manager));
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'unknown API endpoint' });
  });

  if (isProduction) {
    serveProductionAssets(app);
  } else {
    console.log('[pi-webx] dev mode: serving /api only (Vite serves the UI)');
  }

  // Final error handler: must stay last, and must never leak stack traces.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = statusFromError(error);
    if (status >= 500) {
      console.error('[pi-webx] request failed:', error);
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json({ error: responseErrorMessage(error, isProduction) });
  });

  const port = readPort();
  /**
   * Replay the Team journal before the first request can arrive.
   *
   * Awaited on purpose: after a restart a client only holds a session id, and the
   * replay is what makes `GET /api/teams/<sessionId>` work for it. What that does
   * and does not mean, measured rather than assumed:
   *
   *   - **The Team is addressable by session id again** — `team-created` records carry
   *     the parent session, and the replay rebuilds that index. This is true even
   *     though a run without a single assistant turn never writes a transcript.
   *   - **The session itself is still not resumable.** A session with no assistant
   *     turn has no file on disk, so `POST /api/sessions {sessionId}` still answers
   *     `404 no stored session`. The replay only answers "which Team did this session
   *     orchestrate"; it does not bring a conversation back.
   *
   * The cost is bounded — one directory, one file per Team — and `hydrateTeams()`
   * never throws: a damaged, missing or even unwritable journal is reported here and
   * the server starts anyway (in memory, if the journal cannot be written at all).
   */
  const replayed = await manager.hydrateTeams();
  if (replayed.journalDisabled !== undefined) {
    console.warn(
      `[pi-webx] team journal unavailable (${replayed.journalDisabled}); `
      + 'Teams will run in memory only and will not survive a restart',
    );
  } else if (replayed.files > 0) {
    console.log(
      `[pi-webx] team journal replayed: ${replayed.teams} team(s) from ${replayed.files} file(s), `
      + `${replayed.bytes} bytes, ${replayed.interrupted} interrupted member(s), `
      + `${replayed.skipped} bad line(s) skipped, ${replayed.unusable} file(s) held no team `
      + `in ${replayed.durationMs}ms`,
    );
  }
  const server = app.listen(port, HOST, () => {
    console.log(`[pi-webx] listening on http://${HOST}:${port}`);
    console.log(`[pi-webx] pi SDK ${resolvePiVersion()} (agent runs in-process)`);
  });

  const disposeWebSocket = attachWebSocketGateway(server, manager);

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[pi-webx] port ${port} is already in use; set PI_WEBX_PORT to another port`);
    } else {
      console.error('[pi-webx] server error:', error);
    }
    process.exitCode = 1;
  });

  installSignalHandlers(server, manager, disposeWebSocket);
}

/**
 * Production: serve `dist/` and fall back to `index.html` for client routes.
 * Express 5 dropped the `*` wildcard syntax, so the SPA fallback is middleware.
 */
function serveProductionAssets(app: express.Express): void {
  const indexHtml = path.join(distDir, 'index.html');

  if (!existsSync(indexHtml)) {
    console.warn(
      `[pi-webx] no build output at ${distDir} — run \`npm run build\` first. ` +
        'Falling back to /api only.',
    );
    return;
  }

  app.use(express.static(distDir, { index: 'index.html' }));
  console.log(`[pi-webx] serving static assets + SPA fallback from ${distDir}`);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api')) return next();
    res.sendFile(indexHtml, (error?: Error) => {
      if (error) next(error);
    });
  });
}

function installSignalHandlers(
  server: ReturnType<express.Express['listen']>,
  manager: PiHost,
  disposeWebSocket: () => void,
): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[pi-webx] received ${signal}; shutting down`);

    // WebSocket clients hold connections open, so close() alone would hang:
    // the gateway is torn down first so sockets close instead of keeping the
    // http server alive through open upgrades.
    disposeWebSocket();
    const httpClosed = new Promise<void>((resolve) => {
      server.close(() => {
        console.log('[pi-webx] http server closed');
        resolve();
      });
    });
    server.closeAllConnections();

    // stop() sends SIGTERM synchronously, so children are on their way out
    // even if this promise is still pending.
    const sessionsStopped = manager.disposeAll().then(
      () => {
        console.log('[pi-webx] all pi sessions stopped');
      },
      (error: unknown) => {
        console.error('[pi-webx] error while stopping sessions:', error);
      },
    );

    void Promise.all([httpClosed, sessionsStopped]).then(() => process.exit(0));

    const force = setTimeout(() => {
      console.warn('[pi-webx] shutdown timed out; forcing exit');
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref?.();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function readPort(): number {
  const raw = process.env.PI_WEBX_PORT;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_PORT;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`[pi-webx] invalid PI_WEBX_PORT="${raw}"; using ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return parsed;
}

// Never die silently: a local tool that exits without a word is impossible to debug.
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[pi-webx] unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error: Error) => {
  console.error('[pi-webx] uncaught exception:', error);
});

main().catch((error: unknown) => {
  console.error('[pi-webx] failed to start:', error);
  process.exit(1);
});
