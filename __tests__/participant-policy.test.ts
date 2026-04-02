import test from "node:test";
import assert from "node:assert/strict";

import {
  getReadOnlyToolNames,
  getWriteToolNames,
  isReadOnlyAllowedTool,
  isWriteTool,
  sanitizeToolInput,
  sanitizeToolInputForReadOnly,
  shouldEnableWriteTools,
} from "../src/participant-policy.js";

test("bb_set_context is not treated as read-only", () => {
  assert.equal(isReadOnlyAllowedTool("bb_set_context"), false);
  assert.equal(getReadOnlyToolNames().includes("bb_set_context"), false);
});

test("bb_set_context remains a write tool", () => {
  assert.equal(isWriteTool("bb_set_context"), true);
  assert.equal(getWriteToolNames().includes("bb_set_context"), true);
});

test("bb_check_notifications remains available in read-only mode", () => {
  assert.equal(isReadOnlyAllowedTool("bb_check_notifications"), true);
  assert.equal(isWriteTool("bb_check_notifications"), false);
});

test("sanitizeToolInputForReadOnly strips mark_as_read from notifications check", () => {
  const input = {
    agent_id: "vscode-test",
    limit: 5,
    mark_as_read: true,
  };

  assert.deepEqual(sanitizeToolInputForReadOnly("bb_check_notifications", input), {
    agent_id: "vscode-test",
    limit: 5,
  });
});

test("sanitizeToolInputForReadOnly leaves unrelated tools untouched", () => {
  const input = { context_id: "ctx-1" };
  assert.deepEqual(sanitizeToolInputForReadOnly("bb_set_context", input), input);
});

test("sanitizeToolInput returns object-shaped input for invokeTool", () => {
  assert.deepEqual(sanitizeToolInput("bb_check_notifications", undefined, false), {});
  assert.deepEqual(sanitizeToolInput("bb_check_notifications", { mark_as_read: true }, false), {});
  assert.deepEqual(sanitizeToolInput("bb_check_notifications", { mark_as_read: true }, true), {
    mark_as_read: true,
  });
});

test("shouldEnableWriteTools allows writes for explicit write tool references", () => {
  assert.equal(
    shouldEnableWriteTools({
      prompt: "show me notifications",
      toolReferences: [{ name: "bb_set_context" }],
    }),
    true,
  );
});

test("shouldEnableWriteTools stays read-only for notification reads", () => {
  assert.equal(
    shouldEnableWriteTools({
      prompt: "show me my notifications",
      toolReferences: [{ name: "bb_check_notifications" }],
    }),
    false,
  );
});
