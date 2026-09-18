/**
 * Shared WebSocket lifecycle: one connection carries every session's event
 * stream (see `/api/ws`). dsh's ConnectionController in miniature —
 * generational sockets, exponential backoff, network-state awareness — and
 * deliberately the only place that knows a socket exists: session clients
 * subscribe and receive messages, React never sees the wire.
 *
 * Reconnect semantics: whatever a session had subscribed stays "desired", and
 * each desire carries a seq provider; on reopen the controller re-subscribes
 * every desired session with its last applied seq, which is what lets the
 * server replay the journal tail instead of the client rebuilding blindly.
 */

import type { WsClientMessage, WsServerMessage } from '../shared/protocol';

export type WireStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** First retry delay, doubling per failure. */
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 10_000;

function socketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/api/ws`;
}

type MessageListener = (message: WsServerMessage) => void;
type StatusListener = (status: WireStatus) => void;

export class ConnectionController {
  private socket: WebSocket | null = null;
  /** Bumped on every drop/reopen; stale callbacks compare against it. */
  private generation = 0;
  private backoffMs = BACKOFF_BASE_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private wireStatus: WireStatus = 'connecting';

  /** session id -> provider of that session's last applied journal seq. */
  private readonly desired = new Map<string, () => number | undefined>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor() {
    window.addEventListener('online', this.onNetworkOnline);
    window.addEventListener('offline', this.onNetworkOffline);
  }

  /** Register interest in a session's stream; connects lazily on first use. */
  attach(sessionId: string, seqProvider: () => number | undefined): void {
    this.desired.set(sessionId, seqProvider);
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.send({ t: 'subscribe', sessionId, ...(this.readSeq(sessionId)) });
      return;
    }
    if (this.desired.size === 1) this.connect();
  }

  /** Drop interest; live subscriptions are released on the wire too. */
  detach(sessionId: string): void {
    if (!this.desired.has(sessionId)) return;
    this.desired.delete(sessionId);
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.send({ t: 'unsubscribe', sessionId });
    }
    if (this.desired.size === 0) this.teardown();
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.wireStatus);
    return () => this.statusListeners.delete(listener);
  }

  get status(): WireStatus {
    return this.wireStatus;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /** Re-subscribe one session now (e.g. after the client chose to resync). */
  resubscribe(sessionId: string): void {
    if (!this.desired.has(sessionId)) return;
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.send({ t: 'subscribe', sessionId, ...this.readSeq(sessionId) });
    }
  }

  private readSeq(sessionId: string): { fromSeq?: number } {
    const provider = this.desired.get(sessionId);
    const seq = provider?.();
    return typeof seq === 'number' && seq >= 0 ? { fromSeq: seq } : {};
  }

  private connect(): void {
    this.teardownSocket();
    this.setWireStatus(navigator.onLine ? 'connecting' : 'offline');
    if (!navigator.onLine) return; // the 'online' event triggers the attempt

    const generation = ++this.generation;
    const socket = new WebSocket(socketUrl());
    this.socket = socket;

    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.backoffMs = BACKOFF_BASE_MS;
      this.setWireStatus('live');
      // The server greets with `welcome`; subscriptions are the client's move.
      for (const sessionId of this.desired.keys()) {
        this.send({ t: 'subscribe', sessionId, ...this.readSeq(sessionId) });
      }
    };

    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      let message: WsServerMessage;
      try {
        message = JSON.parse(String(event.data)) as WsServerMessage;
      } catch {
        return;
      }
      for (const listener of [...this.messageListeners]) listener(message);
    };

    socket.onclose = () => {
      if (generation !== this.generation) return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.socket = null;
    if (this.desired.size === 0) {
      this.setWireStatus('connecting');
      return;
    }
    if (!navigator.onLine) {
      this.setWireStatus('offline');
      return;
    }
    this.setWireStatus('reconnecting');
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.desired.size > 0) this.connect();
    }, delay);
  }

  private readonly onNetworkOnline = (): void => {
    if (this.desired.size === 0) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.connect();
  };

  private readonly onNetworkOffline = (): void => {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.setWireStatus('offline');
  };

  private send(message: WsClientMessage): void {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private setWireStatus(status: WireStatus): void {
    if (this.wireStatus === status) return;
    this.wireStatus = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  private teardownSocket(): void {
    if (this.socket !== null) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  }

  private teardown(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.teardownSocket();
    this.generation += 1;
    this.setWireStatus('connecting');
  }
}

/** The app-wide connection: every session client multiplexes over this one. */
export const sharedConnection = new ConnectionController();
