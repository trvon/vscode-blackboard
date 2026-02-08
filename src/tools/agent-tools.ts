/**
 * Agent management tools: bb_register_agent, bb_list_agents
 */

import * as vscode from "vscode";
import type { YamsBlackboard } from "../blackboard/blackboard.js";

// ---------------------------------------------------------------------------
// bb_register_agent
// ---------------------------------------------------------------------------

interface RegisterAgentInput {
    id: string;
    name: string;
    capabilities: string[];
}

class RegisterAgentTool implements vscode.LanguageModelTool<RegisterAgentInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RegisterAgentInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { id, name, capabilities } = options.input;
        const agent = await this.bb.registerAgent({
            id,
            name,
            capabilities,
            status: "active",
        });
        const text = `Agent registered: ${agent.id}\nCapabilities: ${agent.capabilities.join(", ")}\nRegistered at: ${agent.registered_at}`;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_list_agents
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface ListAgentsInput {}

class ListAgentsTool implements vscode.LanguageModelTool<ListAgentsInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<ListAgentsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const agents = await this.bb.listAgents();
        if (agents.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart("No agents registered yet."),
            ]);
        }
        const text = agents
            .map(
                (a) =>
                    `${a.id} (${a.status})\n  Name: ${a.name}\n  Capabilities: ${a.capabilities.join(", ")}`,
            )
            .join("\n\n");
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAgentTools(
    context: vscode.ExtensionContext,
    bb: YamsBlackboard,
): void {
    context.subscriptions.push(
        vscode.lm.registerTool("bb_register_agent", new RegisterAgentTool(bb)),
        vscode.lm.registerTool("bb_list_agents", new ListAgentsTool(bb)),
    );
}
