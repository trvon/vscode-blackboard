/**
 * @blackboard chat participant.
 *
 * Registers a VS Code chat participant that responds to natural language
 * queries about blackboard state by delegating to the registered bb_* tools.
 */

import * as vscode from "vscode";
import type { YamsBlackboard } from "./blackboard/blackboard.js";

function extractAssistantHistory(chatContext: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
    const messages: vscode.LanguageModelChatMessage[] = [];

    const previousResponses = chatContext.history.filter(
        (h) => h instanceof vscode.ChatResponseTurn,
    ) as vscode.ChatResponseTurn[];

    for (const turn of previousResponses) {
        let full = "";
        for (const part of turn.response) {
            // Keep this loose for forward-compat: we only care about markdown/text.
            const md = (part as any)?.value?.value;
            if (typeof md === "string") {
                full += md;
            }
        }
        if (full.trim().length > 0) {
            messages.push(vscode.LanguageModelChatMessage.Assistant(full));
        }
    }

    return messages;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(defaultAgentId: string): string {
    return `You are the YAMS Blackboard assistant. You help users interact with the
multi-agent coordination blackboard built on YAMS.

Autonomous operation guidelines:
- Default to read-only behavior: use search/query/stats tools first.
- Only create or modify blackboard data (tasks/findings/contexts/subscriptions/notifications/agents)
  when the user explicitly asks you to record/create/update something.
- Prefer calling tools over asking the user for IDs.
- You have a default agent identity available: agent_id = "${defaultAgentId}".
- For tools that accept agent_id/created_by, you may omit them; the host will default them.
- When you need a snapshot, use bb_stats and/or bb_recent_activity.
- When the user explicitly asks to create work, prefer: bb_create_context -> bb_create_task -> bb_claim_task (if applicable) -> bb_post_finding.

You have access to the following tool families (all prefixed with "bb_"):

**Agents:** bb_register_agent, bb_list_agents
**Findings:** bb_post_finding, bb_query_findings, bb_search_findings, bb_get_finding, bb_acknowledge_finding, bb_resolve_finding
**Tasks:** bb_create_task, bb_get_ready_tasks, bb_claim_task, bb_update_task, bb_complete_task, bb_fail_task, bb_query_tasks, bb_search_tasks
**Contexts:** bb_create_context, bb_get_context_summary, bb_set_context
**Search & Stats:** bb_recent_activity, bb_stats, bb_connections, bb_search, bb_grep
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
    "bb_search_tasks",
    "bb_create_context",
    "bb_get_context_summary",
    "bb_set_context",
    "bb_recent_activity",
    "bb_stats",
    "bb_connections",
    "bb_search",
    "bb_grep",
    "bb_subscribe",
    "bb_unsubscribe",
    "bb_list_subscriptions",
    "bb_check_notifications",
    "bb_notification_count",
    "bb_mark_notification_read",
    "bb_mark_all_read",
    "bb_dismiss_notification",
];

const READ_ONLY_TOOL_NAMES = [
    "bb_list_agents",
    "bb_query_findings",
    "bb_search_findings",
    "bb_get_finding",
    "bb_get_ready_tasks",
    "bb_query_tasks",
    "bb_search_tasks",
    "bb_get_context_summary",
    "bb_set_context",
    "bb_recent_activity",
    "bb_stats",
    "bb_connections",
    "bb_search",
    "bb_grep",
    "bb_list_subscriptions",
    "bb_check_notifications",
    "bb_notification_count",
];

const WRITE_TOOL_NAMES = [
    "bb_register_agent",
    "bb_post_finding",
    "bb_acknowledge_finding",
    "bb_resolve_finding",
    "bb_create_task",
    "bb_claim_task",
    "bb_update_task",
    "bb_complete_task",
    "bb_fail_task",
    "bb_create_context",
    "bb_subscribe",
    "bb_unsubscribe",
    "bb_mark_notification_read",
    "bb_mark_all_read",
    "bb_dismiss_notification",
];

function isKnownToolName(name: string): boolean {
    return BB_TOOL_NAMES.includes(name);
}

function shouldEnableWriteTools(request: vscode.ChatRequest): boolean {
    const referenced = new Set(request.toolReferences.map((t) => t.name));
    for (const t of WRITE_TOOL_NAMES) {
        if (referenced.has(t)) return true;
    }

    const p = (request.prompt ?? "").toLowerCase();
    if (!p) return false;

    // Intent gating: only enable write tools when the user explicitly asks
    // to create/record/update blackboard state.
    const writeIntent =
        /\b(post|record|log|save|store|create|open|file|add|update|resolve|acknowledge|claim|complete|fail|subscribe|unsubscribe)\b/.test(
            p,
        ) &&
        /\b(finding|task|context|subscription|notification|agent|blackboard)\b/.test(
            p,
        );

    return writeIntent;
}

function shouldRunPreflight(requestPrompt: string): boolean {
    const p = (requestPrompt ?? "").toLowerCase();
    if (!p.trim()) return false;
    // Only preflight when the user is asking about current state.
    return /\b(show|list|stats|status|recent|activity|progress|queue|pending|claimed|working|blocked|notifications|agents|findings|tasks)\b/.test(
        p,
    );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleRequest(
    bb: YamsBlackboard,
    defaultAgentId: string,
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
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
    const allowWrites = shouldEnableWriteTools(request);
    const allowedNames = new Set(
        allowWrites
            ? [...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES]
            : READ_ONLY_TOOL_NAMES,
    );
    const bbTools = allTools.filter(
        (t) => allowedNames.has(t.name) && isKnownToolName(t.name),
    );

    // Assemble messages
    const systemPrompt = buildSystemPrompt(defaultAgentId);
    const asSystem = (vscode.LanguageModelChatMessage as any).System;
    const systemMessage =
        typeof asSystem === "function"
            ? asSystem(systemPrompt)
            : vscode.LanguageModelChatMessage.User(systemPrompt);

    const historyMessages = extractAssistantHistory(chatContext);

    const messages = [systemMessage, ...historyMessages];

    // If the user attached tool references (via #tool or paperclip), pre-run those tools.
    // VS Code guidance: use toolMode=Required to force the model to produce tool input.
    const referencedToolNames = [...new Set(request.toolReferences.map((t) => t.name))];
    const referencedTools = referencedToolNames
        .map((name) => bbTools.find((t) => t.name === name))
        .filter(Boolean) as typeof bbTools;

    // If no explicit tool refs were attached, run one lightweight context preflight
    // to improve knowledge sharing and handoff quality.
    const preflightTools: typeof bbTools = [];
    if (referencedTools.length === 0) {
        if (shouldRunPreflight(request.prompt)) {
            const recent = bbTools.find((t) => t.name === "bb_recent_activity");
            if (recent) preflightTools.push(recent);
        }
    }

    const toolsToPrime = [...new Map(
        [...preflightTools, ...referencedTools].map((t) => [t.name, t]),
    ).values()];

    for (const tool of toolsToPrime) {
        if (token.isCancellationRequested) {
            return;
        }

        stream.progress(
            tool.name === "bb_recent_activity"
                ? "Collecting blackboard context..."
                : `Running ${tool.name}...`,
        );

        const toolPrepMessages = [
            ...messages,
            vscode.LanguageModelChatMessage.User(
                `Call the tool ${tool.name} to gather context needed to answer the user's request.`,
            ),
            vscode.LanguageModelChatMessage.User(request.prompt),
        ];

        const prepResponse = await model.sendRequest(
            toolPrepMessages,
            {
                tools: [tool],
                toolMode: vscode.LanguageModelChatToolMode.Required,
            },
            token,
        );

        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        for await (const part of prepResponse.stream) {
            if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
            }
        }

        if (toolCalls.length === 0) {
            continue;
        }

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

                const textParts: string[] = [];
                for (const p of result.content) {
                    if (p instanceof vscode.LanguageModelTextPart) {
                        textParts.push(p.value);
                    }
                }

                toolResults.push(
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(textParts.join("\n")),
                        ]),
                    ]),
                );
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                toolResults.push(
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(`Error: ${errMsg}`),
                        ]),
                    ]),
                );
            }
        }

        // Append tool calls + results into the conversation context.
        messages.push(
            vscode.LanguageModelChatMessage.Assistant(toolCalls),
            ...toolResults,
        );
    }

    // Finally add the user's prompt.
    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

    // Run the model with tool access
    const response = await model.sendRequest(messages, { tools: bbTools }, token);

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

    participant.followupProvider = {
        provideFollowups: (
            _result: vscode.ChatResult,
            _chatContext: vscode.ChatContext,
            _token: vscode.CancellationToken,
        ): vscode.ProviderResult<vscode.ChatFollowup[]> => {
            // "Beads"-style: always offer a quick way to re-check task progress.
            // Followups can only route to participants contributed by this extension.
            return [
                {
                    label: "Task progress",
                    prompt:
                        "Show task progress (beads): counts by status (ready/claimed/working/completed/failed) and my assigned/claimed tasks.",
                    participant: "blackboard",
                },
                {
                    label: "My claimed tasks",
                    prompt:
                        "List tasks assigned to or claimed by my default agent. If there are many, show the top 10 most urgent.",
                    participant: "blackboard",
                },
                {
                    label: "Ready queue",
                    prompt:
                        "Show ready tasks and suggest what I should pick up next.",
                    participant: "blackboard",
                },
                {
                    label: "Recent activity",
                    prompt:
                        "Show recent blackboard activity (tasks + findings) since the last check.",
                    participant: "blackboard",
                },
            ];
        },
    };

    context.subscriptions.push(participant);
}
