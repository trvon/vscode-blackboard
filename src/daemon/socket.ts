/**
 * Unix domain socket connection manager for YAMS daemon IPC.
 *
 * Resolves the socket path via environment variables and provides
 * connection lifecycle management with auto-reconnect.
 *
 * Resolution order:
 *   1. $YAMS_DAEMON_SOCKET
 *   2. $XDG_RUNTIME_DIR/yams-daemon.sock
 *   3. /tmp/yams-daemon-<uid>.sock
 */

import * as net from "node:net";
import * as os from "node:os";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";

// -----------------------------------------------------------------------------
// Socket path resolution
// -----------------------------------------------------------------------------

/** Resolve the YAMS daemon socket path. */
export function resolveSocketPath(): string {
  // 1. Explicit env override
  const explicit = process.env.YAMS_DAEMON_SOCKET;
  if (explicit) return explicit;

  // 2. XDG runtime directory
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return `${xdg}/yams-daemon.sock`;

  // 3. Fallback: /tmp with uid
  const uid = os.userInfo().uid;
  return `/tmp/yams-daemon-${uid}.sock`;
}

/** Check whether the daemon socket file exists on disk. */
export function socketExists(path?: string): boolean {
  try {
    const p = path ?? resolveSocketPath();
    return fs.statSync(p).isSocket();
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Connection events
// -----------------------------------------------------------------------------

export interface SocketConnectionEvents {
  connect: [];
  data: [Buffer];
  close: [hadError: boolean];
  error: [Error];
  reconnecting: [attempt: number, delayMs: number];
}

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface SocketConnectionOptions {
  /** Override the socket path (defaults to resolveSocketPath()). */
  socketPath?: string;
  /** Enable auto-reconnect on disconnect (default: true). */
  autoReconnect?: boolean;
  /** Initial reconnect delay in ms (default: 500). */
  reconnectBaseMs?: number;
  /** Maximum reconnect delay in ms (default: 30_000). */
  reconnectMaxMs?: number;
  /** Maximum reconnect attempts before giving up (default: Infinity). */
  maxReconnectAttempts?: number;
  /** Connection timeout in ms (default: 5_000). */
  connectTimeoutMs?: number;
}

// -----------------------------------------------------------------------------
// SocketConnection
// -----------------------------------------------------------------------------

export class SocketConnection extends EventEmitter<SocketConnectionEvents> {
  private socket: net.Socket | null = null;
  private _connected = false;
  private _disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly socketPath: string;
  private readonly autoReconnect: boolean;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly connectTimeoutMs: number;

  constructor(opts: SocketConnectionOptions = {}) {
    super();
    this.socketPath = opts.socketPath ?? resolveSocketPath();
    this.autoReconnect = opts.autoReconnect ?? true;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 500;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? Infinity;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5_000;
  }

  /** Whether the socket is currently connected. */
  get connected(): boolean {
    return this._connected;
  }

  /** The resolved socket path. */
  get path(): string {
    return this.socketPath;
  }

  /**
   * Open the connection. Resolves when connected, rejects on error/timeout.
   * If already connected this is a no-op.
   */
  connect(): Promise<void> {
    if (this._connected) return Promise.resolve();
    if (this._disposed)
      return Promise.reject(new Error("SocketConnection has been disposed"));

    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ path: this.socketPath });

      const timeout = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Connection timeout after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      sock.once("connect", () => {
        clearTimeout(timeout);
        this.socket = sock;
        this._connected = true;
        this.reconnectAttempt = 0;
        this.wireEvents(sock);
        this.emit("connect");
        resolve();
      });

      sock.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Wait until connected (immediately if already connected).
   * Useful for callers that want to block until the socket is ready.
   */
  waitForReady(timeoutMs = 10_000): Promise<void> {
    if (this._connected) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("connect", onConnect);
        reject(new Error(`waitForReady timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("connect", onConnect);
    });
  }

  /** Write raw bytes to the socket. */
  write(data: Buffer | Uint8Array): boolean {
    if (!this.socket || !this._connected) {
      throw new Error("Socket not connected");
    }
    return this.socket.write(data);
  }

  /** Gracefully disconnect. Does not trigger auto-reconnect. */
  disconnect(): void {
    this.cancelReconnect();
    this._connected = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  /** Disconnect and mark as disposed (no further use). */
  dispose(): void {
    this._disposed = true;
    this.disconnect();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private wireEvents(sock: net.Socket): void {
    sock.on("data", (chunk) => {
      this.emit("data", chunk);
    });

    sock.on("close", (hadError) => {
      this._connected = false;
      this.socket = null;
      this.emit("close", hadError);

      if (this.autoReconnect && !this._disposed) {
        this.scheduleReconnect();
      }
    });

    sock.on("error", (err) => {
      this.emit("error", err);
    });
  }

  private scheduleReconnect(): void {
    if (this._disposed) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempts) return;

    this.reconnectAttempt++;
    const delay = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt - 1),
      this.reconnectMaxMs,
    );

    this.emit("reconnecting", this.reconnectAttempt, delay);

    this.reconnectTimer = setTimeout(async () => {
      if (this._disposed || this._connected) return;
      try {
        await this.connect();
      } catch {
        // connect() failed — close handler will schedule next attempt
      }
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
