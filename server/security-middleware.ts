/**
 * Global request guards for the loopback bridge.
 *
 * This process spawns a coding agent with the user's shell access, so a web page
 * on another origin must not be able to drive it. Two rules, applied to every
 * router mounted in `server/index.ts` (sub-routers may layer stricter checks on
 * top, e.g. the JSON content-type requirement in `agent-definitions-routes.ts`):
 *
 *   1. **Host allowlist (DNS-rebinding guard).** Browsers block cross-origin
 *      *reads* of a response, but a page on `http://attacker.example` that
 *      resolves to `127.0.0.1` sends `Host: attacker.example` — same-origin to
 *      itself, invisible to Origin checks. Only comparing the Host header
 *      against a loopback allowlist closes that hole.
 *   2. **Origin guard for writes.** POST/PUT/PATCH/DELETE from a cross-site
 *      page is refused (form-POST CSRF needs no preflight). A caller with no
 *      `Origin` at all — a native client, curl, the checks — is allowed: this
 *      is a loopback, single-user bridge, and inventing a token would be
 *      security theatre rather than access control.
 *
 * Safe through the dev proxy because `vite.config.ts` sets `changeOrigin:
 * false`: the bridge sees the browser's own `Host` (`localhost:5173`), which is
 * loopback and exactly matches the `Origin` the browser sends. The allowlist
 * therefore accepts any loopback host on **any** port; non-loopback hosts need
 * `PI_WEBX_EXTRA_HOSTS`. Proxied origins are deliberately NOT auto-trusted — an
 * operator names them in `PI_WEBX_ALLOWED_ORIGIN` (exact, lowercase, the way a
 * browser sends them).
 */

import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

/** Loopback hostnames (port-less, lowercased) the bridge answers to. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Methods that must additionally pass the Origin check. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Split a `Host` header into `[{host}, {port}]`, lowercasing the host and
 * unwrapping IPv6 brackets (`[::1]:8787` → `::1` / `8787`).
 */
function splitHostHeader(raw: string): [host: string, port: string] {
  let value = raw.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return [value, ''];
    const host = value.slice(1, end);
    const port = value.slice(end + 1).replace(/^:/, '');
    return [host, port];
  }
  const colon = value.lastIndexOf(':');
  if (colon === -1) return [value, ''];
  return [value.slice(0, colon), value.slice(colon + 1)];
}

/**
 * Extra `Host` values the bridge answers to, from `PI_WEBX_EXTRA_HOSTS`
 * (comma-separated, optional port). Read per call so a test (or operator) can
 * change the env without a restart; never populated from request headers.
 */
function extraHosts(): string[] {
  const raw = process.env['PI_WEBX_EXTRA_HOSTS'];
  if (raw === undefined) return [];
  return raw.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
}

/**
 * Explicit extra origins that may drive writes, from `PI_WEBX_ALLOWED_ORIGIN`
 * (comma-separated, exact `scheme://host[:port]`), exactly as the agent
 * definitions surface has always allowed them. Shared so both guards refuse
 * and allow the same callers.
 */
export function configuredAllowedOrigins(): string[] {
  const raw = process.env['PI_WEBX_ALLOWED_ORIGIN'];
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Whether a `Host` header value names this bridge (loopback, or explicitly listed). */
export function isAllowedHost(raw: string | undefined): boolean {
  if (typeof raw !== 'string' || raw.trim().length === 0) return false;
  const [host, port] = splitHostHeader(raw);
  if (LOOPBACK_HOSTS.has(host)) return true;
  return extraHosts().some((entry) => {
    const [extraHost, extraPort] = splitHostHeader(entry);
    // A listed host without port matches any port; with port, it is exact.
    return extraHost === host && (extraPort === '' || extraPort === port);
  });
}

/**
 * Whether the caller is cross-site: `Sec-Fetch-Site: cross-site` says so, or an
 * `Origin` is present that neither names the request's own `Host` nor is
 * explicitly allowed. No `Origin` (native client, curl, the checks) is
 * same-site by this definition.
 *
 * The comparison folds DNS case but keeps the port, and never consults
 * caller-supplied `X-Forwarded-*` headers — trusting those would turn the check
 * into a formality.
 */
export function isCrossSiteRequest(req: IncomingMessage): boolean {
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

/** Host allowlist for every request — the DNS-rebinding guard. */
export function hostAllowlist() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isAllowedHost(req.headers['host'])) {
      res.status(403).json({ error: '拒绝请求：Host 不在本机回环白名单（可用 PI_WEBX_EXTRA_HOSTS 扩展）。' });
      return;
    }
    next();
  };
}

/** Origin guard for state-changing methods — the form-POST CSRF guard. */
export function originGuard() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!WRITE_METHODS.has(req.method)) {
      next();
      return;
    }
    if (isCrossSiteRequest(req)) {
      res.status(403).json({ error: '拒绝跨站写入：本桥只接受同源或本机原生调用。' });
      return;
    }
    next();
  };
}

/**
 * The same two rules for a WebSocket upgrade handshake. Browsers always send
 * `Origin` on a cross-site upgrade, and the Host rules apply unchanged; a
 * caller that fails either is not a caller of this bridge.
 */
export function guardUpgrade(req: IncomingMessage): boolean {
  return isAllowedHost(req.headers['host']) && !isCrossSiteRequest(req);
}
