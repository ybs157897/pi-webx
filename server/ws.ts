/**
 * WebSocket event gateway: one shared socket per browser carries every
 * subscribed session's journaled frames — dsh's remote-mux split, with unary
 * commands staying on HTTP POST.
 *
 * Responsibilities kept deliberately small: subscription registry, journal
 * replay on (re)subscribe, protocol-level heartbeat, and backpressure guard.
 * Session semantics (who exists, who gets swept) stay in PiHost.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

import type { WsClientMessage, WsServerMessage } from '../src/shared/protocol';
import type { HostSubscriber, PiHost } from './pi/host';

export const WS_PATH = '/api/ws';

/** Heartbeat cadence; two missed pong cycles drop the connection. */
const PING_INTERVAL_MS = 30_000;
/** A socket buffering more than this is not keeping up: drop it, the journal covers the gap. */
const BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024;

interface Connection {
  socket: WebSocket;
  subscriptions: Map<string, HostSubscriber>;
  alive: boolean;
}

export function attachWebSocketGateway(server: { on: (event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) => void }, manager: PiHost): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<Connection>();
  const pinger = setInterval(() => heartbeat(), PING_INTERVAL_MS);
  pinger.unref();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (socket_) => {
      wss.emit('connection', socket_, req);
    });
  });

  wss.on('connection', (socket) => {
    const connection: Connection = { socket, subscriptions: new Map(), alive: true };
    connections.add(connection);

    socket.on('message', (raw) => {
      let message: WsClientMessage;
      try {
        message = JSON.parse(String(raw)) as WsClientMessage;
      } catch {
        return; // a malformed line is ignored, never fatal
      }
      if (message?.t === 'subscribe') {
        handleSubscribe(connection, manager, message.sessionId, message.fromSeq);
      } else if (message?.t === 'unsubscribe') {
        unsubscribe(manager, connection, message.sessionId);
      }
      // 'resync' is client→server bookkeeping in the protocol for symmetry;
      // the server never needs it — a subscribe without fromSeq is a resync.
    });

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('close', () => {
      connections.delete(connection);
      for (const sessionId of [...connection.subscriptions.keys()]) {
        unsubscribe(manager, connection, sessionId);
      }
    });

    send(connection, { t: 'welcome' });
  });

  function handleSubscribe(
    connection: Connection,
    manager: PiHost,
    sessionId: string,
    fromSeq: number | undefined,
  ): void {
    unsubscribe(manager, connection, sessionId);

    const session = manager.get(sessionId);
    if (!session) {
      send(connection, { t: 'closed', sessionId, reason: 'unknown' });
      return;
    }

    send(connection, {
      t: 'subscribed',
      sessionId,
      latestSeq: session.journal.latestSeq,
      cwd: session.cwd,
      sessionFile: session.sessionFile,
      resumed: session.resumed,
      streaming: session.streaming,
    });

    // Replay before live frames: socket order is the journal's order, and the
    // client drops anything at or below its own snapshot watermark anyway.
    if (typeof fromSeq === 'number') {
      const tail = session.journal.replayFrom(fromSeq);
      if (tail === null) {
        send(connection, { t: 'resync-required', sessionId });
        // Fall through to the live subscription: the client rebuilds from a
        // snapshot while still receiving frames newer than the gap.
      } else {
        for (const entry of tail) {
          send(connection, { t: 'event', sessionId, seq: entry.seq, frame: entry.frame });
        }
      }
    }

    const subscriber: HostSubscriber = {
      frame: (entry) => {
        send(connection, { t: 'event', sessionId, seq: entry.seq, frame: entry.frame });
      },
      close: () => {
        connection.subscriptions.delete(sessionId);
        send(connection, { t: 'closed', sessionId, reason: 'killed' });
      },
    };
    connection.subscriptions.set(sessionId, subscriber);
    manager.subscribe(session, subscriber);
  }

  function unsubscribe(manager: PiHost, connection: Connection, sessionId: string): void {
    const subscriber = connection.subscriptions.get(sessionId);
    if (subscriber === undefined) return;
    connection.subscriptions.delete(sessionId);
    const session = manager.get(sessionId);
    if (session) manager.unsubscribe(session, subscriber);
  }

  function send(connection: Connection, message: WsServerMessage): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.socket.bufferedAmount > BACKPRESSURE_LIMIT_BYTES) {
      // A slow consumer must not stall the agent: drop the socket; the client
      // reconnects and the journal replays what it missed.
      connection.socket.terminate();
      return;
    }
    connection.socket.send(JSON.stringify(message));
  }

  function heartbeat(): void {
    for (const connection of connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }

  return function dispose(): void {
    clearInterval(pinger);
    for (const connection of connections) {
      for (const sessionId of [...connection.subscriptions.keys()]) {
        unsubscribe(manager, connection, sessionId);
      }
      connection.socket.terminate();
    }
    connections.clear();
    wss.close();
  };
}
