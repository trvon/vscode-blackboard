import test from "node:test";
import assert from "node:assert/strict";

import { once } from "node:events";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { resolveSocketPath, socketExists, SocketConnection } from "../src/daemon/socket.js";

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[name];
  try {
    if (value === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
    return fn();
  } finally {
    if (prev === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
}

test("resolveSocketPath prefers YAMS_DAEMON_SOCKET", () => {
  const p = withEnv("YAMS_DAEMON_SOCKET", "/tmp/custom.sock", () =>
    withEnv("XDG_RUNTIME_DIR", "/run/user/1000", () => resolveSocketPath()),
  );
  assert.equal(p, "/tmp/custom.sock");
});

test("resolveSocketPath uses XDG_RUNTIME_DIR when set", () => {
  const p = withEnv("YAMS_DAEMON_SOCKET", undefined, () =>
    withEnv("XDG_RUNTIME_DIR", "/run/user/1000", () => resolveSocketPath()),
  );
  assert.equal(p, "/run/user/1000/yams-daemon.sock");
});

test("resolveSocketPath falls back to /tmp/yams-daemon-<uid>.sock", () => {
  const p = withEnv("YAMS_DAEMON_SOCKET", undefined, () =>
    withEnv("XDG_RUNTIME_DIR", undefined, () => resolveSocketPath()),
  );
  // We don't assert the uid value directly (can vary in CI containers), just the prefix.
  assert.ok(p.startsWith("/tmp/yams-daemon-"));
  assert.ok(p.endsWith(".sock"));
});

test("socketExists returns true for a real unix socket, false for a regular file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-blackboard-"));
  const sockPath = path.join(dir, "daemon.sock");
  const filePath = path.join(dir, "not-a-socket");

  const server = net.createServer();
  server.listen(sockPath);
  await once(server, "listening");

  assert.equal(socketExists(sockPath), true);

  await fs.writeFile(filePath, "hello");
  assert.equal(socketExists(filePath), false);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
});

test(
  "SocketConnection connects, writes data, and emits close",
  { timeout: 2_000 },
  async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-blackboard-"));
  const sockPath = path.join(dir, "daemon.sock");

  const received: Buffer[] = [];
  let serverSocket: net.Socket | undefined;
  const server = net.createServer((s) => {
    serverSocket = s;
    s.on("data", (d) => received.push(Buffer.from(d)));
  });
  server.listen(sockPath);
  await once(server, "listening");

  const conn = new SocketConnection({
    socketPath: sockPath,
    autoReconnect: false,
    connectTimeoutMs: 250,
  });

  await conn.connect();
  assert.equal(conn.connected, true);

  const payload = Buffer.from("ping");
  conn.write(payload);

  // Give the server a moment to process the write.
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(received.some((b) => b.includes(payload)));

  // Trigger a real socket close from the server side so SocketConnection's
  // wireEvents() close handler runs and emits the "close" event.
  assert.ok(serverSocket, "expected server to accept a connection");
  const closeP = once(conn, "close");
  serverSocket!.destroy();
  await closeP;
  assert.equal(conn.connected, false);

  conn.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
  },
);

test(
  "SocketConnection emits reconnecting when autoReconnect enabled and server goes away",
  { timeout: 2_000 },
  async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-blackboard-"));
  const sockPath = path.join(dir, "daemon.sock");

  const sockets = new Set<net.Socket>();
  let server = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.listen(sockPath);
  await once(server, "listening");

  const conn = new SocketConnection({
    socketPath: sockPath,
    autoReconnect: true,
    reconnectBaseMs: 10,
    reconnectMaxMs: 25,
    maxReconnectAttempts: 3,
    connectTimeoutMs: 50,
  });

  await conn.connect();
  assert.equal(conn.connected, true);

  const reconnectingP = once(conn, "reconnecting");
  // Close all accepted sockets to force the client to see a close event,
  // which schedules reconnect and emits "reconnecting".
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await reconnectingP;

  conn.dispose();
  await fs.rm(dir, { recursive: true, force: true });
  },
);

test("SocketConnection.write throws when not connected", () => {
  const conn = new SocketConnection({
    socketPath: "/tmp/does-not-exist.sock",
    autoReconnect: false,
  });
  assert.throws(() => conn.write(Buffer.from("x")));
  conn.dispose();
});
