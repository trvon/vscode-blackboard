/**
 * Context management tools: bb_create_context, bb_get_context_summary, bb_set_context
 */

import * as vscode from "vscode";
import type { YamsBlackboard } from "../blackboard/blackboard.js";

// Mutable context state managed by the extension
export interface ContextState {
    currentContextId: string | undefined;
}

// ---------------------------------------------------------------------------
// bb_create_context
// ---------------------------------------------------------------------------

interface CreateContextInput {
    id: string;
    name: string;
    description?: string;
    set_current?: boolean;
}

class CreateContextTool implements vscode.LanguageModelTool<CreateContextInput> {
    constructor(
        private readonly bb: YamsBlackboard,
        private readonly state: ContextState,
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CreateContextInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<CreateContextInput>;
        const { id, name, description, set_current } = input;
        if (!id || !name) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { id: string, name: string, description?: string, set_current?: boolean }",
                ),
            ]);
        }
        const context = await this.bb.createContext(id, name, description);

        if (set_current !== false) {
            this.state.currentContextId = context.id;
        }

        const text = `Context created: ${context.id}
Name: ${context.name}
${context.description ? `Description: ${context.description}` : ""}
${set_current !== false ? "(Set as current context)" : ""}`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_get_context_summary
// ---------------------------------------------------------------------------

interface GetContextSummaryInput {
    context_id?: string;
}

class GetContextSummaryTool
    implements vscode.LanguageModelTool<GetContextSummaryInput>
{
    constructor(
        private readonly bb: YamsBlackboard,
        private readonly state: ContextState,
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetContextSummaryInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<GetContextSummaryInput>;
        const contextId =
            input.context_id || this.state.currentContextId || "default";
        const summary = await this.bb.getContextSummary(contextId);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(summary),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_set_context
// ---------------------------------------------------------------------------

interface SetContextInput {
    context_id: string;
}

class SetContextTool implements vscode.LanguageModelTool<SetContextInput> {
    constructor(private readonly state: ContextState) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SetContextInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<SetContextInput>;
        if (!input.context_id) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { context_id: string }",
                ),
            ]);
        }
        this.state.currentContextId = input.context_id;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Current context set to: ${input.context_id}`,
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerContextTools(
    context: vscode.ExtensionContext,
    bb: YamsBlackboard,
    state: ContextState,
): void {
    context.subscriptions.push(
        vscode.lm.registerTool(
            "bb_create_context",
            new CreateContextTool(bb, state),
        ),
        vscode.lm.registerTool(
            "bb_get_context_summary",
            new GetContextSummaryTool(bb, state),
        ),
        vscode.lm.registerTool("bb_set_context", new SetContextTool(state)),
    );
}
