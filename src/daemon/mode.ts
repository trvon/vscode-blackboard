import * as fs from "node:fs";
import * as path from "node:path";

export type DaemonMode = "socket" | "embedded" | "auto";

export interface ExtensionTransportState {
  status: "unsupported" | "socket-ready" | "waiting-for-socket";
  canAttemptConnect: boolean;
  shouldPoll: boolean;
}

function stripInlineComment(value: string): string {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "#" && !inSingle && !inDouble) {
      return value.slice(0, i).trim();
    }
  }

  return value.trim();
}

function parseDaemonConfigValue(text: string, key: string): string | undefined {
  let inDaemonSection = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      inDaemonSection = line === "[daemon]";
      continue;
    }

    if (!inDaemonSection) {
      continue;
    }

    const match = line.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
    if (!match) {
      continue;
    }

    const rhs = stripInlineComment(match[1]);
    if (!rhs) {
      return undefined;
    }

    return (rhs.startsWith('"') && rhs.endsWith('"')) ||
        (rhs.startsWith("'") && rhs.endsWith("'"))
      ? rhs.slice(1, -1)
      : rhs;
  }

  return undefined;
}

export function normalizeDaemonMode(raw: string | undefined | null): DaemonMode | undefined {
  if (!raw) {
    return undefined;
  }

  const value = raw.trim().toLowerCase();
  if (!value) {
    return undefined;
  }

  if (value === "auto") {
    return "auto";
  }

  if (["1", "true", "on", "yes", "embedded", "in_process", "in-process"].includes(value)) {
    return "embedded";
  }

  if (["0", "false", "off", "no", "socket", "daemon"].includes(value)) {
    return "socket";
  }

  return undefined;
}

export function parseDaemonModeFromConfig(text: string): DaemonMode | undefined {
  const value = parseDaemonConfigValue(text, "mode");
  return normalizeDaemonMode(value);
}

export function parseDaemonSocketPathFromConfig(text: string): string | undefined {
  return parseDaemonConfigValue(text, "socket_path");
}

export function defaultConfigPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (env.YAMS_CONFIG) {
    return env.YAMS_CONFIG;
  }

  if (platform === "win32") {
    return env.APPDATA ? path.join(env.APPDATA, "yams", "config.toml") : undefined;
  }

  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, "yams", "config.toml");
  }

  return env.HOME ? path.join(env.HOME, ".config", "yams", "config.toml") : undefined;
}

export function resolveDaemonMode(opts?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFile?: (filePath: string) => string | undefined;
}): DaemonMode | undefined {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const readFile =
    opts?.readFile ??
    ((filePath: string) => {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch {
        return undefined;
      }
    });

  const envMode = normalizeDaemonMode(env.YAMS_EMBEDDED);
  if (envMode) {
    return envMode;
  }

  const configPath = defaultConfigPath(env, platform);
  if (!configPath) {
    return undefined;
  }

  const configText = readFile(configPath);
  if (!configText) {
    return undefined;
  }

  return parseDaemonModeFromConfig(configText);
}

export function resolveExtensionTransportState(
  mode: DaemonMode | undefined,
  hasSocket: boolean,
): ExtensionTransportState {
  if (mode === "embedded") {
    return {
      status: "unsupported",
      canAttemptConnect: false,
      shouldPoll: false,
    };
  }

  if (hasSocket) {
    return {
      status: "socket-ready",
      canAttemptConnect: true,
      shouldPoll: true,
    };
  }

  return {
    status: "waiting-for-socket",
    canAttemptConnect: false,
    shouldPoll: true,
  };
}
