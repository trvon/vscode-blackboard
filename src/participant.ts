/**
 * @blackboard chat participant.
 *
 * Registers a VS Code chat participant that responds to natural language
 * queries about blackboard state by delegating to the registered bb_* tools.
 */

import * as vscode from "vscode";
import type { YamsBlackboard } from "./blackboard/blackboard.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(defaultAgentId: string): string {
    return `You are the YAMS Blackboard assistant. You help users interact with the
multi-agent coordination blackboard built on YAMS.

Autonomous operation guidelines:
- Treat the user message as a task request and drive the blackboard proactively.
- Prefer calling tools over asking the user for IDs.
- You have a default agent identity available: agent_id = "${defaultAgentId}".
- For tools that accept agent_id/created_by, you may omit them; the host will default them.
- When you need a snapshot, use bb_stats and/or bb_recent_activity.
- When creating work, prefer: bb_create_context -> bb_create_task -> bb_claim_task (if applicable) -> bb_post_finding.

You have access to the following tool families (all prefixed with "bb_"):

**Agents:** bb_register_agent, bb_list_agents
**Findings:** bb_post_finding, bb_query_findings, bb_search_findings, bb_get_finding, bb_acknowledge_finding, bb_resolve_finding
**Tasks:** bb_create_task, bb_get_ready_tasks, bb_claim_task, bb_update_task, bb_complete_task, bb_fail_task, bb_query_tasks
**Contexts:** bb_create_context, bb_get_context_summary, bb_set_context
**Search & Stats:** bb_recent_activity, bb_stats, bb_connections
**Notifications:** bb_subscribe, bb_unsubscribe, bb_list_subscriptions, bb_check_notifications, bb_notification_count, bb_mark_notification_read, bb_mark_all_read, bb_dismiss_notification

When users ask about blackboard state, invoke the appropriate tool(s) and present the results clearly.
When the query is ambiguous, prefer showing a summary (bb_stats or bb_recent_activity) first.
Always be concise and format output for readability.`;
}

// ---------------------------------------------------------------------------
// Tool names we want the model to have access to
// ---------------------------------------------------------------------------

const BB_TOOL_NAMES = [
    "bb_register_agent",
    "bb_list_agents",
    "bb_post_finding",
    "bb_query_findings",
    "bb_search_findings",
    "bb_get_finding",
    "bb_acknowledge_finding",
    "bb_resolve_finding",
    "bb_create_task",
    "bb_get_ready_tasks",
    "bb_claim_task",
    "bb_update_task",
    "bb_complete_task",
    "bb_fail_task",
    "bb_query_tasks",
    "bb_create_context",
    "bb_get_context_summary",
    "bb_set_context",
    "bb_recent_activity",
    "bb_stats",
    "bb_connections",
    "bb_subscribe",
    "bb_unsubscribe",
    "bb_list_subscriptions",
    "bb_check_notifications",
    "bb_notification_count",
    "bb_mark_notification_read",
    "bb_mark_all_read",
    "bb_dismiss_notification",
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleRequest(
    bb: YamsBlackboard,
    defaultAgentId: string,
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
): Promise<void> {
    void bb; // tools are the integration point

    // Select a language model
    let models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    if (models.length === 0) {
        models = await vscode.lm.selectChatModels();
    }
    const [model] = models;

    if (!model) {
        stream.markdown(
            "No language model available. Make sure GitHub Copilot is active.",
        );
        return;
    }

    // Build tool references for the tools we registered
    const allTools = vscode.lm.tools;
    const bbTools = allTools.filter((t) =>
        BB_TOOL_NAMES.includes(t.name),
    );

    // Assemble messages
    const systemPrompt = buildSystemPrompt(defaultAgentId);
    const asSystem = (vscode.LanguageModelChatMessage as any).System;
    const systemMessage =
        typeof asSystem === "function"
            ? asSystem(systemPrompt)
            : vscode.LanguageModelChatMessage.User(systemPrompt);

    const messages = [
        systemMessage,
        vscode.LanguageModelChatMessage.User(request.prompt),
    ];

    // Run the model with tool access
    const response = await model.sendRequest(
        messages,
        { tools: bbTools },
        token,
    );

    // Stream the response, handling tool calls
    const maxToolRounds = 10;
    let currentResponse = response;

    for (let round = 0; round < maxToolRounds; round++) {
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        let hasText = false;

        for await (const part of currentResponse.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                stream.markdown(part.value);
                hasText = true;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
            }
        }

        // If no tool calls, we're done
        if (toolCalls.length === 0) {
            break;
        }

        // Execute tool calls and feed results back
        const toolResults: vscode.LanguageModelChatMessage[] = [];

        for (const call of toolCalls) {
            if (token.isCancellationRequested) {
                return;
            }

            try {
                const result = await vscode.lm.invokeTool(
                    call.name,
                    {
                        input: call.input,
                        toolInvocationToken: request.toolInvocationToken,
                    },
                    token,
                );

                // Extract text from the result
                const textParts: string[] = [];
                for (const p of result.content) {
                    if (p instanceof vscode.LanguageModelTextPart) {
                        textParts.push(p.value);
                    }
                }

                toolResults.push(
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(
                            call.callId,
                            [new vscode.LanguageModelTextPart(textParts.join("\n"))],
                        ),
                    ]),
                );
            } catch (err) {
                const errMsg =
                    err instanceof Error ? err.message : String(err);
                toolResults.push(
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(
                            call.callId,
                            [new vscode.LanguageModelTextPart(`Error: ${errMsg}`)],
                        ),
                    ]),
                );
            }
        }

        // Continue the conversation with tool results
        messages.push(
            vscode.LanguageModelChatMessage.Assistant(toolCalls),
            ...toolResults,
        );

        currentResponse = await model.sendRequest(
            messages,
            { tools: bbTools },
            token,
        );
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerParticipant(
    context: vscode.ExtensionContext,
    bb: YamsBlackboard,
    defaultAgentId: string,
): void {
    const participant = vscode.chat.createChatParticipant(
        "blackboard",
        (request, chatContext, stream, token) =>
            handleRequest(bb, defaultAgentId, request, chatContext, stream, token),
    );

    participant.iconPath = new vscode.ThemeIcon("circuit-board");

    context.subscriptions.push(participant);
}
