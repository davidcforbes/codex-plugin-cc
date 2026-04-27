import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process|no tasks are running/i.test(text);
}

function normalizePid(pid) {
  const numericPid = Number(pid);
  return Number.isInteger(numericPid) && numericPid > 0 ? numericPid : null;
}

function canSignalProcess(pid, killImpl) {
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function windowsTasklistOutputContainsPid(output, pid) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => line.split(",").some((cell) => cell.replace(/^"|"$/g, "").trim() === String(pid)));
}

export function isProcessAlive(pid, options = {}) {
  const normalizedPid = normalizePid(pid);
  if (normalizedPid === null) {
    return false;
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("tasklist", ["/FI", `PID eq ${normalizedPid}`, "/FO", "CSV", "/NH"], {
      cwd: options.cwd,
      env: {
        ...(options.env ?? process.env),
        MSYS_NO_PATHCONV: "1"
      },
      maxBuffer: 1024 * 1024,
      shell: false
    });

    if (result.error?.code === "ENOENT") {
      return canSignalProcess(normalizedPid, killImpl);
    }
    if (result.error) {
      throw result.error;
    }

    const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
    if (looksLikeMissingProcessMessage(combinedOutput)) {
      return false;
    }
    if (result.status !== 0) {
      throw new Error(formatCommandFailure(result));
    }
    return windowsTasklistOutputContainsPid(combinedOutput, normalizedPid);
  }

  return canSignalProcess(normalizedPid, killImpl);
}

export function terminateProcessTree(pid, options = {}) {
  const normalizedPid = normalizePid(pid);
  if (normalizedPid === null) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(normalizedPid), "/T", "/F"], {
      cwd: options.cwd,
      env: {
        ...(options.env ?? process.env),
        MSYS_NO_PATHCONV: "1"
      },
      shell: false
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(normalizedPid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  if (options.processGroup === true) {
    try {
      killImpl(-normalizedPid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process-group" };
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process-group" };
      }
      try {
        killImpl(normalizedPid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }
  }

  try {
    killImpl(normalizedPid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process" };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { attempted: true, delivered: false, method: "process" };
    }
    throw error;
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
