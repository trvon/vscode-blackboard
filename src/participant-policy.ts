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
] as const;

const READ_ONLY_TOOL_NAMES = [
    "bb_list_agents",
    "bb_query_findings",
    "bb_search_findings",
    "bb_get_finding",
    "bb_get_ready_tasks",
    "bb_query_tasks",
    "bb_search_tasks",
    "bb_get_context_summary",
    "bb_recent_activity",
    "bb_stats",
    "bb_connections",
    "bb_search",
    "bb_grep",
    "bb_list_subscriptions",
    "bb_check_notifications",
    "bb_notification_count",
] as const;

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
    "bb_set_context",
    "bb_subscribe",
    "bb_unsubscribe",
    "bb_mark_notification_read",
    "bb_mark_all_read",
    "bb_dismiss_notification",
] as const;

export function getBlackboardToolNames(): readonly string[] {
    return BB_TOOL_NAMES;
}

export function getReadOnlyToolNames(): readonly string[] {
    return READ_ONLY_TOOL_NAMES;
}

export function getWriteToolNames(): readonly string[] {
    return WRITE_TOOL_NAMES;
}

export function isKnownToolName(name: string): boolean {
    return BB_TOOL_NAMES.includes(name as (typeof BB_TOOL_NAMES)[number]);
}

export function isReadOnlyAllowedTool(name: string): boolean {
    return READ_ONLY_TOOL_NAMES.includes(name as (typeof READ_ONLY_TOOL_NAMES)[number]);
}

export function isWriteTool(name: string): boolean {
    return WRITE_TOOL_NAMES.includes(name as (typeof WRITE_TOOL_NAMES)[number]);
}

export function shouldEnableWriteTools(request: {
    prompt?: string;
    toolReferences: ReadonlyArray<{ name: string }>;
}): boolean {
    const referenced = new Set(request.toolReferences.map((t) => t.name));
    for (const t of WRITE_TOOL_NAMES) {
        if (referenced.has(t)) return true;
    }

    const p = (request.prompt ?? "").toLowerCase();
    if (!p) return false;

    const writeIntent =
        /\b(post|record|log|save|store|create|open|file|add|update|resolve|acknowledge|claim|complete|fail|subscribe|unsubscribe)\b/.test(
            p,
        ) &&
        /\b(finding|task|context|subscription|notification|agent|blackboard)\b/.test(
            p,
        );

    return writeIntent;
}

export function shouldRunPreflight(requestPrompt: string): boolean {
    const p = (requestPrompt ?? "").toLowerCase();
    if (!p.trim()) return false;
    return /\b(show|list|stats|status|recent|activity|progress|queue|pending|claimed|working|blocked|notifications|agents|findings|tasks)\b/.test(
        p,
    );
}

export function sanitizeToolInputForReadOnly(name: string, input: unknown): unknown {
    if (name !== "bb_check_notifications") {
        return input;
    }

    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return input;
    }

    const { mark_as_read: _ignored, ...rest } = input as Record<string, unknown>;
    return rest;
}

export function sanitizeToolInput(name: string, input: unknown, allowWrites: boolean): object {
    const sanitized = allowWrites ? input : sanitizeToolInputForReadOnly(name, input);
    if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
        return {};
    }
    return sanitized;
}
