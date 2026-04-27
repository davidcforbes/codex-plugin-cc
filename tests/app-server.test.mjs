import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";

function makeBrokerEndpoint() {
  if (process.platform === "win32") {
    const pipeName = `codex-plugin-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    return { endpoint: `pipe:${pipePath}`, listenPath: pipePath, cleanup() {} };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-test-socket-"));
  const socketPath = path.join(dir, "broker.sock");
  return {
    endpoint: `unix:${socketPath}`,
    listenPath: socketPath,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function withBrokerServer(handler, fn) {
  const target = makeBrokerEndpoint();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handler(socket);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.listenPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    return await fn(target.endpoint);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    target.cleanup();
  }
}

test("broker client request timeout rejects stalled initialize", async () => {
  await withBrokerServer(
    (socket) => {
      socket.on("data", () => {});
    },
    async (endpoint) => {
      await assert.rejects(
        () => CodexAppServerClient.connect(makeTempDir(), { brokerEndpoint: endpoint, requestTimeoutMs: 25 }),
        /timed out/
      );
    }
  );
});

test("broker client rejects oversized JSON-RPC lines", async () => {
  await withBrokerServer(
    (socket) => {
      socket.write("x".repeat(32));
    },
    async (endpoint) => {
      await assert.rejects(
        () => CodexAppServerClient.connect(makeTempDir(), { brokerEndpoint: endpoint, maxLineBytes: 16 }),
        /exceeded/
      );
    }
  );
});
