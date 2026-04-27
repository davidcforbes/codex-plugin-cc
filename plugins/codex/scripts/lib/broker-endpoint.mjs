import os from "node:os";
import path from "node:path";
import process from "node:process";

function sanitizePipeName(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createBrokerEndpoint(sessionDir, platform = process.platform) {
  if (platform === "win32") {
    const pipeName = sanitizePipeName(`${path.win32.basename(sessionDir)}-codex-app-server`);
    return `pipe:\\\\.\\pipe\\${pipeName}`;
  }

  return `unix:${path.posix.join(String(sessionDir).replace(/\\/g, "/"), "broker.sock")}`;
}

function unixPathInside(candidate, root) {
  const normalizedRoot = path.posix.normalize(root);
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot.replace(/\/+$/, "")}/`);
}

function normalizeUnixSocketPath(socketPath, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error("Broker Unix socket endpoints are not supported on Windows.");
  }
  if (!path.posix.isAbsolute(socketPath)) {
    throw new Error("Broker Unix socket endpoint path must be absolute.");
  }

  const normalized = path.posix.normalize(socketPath);
  const allowedRoots = (options.allowedUnixSocketRoots ?? [os.tmpdir()]).map((root) =>
    path.posix.normalize(String(root).replace(/\\/g, "/"))
  );
  if (!allowedRoots.some((root) => unixPathInside(normalized, root))) {
    throw new Error(`Broker Unix socket endpoint must be under ${allowedRoots.join(" or ")}.`);
  }
  return normalized;
}

export function parseBrokerEndpoint(endpoint, options = {}) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("Missing broker endpoint.");
  }

  if (endpoint.startsWith("pipe:")) {
    const pipePath = endpoint.slice("pipe:".length);
    if (!pipePath) {
      throw new Error("Broker pipe endpoint is missing its path.");
    }
    return { kind: "pipe", path: pipePath };
  }

  if (endpoint.startsWith("unix:")) {
    const socketPath = endpoint.slice("unix:".length);
    if (!socketPath) {
      throw new Error("Broker Unix socket endpoint is missing its path.");
    }
    return { kind: "unix", path: normalizeUnixSocketPath(socketPath, options) };
  }

  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}
