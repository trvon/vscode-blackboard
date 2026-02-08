/**
 * YAMS Blackboard — VS Code Extension Entry Point
 *
 * Activates the extension by connecting to the YAMS daemon over Unix domain
 * socket IPC, instantiating the blackboard business logic, registering all
 * bb_* language model tools, and setting up the @blackboard chat participant.
 */

import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { YamsDaemonClient } from "./daemon/client.js";
import { socketExists, resolveSocketPath } from "./daemon/socket.js";
import { YamsBlackboard } from "./blackboard/blackboard.js";
import type { ContextState } from "./tools/context-tools.js";
import { registerAgentTools } from "./tools/agent-tools.js";
import { registerFindingTools } from "./tools/finding-tools.js";
import { registerTaskTools } from "./tools/task-tools.js";
import { registerContextTools } from "./tools/context-tools.js";
import { registerSearchTools } from "./tools/search-tools.js";
import { registerNotificationTools } from "./tools/notification-tools.js";
import { registerParticipant } from "./participant.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let client: YamsDaemonClient | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

// ---------------------------------------------------------------------------
// Status bar helpers
// ---------------------------------------------------------------------------

type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

function updateStatusBar(status: ConnectionStatus): void {
    if (!statusBarItem) return;

    switch (status) {
        case "connected":
            statusBarItem.text = "$(circuit-board) Blackboard";
            statusBarItem.tooltip = "YAMS Blackboard: Connected";
            statusBarItem.backgroundColor = undefined;
            break;
        case "disconnected":
            statusBarItem.text = "$(circle-slash) Blackboard";
            statusBarItem.tooltip =
                "YAMS Blackboard: Disconnected — daemon not running";
            statusBarItem.backgroundColor = new vscode.ThemeColor(
                "statusBarItem.warningBackground",
            );
            break;
        case "reconnecting":
            statusBarItem.text = "$(sync~spin) Blackboard";
            statusBarItem.tooltip = "YAMS Blackboard: Reconnecting...";
            statusBarItem.backgroundColor = new vscode.ThemeColor(
                "statusBarItem.warningBackground",
            );
            break;
    }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export async function activate(
    context: vscode.ExtensionContext,
): Promise<void> {
    // 1. Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        50,
    );
    statusBarItem.name = "YAMS Blackboard";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 2. Create daemon client
    client = new YamsDaemonClient({
        autoReconnect: true,
        maxReconnectAttempts: Infinity,
        reconnectBaseMs: 1_000,
        reconnectMaxMs: 30_000,
    });

    // 3. Wire connection events for status bar by subclassing is not available.
    // We track connection status via client.connected + best-effort connect loop.

    // 4. Attempt connection (non-blocking)
    updateStatusBar("disconnected");

    if (socketExists()) {
        try {
            await client.connect();
            updateStatusBar("connected");
        } catch {
            vscode.window.showWarningMessage(
                "YAMS Blackboard: Could not connect to daemon. Ensure the YAMS daemon is running.",
            );
            updateStatusBar("disconnected");
        }
    } else {
        vscode.window.showInformationMessage(
            `YAMS Blackboard: Daemon socket not found at ${resolveSocketPath()}. Tools will activate when the daemon starts.`,
        );
    }

    // 5. Create blackboard instance
    // Persist instanceId per-workspace so tags remain stable across reloads.
    const instanceIdKey = "yamsBlackboard.instanceId";
    let instanceId = context.workspaceState.get<string>(instanceIdKey);
    if (!instanceId) {
        instanceId = randomUUID();
        await context.workspaceState.update(instanceIdKey, instanceId);
    }

    const bb = new YamsBlackboard(client, {
        sessionName: "vscode-blackboard",
        defaultScope: "persistent",
        instanceId,
    });

    // 5b. Establish a default agent identity for autonomous tool usage.
    // This lets models omit agent_id/created_by in many tool calls.
    const defaultAgentIdKey = "yamsBlackboard.defaultAgentId";
    let defaultAgentId = context.workspaceState.get<string>(defaultAgentIdKey);
    if (!defaultAgentId) {
        const wsName = vscode.workspace.name
            ? vscode.workspace.name.replace(/[^a-zA-Z0-9_-]+/g, "-")
            : "workspace";
        const machine = (vscode.env.machineId || "").slice(0, 8) || "local";
        defaultAgentId = `vscode-${wsName}-${machine}`;
        await context.workspaceState.update(defaultAgentIdKey, defaultAgentId);
    }

    const defaultAgentName = vscode.workspace.name
        ? `VS Code (${vscode.workspace.name})`
        : "VS Code";
    const defaultAgentCapabilities = ["vscode", "blackboard", "copilot-chat"];

    let defaultAgentRegistered = false;
    const tryRegisterDefaultAgent = async () => {
        if (!client?.connected || defaultAgentRegistered) return;
        try {
            await bb.registerAgent({
                id: defaultAgentId!,
                name: defaultAgentName,
                capabilities: defaultAgentCapabilities,
                status: "active",
            });
            defaultAgentRegistered = true;
        } catch {
            // Best-effort: registration will retry on next successful connect.
            defaultAgentRegistered = false;
        }
    };

    // 6. Create shared context state
    const state: ContextState = { currentContextId: undefined };
    const getCtx = () => state.currentContextId;

    // 7. Register all tools
    registerAgentTools(context, bb);
    registerFindingTools(context, bb, getCtx, defaultAgentId);
    registerTaskTools(context, bb, getCtx, defaultAgentId);
    registerContextTools(context, bb, state);
    registerSearchTools(context, bb);
    registerNotificationTools(context, bb, defaultAgentId);

    // 8. Register @blackboard chat participant
    registerParticipant(context, bb, defaultAgentId);

    // 9. Session + connection management
    // IMPORTANT: do not call useSession() on every timer tick.
    // Only start the session once per successful connection.
    let connectInFlight = false;
    let sessionStarted = false;

    const ensureConnected = async () => {
        if (!client || client.connected || connectInFlight) return;
        if (!socketExists()) return;
        connectInFlight = true;
        updateStatusBar("reconnecting");
        try {
            await client.connect();
        } catch {
            // Best-effort; next tick will retry.
        } finally {
            connectInFlight = false;
        }
    };

    const startSessionOnce = () => {
        if (!client?.connected || sessionStarted) return;
        sessionStarted = true;
        bb.startSession("vscode-blackboard").catch(() => {
            // If session start fails, allow retry.
            sessionStarted = false;
        });

        // Opportunistically register the default agent once a session is active.
        void tryRegisterDefaultAgent();
    };

    // Initial best-effort session start
    startSessionOnce();

    // Initial best-effort agent registration (may fail if not connected yet)
    void tryRegisterDefaultAgent();

    // Poll connection state to update status bar + attempt connect when daemon starts.
    const poll = setInterval(() => {
        if (!client) return;
        void ensureConnected();

        if (!client.connected) {
            sessionStarted = false;
            defaultAgentRegistered = false;
            if (!connectInFlight) updateStatusBar("disconnected");
            return;
        }

        updateStatusBar("connected");
        startSessionOnce();
        void tryRegisterDefaultAgent();
    }, 5_000);
    context.subscriptions.push({ dispose: () => clearInterval(poll) });

    // 10. Ensure client cleanup
    context.subscriptions.push({
        dispose: () => {
            client?.dispose();
            client = undefined;
        },
    });
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

export function deactivate(): void {
    client?.dispose();
    client = undefined;
}
