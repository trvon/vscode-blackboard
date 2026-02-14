/**
 * Search & utility tools: bb_recent_activity, bb_stats, bb_connections,
 * bb_search, bb_grep
 */

import * as vscode from "vscode";
import type { YamsBlackboard } from "../blackboard/blackboard.js";

// ---------------------------------------------------------------------------
// bb_recent_activity
// ---------------------------------------------------------------------------

interface RecentActivityInput {
    limit?: number;
}

class RecentActivityTool
    implements vscode.LanguageModelTool<RecentActivityInput>
{
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RecentActivityInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const limit = (options.input as RecentActivityInput | undefined)?.limit ?? 10;
        const findings = await this.bb.queryFindings({ limit, offset: 0 });
        const tasks = await this.bb.queryTasks({ limit, offset: 0 });

        const output: string[] = ["## Recent Activity\n"];

        if (findings.length > 0) {
            output.push("### Findings");
            output.push(
                findings
                    .map((f) => `- [${f.topic}] ${f.title} (${f.agent_id})`)
                    .join("\n"),
            );
        }

        if (tasks.length > 0) {
            output.push("\n### Tasks");
            output.push(
                tasks
                    .map((t) => `- [${t.status}] ${t.title} (${t.type})`)
                    .join("\n"),
            );
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(output.join("\n")),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_stats
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface StatsInput {}

class StatsTool implements vscode.LanguageModelTool<StatsInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<StatsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const stats = await this.bb.getStats();

        const text = `## Blackboard Statistics

### Agents: ${stats.agents}

### Findings: ${stats.findings.total}
By Topic: ${Object.entries(stats.findings.by_topic).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}
By Status: ${Object.entries(stats.findings.by_status).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}
By Severity: ${Object.entries(stats.findings.by_severity).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}

### Tasks: ${stats.tasks.total}
By Status: ${Object.entries(stats.tasks.by_status).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}
By Type: ${Object.entries(stats.tasks.by_type).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_connections
// ---------------------------------------------------------------------------

interface ConnectionsInput {
    path: string;
    depth?: number;
}

class ConnectionsTool implements vscode.LanguageModelTool<ConnectionsInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ConnectionsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<ConnectionsInput>;
        const { path, depth } = input;
        if (!path) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { path: string, depth?: number }",
                ),
            ]);
        }
        const graph = await this.bb.getConnections(path, depth ?? 2);

        if (graph.nodes.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart("No connections found."),
            ]);
        }

        const text = `## Connections for ${path}

Found ${graph.nodes.length} connected nodes:

${JSON.stringify(graph.nodes, null, 2)}`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_search
// ---------------------------------------------------------------------------

interface SearchInput {
    query: string;
    instance_id?: string;
    limit?: number;
}

class SearchTool implements vscode.LanguageModelTool<SearchInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<SearchInput>;
        const query = input.query?.trim();
        if (!query) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { query: string, instance_id?: string, limit?: number }",
                ),
            ]);
        }

        const results = await this.bb.search(query, {
            instance_id: input.instance_id,
            limit: input.limit ?? 20,
        });

        const output: string[] = [];

        if (results.findings.length > 0) {
            output.push("### Findings");
            output.push(
                results.findings
                    .map(
                        (f) =>
                            `[${f.id}] ${f.topic.toUpperCase()} | ${f.title}\n  ${f.content.slice(0, 150)}${f.content.length > 150 ? "..." : ""}`,
                    )
                    .join("\n\n"),
            );
        }

        if (results.tasks.length > 0) {
            output.push("\n### Tasks");
            output.push(
                results.tasks
                    .map(
                        (t) =>
                            `[${t.id}] P${t.priority} ${t.type.toUpperCase()} | ${t.title}\n  Status: ${t.status}`,
                    )
                    .join("\n\n"),
            );
        }

        if (output.length === 0) {
            output.push("No results match the search.");
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(output.join("\n")),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_grep
// ---------------------------------------------------------------------------

interface GrepInput {
    pattern: string;
    entity?: "finding" | "task";
    instance_id?: string;
    limit?: number;
}

class GrepTool implements vscode.LanguageModelTool<GrepInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GrepInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<GrepInput>;
        const pattern = input.pattern?.trim();
        if (!pattern) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { pattern: string, entity?: 'finding'|'task', instance_id?: string, limit?: number }",
                ),
            ]);
        }

        const results = await this.bb.grep(pattern, {
            entity: input.entity,
            instance_id: input.instance_id,
            limit: input.limit ?? 50,
        });

        if (results.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart("No matches found."),
            ]);
        }

        const text = results
            .map(
                (r) =>
                    `**${r.name}**\n${r.matches.slice(0, 5).map((m) => `  ${m}`).join("\n")}${r.matches.length > 5 ? `\n  ... and ${r.matches.length - 5} more matches` : ""}`,
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

export function registerSearchTools(
    context: vscode.ExtensionContext,
    bb: YamsBlackboard,
): void {
    context.subscriptions.push(
        vscode.lm.registerTool("bb_recent_activity", new RecentActivityTool(bb)),
        vscode.lm.registerTool("bb_stats", new StatsTool(bb)),
        vscode.lm.registerTool("bb_connections", new ConnectionsTool(bb)),
        vscode.lm.registerTool("bb_search", new SearchTool(bb)),
        vscode.lm.registerTool("bb_grep", new GrepTool(bb)),
    );
}
