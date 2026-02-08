/**
 * Finding management tools: bb_post_finding, bb_query_findings,
 * bb_search_findings, bb_get_finding, bb_acknowledge_finding, bb_resolve_finding
 */

import * as vscode from "vscode";
import type { YamsBlackboard } from "../blackboard/blackboard.js";
import type {
    FindingTopic,
    FindingSeverity,
    FindingStatus,
    FindingScope,
} from "../blackboard/types.js";

// Shared context state accessor
export type GetCurrentContext = () => string | undefined;

// ---------------------------------------------------------------------------
// bb_post_finding
// ---------------------------------------------------------------------------

interface PostFindingInput {
    agent_id?: string;
    topic: string;
    title: string;
    content: string;
    confidence?: number;
    severity?: string;
    references?: Array<{
        type: string;
        target: string;
        label?: string;
        line_start?: number;
        line_end?: number;
    }>;
    context_id?: string;
    parent_id?: string;
    scope?: string;
    metadata?: Record<string, string>;
}

class PostFindingTool implements vscode.LanguageModelTool<PostFindingInput> {
    constructor(
        private readonly bb: YamsBlackboard,
        private readonly getCtx: GetCurrentContext,
        private readonly defaultAgentId: string,
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<PostFindingInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const args = (options.input ?? {}) as Partial<PostFindingInput>;
        const agentId = args.agent_id || this.defaultAgentId;
        if (!agentId || !args.topic || !args.title || !args.content) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { topic: string, title: string, content: string, agent_id?: string, ... }",
                ),
            ]);
        }
        const finding = await this.bb.postFinding({
            agent_id: agentId,
            topic: args.topic as FindingTopic,
            title: args.title,
            content: args.content,
            confidence: args.confidence ?? 0.8,
            severity: args.severity as FindingSeverity | undefined,
            references: args.references as any,
            context_id: args.context_id || this.getCtx(),
            parent_id: args.parent_id,
            scope: (args.scope as FindingScope) ?? "persistent",
            metadata: args.metadata,
        });

        const text = `Finding posted: ${finding.id}
Topic: ${finding.topic}
Title: ${finding.title}
Confidence: ${finding.confidence}
${finding.severity ? `Severity: ${finding.severity}` : ""}
${finding.context_id ? `Context: ${finding.context_id}` : ""}`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_query_findings
// ---------------------------------------------------------------------------

interface QueryFindingsInput {
    topic?: string;
    agent_id?: string;
    context_id?: string;
    status?: string;
    severity?: string[];
    min_confidence?: number;
    scope?: string;
    limit?: number;
}

class QueryFindingsTool implements vscode.LanguageModelTool<QueryFindingsInput> {
    constructor(
        private readonly bb: YamsBlackboard,
        private readonly getCtx: GetCurrentContext,
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<QueryFindingsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const args = (options.input ?? {}) as Partial<QueryFindingsInput>;
        const findings = await this.bb.queryFindings({
            topic: args.topic as FindingTopic | undefined,
            agent_id: args.agent_id,
            context_id: args.context_id || this.getCtx(),
            status: args.status as FindingStatus | undefined,
            severity: args.severity as FindingSeverity[] | undefined,
            min_confidence: args.min_confidence,
            scope: args.scope as FindingScope | undefined,
            limit: args.limit ?? 20,
            offset: 0,
        });

        if (findings.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart("No findings match the query."),
            ]);
        }

        const text = findings
            .map(
                (f) =>
                    `[${f.id}] ${f.topic.toUpperCase()} | ${f.title}\n  Agent: ${f.agent_id} | Confidence: ${f.confidence.toFixed(2)}${f.severity ? ` | Severity: ${f.severity}` : ""}\n  Status: ${f.status}${f.context_id ? ` | Context: ${f.context_id}` : ""}`,
            )
            .join("\n\n");

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_search_findings
// ---------------------------------------------------------------------------

interface SearchFindingsInput {
    query: string;
    topic?: string;
    limit?: number;
}

class SearchFindingsTool implements vscode.LanguageModelTool<SearchFindingsInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchFindingsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const args = (options.input ?? {}) as Partial<SearchFindingsInput>;
        if (!args.query) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { query: string, topic?: string, limit?: number }",
                ),
            ]);
        }
        const findings = await this.bb.searchFindings(args.query, {
            topic: args.topic,
            limit: args.limit ?? 10,
        });

        if (findings.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart("No findings match the search."),
            ]);
        }

        const text = findings
            .map(
                (f) =>
                    `[${f.id}] ${f.topic.toUpperCase()} | ${f.title}\n  ${f.content.slice(0, 200)}${f.content.length > 200 ? "..." : ""}`,
            )
            .join("\n\n");

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_get_finding
// ---------------------------------------------------------------------------

interface GetFindingInput {
    finding_id: string;
}

class GetFindingTool implements vscode.LanguageModelTool<GetFindingInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetFindingInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<GetFindingInput>;
        if (!input.finding_id) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { finding_id: string }",
                ),
            ]);
        }
        const finding = await this.bb.getFinding(input.finding_id);
        if (!finding) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Finding not found: ${input.finding_id}`,
                ),
            ]);
        }

        const text = `# ${finding.title}

**ID:** ${finding.id}
**Agent:** ${finding.agent_id}
**Topic:** ${finding.topic}
**Status:** ${finding.status}
**Confidence:** ${finding.confidence}
${finding.severity ? `**Severity:** ${finding.severity}` : ""}
${finding.context_id ? `**Context:** ${finding.context_id}` : ""}
${finding.references?.length ? `**References:** ${finding.references.map((r) => `${r.type}:${r.target}`).join(", ")}` : ""}

## Content

${finding.content}`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_acknowledge_finding
// ---------------------------------------------------------------------------

interface AcknowledgeFindingInput {
    finding_id: string;
    agent_id?: string;
}

class AcknowledgeFindingTool
    implements vscode.LanguageModelTool<AcknowledgeFindingInput>
{
    constructor(
        private readonly bb: YamsBlackboard,
        private readonly defaultAgentId: string,
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AcknowledgeFindingInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<AcknowledgeFindingInput>;
        const { finding_id } = input;
        const agentId = input.agent_id || this.defaultAgentId;
        if (!finding_id || !agentId) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { finding_id: string, agent_id?: string }",
                ),
            ]);
        }
        await this.bb.acknowledgeFinding(finding_id, agentId);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Finding ${finding_id} acknowledged by ${agentId}`,
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_resolve_finding
// ---------------------------------------------------------------------------

interface ResolveFindingInput {
    finding_id: string;
    agent_id?: string;
    resolution: string;
}

class ResolveFindingTool
    implements vscode.LanguageModelTool<ResolveFindingInput>
{
    constructor(
        private readonly bb: YamsBlackboard,
        private readonly defaultAgentId: string,
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ResolveFindingInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<ResolveFindingInput>;
        const { finding_id, resolution } = input;
        const agentId = input.agent_id || this.defaultAgentId;
        if (!finding_id || !agentId || !resolution) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { finding_id: string, resolution: string, agent_id?: string }",
                ),
            ]);
        }
        await this.bb.resolveFinding(finding_id, agentId, resolution);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Finding ${finding_id} resolved by ${agentId}: ${resolution}`,
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFindingTools(
    context: vscode.ExtensionContext,
    bb: YamsBlackboard,
    getCtx: GetCurrentContext,
    defaultAgentId: string,
): void {
    context.subscriptions.push(
        vscode.lm.registerTool(
            "bb_post_finding",
            new PostFindingTool(bb, getCtx, defaultAgentId),
        ),
        vscode.lm.registerTool("bb_query_findings", new QueryFindingsTool(bb, getCtx)),
        vscode.lm.registerTool("bb_search_findings", new SearchFindingsTool(bb)),
        vscode.lm.registerTool("bb_get_finding", new GetFindingTool(bb)),
        vscode.lm.registerTool(
            "bb_acknowledge_finding",
            new AcknowledgeFindingTool(bb, defaultAgentId),
        ),
        vscode.lm.registerTool(
            "bb_resolve_finding",
            new ResolveFindingTool(bb, defaultAgentId),
        ),
    );
}
