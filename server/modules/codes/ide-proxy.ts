import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Request, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import type { CodesIdeRuntime, GatewayConnection } from './ide-runtime';

const PREFIX = '/api/codes/gateway';
const LSP_PATH = /^\/api\/v1\/workspaces\/[^/]+\/lsp$/;
const MAX_WS_BYTES = 4 * 1024 * 1024;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'set-cookie']);

export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.host !== req.headers.host || !['http:', 'https:'].includes(url.protocol)) return false;
    } catch { return false; }
  }
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

export function gatewayPath(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl, 'http://localhost');
    if (!url.pathname.startsWith('/api/v1/')) return undefined;
    return url.pathname + url.search;
  } catch { return undefined; }
}

export async function proxyGatewayHttp(req: Request, res: Response, runtime: CodesIdeRuntime): Promise<void> {
  if (!sameOrigin(req)) {
    res.status(403).json({ error: '跨站请求已拒绝' });
    return;
  }
  const path = gatewayPath(req.url);
  if (!path) {
    res.status(404).json({ error: 'unknown gateway endpoint' });
    return;
  }
  let connection: GatewayConnection;
  try {
    connection = await runtime.start();
  } catch (error) {
    res.status(503).json({ error: String(error) });
    return;
  }
  const body = req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body));
  const headers: http.OutgoingHttpHeaders = {
    authorization: `Bearer ${connection.token}`,
    accept: req.headers.accept ?? '*/*',
  };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (body) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = body.length;
  } else if (req.headers['content-length']) {
    headers['content-length'] = req.headers['content-length'];
  }
  const upstream = http.request({
    hostname: '127.0.0.1', port: connection.port, method: req.method, path, headers,
    timeout: 15_000,
  }, (upstreamResponse) => {
    res.status(upstreamResponse.statusCode ?? 502);
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value !== undefined && !HOP_HEADERS.has(name)) res.setHeader(name, value);
    }
    upstreamResponse.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('gateway timeout')));
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'web-idea gateway 不可用' });
    else res.end();
  });
  if (body) upstream.end(body);
  else req.pipe(upstream);
}

export class CodesIdeWebSockets {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_BYTES });
  private readonly peers = new Set<WebSocket>();
  private readonly pendingSockets = new Set<Duplex>();
  private closed = false;

  constructor(private readonly runtime: Pick<CodesIdeRuntime, 'start'>) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(`${PREFIX}/`)) return false;
    const path = gatewayPath(url.pathname.slice(PREFIX.length) + url.search);
    if (!path || !LSP_PATH.test(new URL(path, 'http://localhost').pathname) || !sameOrigin(req)) {
      socket.destroy();
      return true;
    }
    if (this.closed) { socket.destroy(); return true; }
    this.pendingSockets.add(socket);
    void this.runtime.start().then(({ port, token }) => {
      if (socket.destroyed || this.closed) return;
      const upstream = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        maxPayload: MAX_WS_BYTES,
        handshakeTimeout: 20_000,
      });
      let browser: WebSocket | undefined;
      let closing = false;
      const closeBoth = () => {
        if (closing) return;
        closing = true;
        this.pendingSockets.delete(socket);
        if (!browser && !socket.destroyed) socket.destroy();
        if (browser && browser.readyState !== WebSocket.CLOSED) browser.terminate();
        if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
        if (browser) this.peers.delete(browser);
        this.peers.delete(upstream);
      };
      upstream.on('error', closeBoth);
      upstream.on('close', closeBoth);
      socket.once('close', closeBoth);
      upstream.once('open', () => {
        if (socket.destroyed || this.closed) { closeBoth(); return; }
        this.wss.handleUpgrade(req, socket, head, (accepted) => {
          browser = accepted;
          this.pendingSockets.delete(socket);
          this.peers.add(browser);
          this.peers.add(upstream);
          browser.on('error', closeBoth);
          browser.on('close', closeBoth);
          browser.on('message', (data, binary) => forward(data, binary, upstream, closeBoth));
          upstream.on('message', (data, binary) => forward(data, binary, browser!, closeBoth));
        });
      });
    }).catch(() => { this.pendingSockets.delete(socket); socket.destroy(); });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.pendingSockets) socket.destroy();
    this.pendingSockets.clear();
    for (const peer of this.peers) peer.terminate();
    this.peers.clear();
    this.wss.close();
  }
}

function forward(data: WebSocket.RawData, binary: boolean, target: WebSocket, closeBoth: () => void): void {
  const size = Array.isArray(data) ? data.reduce((sum, part) => sum + part.length, 0) : data.byteLength;
  if (target.readyState !== WebSocket.OPEN || target.bufferedAmount + size > MAX_WS_BYTES) {
    closeBoth();
    return;
  }
  target.send(data, { binary }, (error) => { if (error) closeBoth(); });
}
