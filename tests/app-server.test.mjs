import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectToSocket(listenPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection({ path: listenPath });
        function onError(error) {
          socket.destroy();
          reject(error);
        }
        socket.once("connect", () => {
          socket.off("error", onError);
          socket.setEncoding("utf8");
          resolve(socket);
        });
        socket.once("error", onError);
      });
    } catch (error) {
      lastError = error;
      await sleep(25);
    }
  }

  throw lastError ?? new Error(`Timed out connecting to ${listenPath}`);
}

function writeJsonLine(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

function readJsonLine(socket, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for broker response."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onData(chunk) {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      cleanup();
      resolve(JSON.parse(buffer.slice(0, newlineIndex)));
    }

    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function waitForExit(child, timeoutMs = 1000) {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for child process exit."));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    function onExit(code) {
      cleanup();
      resolve(code);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    child.once("exit", onExit);
    child.once("error", onError);
  });
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

test("broker ignores turn interrupt notifications without an id", async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  const target = makeBrokerEndpoint();
  const broker = spawn(
    process.execPath,
    [BROKER_SCRIPT, "serve", "--endpoint", target.endpoint, "--cwd", workspace],
    {
      cwd: ROOT,
      env: buildEnv(binDir),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    }
  );
  let stderr = "";
  broker.stderr.setEncoding("utf8");
  broker.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const socket = await connectToSocket(target.listenPath);
    try {
      writeJsonLine(socket, {
        method: "turn/interrupt",
        params: {
          threadId: "thr_notification",
          turnId: "turn_notification"
        }
      });
      await sleep(100);

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(state.lastInterrupt, null);

      writeJsonLine(socket, { id: 1, method: "broker/shutdown", params: {} });
      const response = await readJsonLine(socket);
      assert.deepEqual(response, { id: 1, result: {} });
    } finally {
      socket.destroy();
    }

    assert.equal(await waitForExit(broker), 0, stderr);
  } finally {
    if (broker.exitCode === null) {
      broker.kill();
    }
    target.cleanup();
  }
});

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
