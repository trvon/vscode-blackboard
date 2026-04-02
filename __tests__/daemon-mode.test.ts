import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeDaemonMode,
  parseDaemonModeFromConfig,
  resolveDaemonMode,
  resolveExtensionTransportState,
} from "../src/daemon/mode.js";

test("normalizeDaemonMode maps explicit embedded values", () => {
  assert.equal(normalizeDaemonMode("true"), "embedded");
  assert.equal(normalizeDaemonMode("embedded"), "embedded");
  assert.equal(normalizeDaemonMode("in_process"), "embedded");
});

test("normalizeDaemonMode maps explicit socket values", () => {
  assert.equal(normalizeDaemonMode("false"), "socket");
  assert.equal(normalizeDaemonMode("socket"), "socket");
  assert.equal(normalizeDaemonMode("daemon"), "socket");
});

test("normalizeDaemonMode preserves auto and ignores unknown values", () => {
  assert.equal(normalizeDaemonMode("auto"), "auto");
  assert.equal(normalizeDaemonMode("maybe"), undefined);
  assert.equal(normalizeDaemonMode("   "), undefined);
});

test("parseDaemonModeFromConfig reads daemon.mode from daemon section", () => {
  const config = [
    "[core]",
    'data_dir = "/tmp/yams"',
    "",
    "[daemon]",
    'mode = "embedded"',
  ].join("\n");

  assert.equal(parseDaemonModeFromConfig(config), "embedded");
});

test("parseDaemonModeFromConfig ignores comments and later sections", () => {
  const config = [
    "[daemon]",
    'mode = "auto" # comment',
    "",
    "[search]",
    'mode = "embedded"',
  ].join("\n");

  assert.equal(parseDaemonModeFromConfig(config), "auto");
});

test("resolveDaemonMode prefers YAMS_EMBEDDED over config", () => {
  const env = {
    YAMS_EMBEDDED: "false",
    YAMS_CONFIG: "/tmp/config.toml",
  } as NodeJS.ProcessEnv;

  const mode = resolveDaemonMode({
    env,
    readFile: () => '[daemon]\nmode = "embedded"\n',
  });

  assert.equal(mode, "socket");
});

test("resolveDaemonMode reads explicit YAMS_CONFIG when env unset", () => {
  const env = {
    YAMS_CONFIG: "/tmp/config.toml",
  } as NodeJS.ProcessEnv;

  const mode = resolveDaemonMode({
    env,
    readFile: (filePath) => {
      assert.equal(filePath, "/tmp/config.toml");
      return '[daemon]\nmode = "embedded"\n';
    },
  });

  assert.equal(mode, "embedded");
});

test("resolveExtensionTransportState marks explicit embedded mode unsupported", () => {
  assert.deepEqual(resolveExtensionTransportState("embedded", false), {
    status: "unsupported",
    canAttemptConnect: false,
    shouldPoll: false,
  });
});

test("resolveExtensionTransportState waits for socket in auto mode when missing", () => {
  assert.deepEqual(resolveExtensionTransportState("auto", false), {
    status: "waiting-for-socket",
    canAttemptConnect: false,
    shouldPoll: true,
  });
});

test("resolveExtensionTransportState connects when socket is available", () => {
  assert.deepEqual(resolveExtensionTransportState(undefined, true), {
    status: "socket-ready",
    canAttemptConnect: true,
    shouldPoll: true,
  });
});
