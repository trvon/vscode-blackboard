/**
 * Task management tools: bb_create_task, bb_get_ready_tasks, bb_claim_task,
 * bb_update_task, bb_complete_task, bb_fail_task, bb_query_tasks, bb_search_tasks
 */

import * as vscode from "vscode";
import type { YamsBlackboard } from "../blackboard/blackboard.js";
import type { TaskType, TaskStatus, TaskPriority } from "../blackboard/types.js";
import type { GetCurrentContext } from "./finding-tools.js";

// ---------------------------------------------------------------------------
// bb_create_task
// ---------------------------------------------------------------------------

interface CreateTaskInput {
    title: string;
    description?: string;
    type: string;
    priority?: number;
    created_by?: string;
    depends_on?: string[];
    context_id?: string;
}

class CreateTaskTool implements vscode.LanguageModelTool<CreateTaskInput> {
    constructor(
        private readonly bb: YamsBlackboard,
        private readonly getCtx: GetCurrentContext,
        private readonly defaultAgentId: string,
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CreateTaskInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const args = (options.input ?? {}) as Partial<CreateTaskInput>;
        const createdBy = args.created_by || this.defaultAgentId;
        if (!args.title || !args.type || !createdBy) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { title: string, type: string, created_by?: string, ... }",
                ),
            ]);
        }
        const task = await this.bb.createTask({
            title: args.title,
            description: args.description,
            type: args.type as TaskType,
            priority: (args.priority ?? 2) as TaskPriority,
            created_by: createdBy,
            depends_on: args.depends_on,
            context_id: args.context_id || this.getCtx(),
        });

        const text = `Task created: ${task.id}
Title: ${task.title}
Type: ${task.type}
Priority: ${task.priority}
Status: ${task.status}
${task.depends_on?.length ? `Depends on: ${task.depends_on.join(", ")}` : ""}`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_get_ready_tasks
// ---------------------------------------------------------------------------

interface GetReadyTasksInput {
    limit?: number;
}

class GetReadyTasksTool implements vscode.LanguageModelTool<GetReadyTasksInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetReadyTasksInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const tasks = await this.bb.getReadyTasks();
        const limit = (options.input as GetReadyTasksInput | undefined)?.limit ?? 10;
        const limited = tasks.slice(0, limit);

        if (limited.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart("No tasks ready to work on."),
            ]);
        }

        const text = limited
            .map(
                (t) =>
                    `[${t.id}] P${t.priority} ${t.type.toUpperCase()} | ${t.title}\n  Created by: ${t.created_by}\n  ${t.description ? `Description: ${t.description.slice(0, 100)}...` : ""}`,
            )
            .join("\n\n");

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_claim_task
// ---------------------------------------------------------------------------

interface ClaimTaskInput {
    task_id: string;
    agent_id?: string;
}

class ClaimTaskTool implements vscode.LanguageModelTool<ClaimTaskInput> {
    constructor(
        private readonly bb: YamsBlackboard,
        private readonly defaultAgentId: string,
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ClaimTaskInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<ClaimTaskInput>;
        const task_id = input.task_id;
        const agent_id = input.agent_id || this.defaultAgentId;
        if (!task_id || !agent_id) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { task_id: string, agent_id?: string }",
                ),
            ]);
        }
        const task = await this.bb.claimTask(task_id, agent_id);
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Failed to claim task ${task_id}. It may not exist or is already claimed.`,
                ),
            ]);
        }
        const text = `Task claimed: ${task.id}\nTitle: ${task.title}\nAssigned to: ${task.assigned_to}\nStatus: ${task.status}`;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_update_task
// ---------------------------------------------------------------------------

interface UpdateTaskInput {
    task_id: string;
    status?: string;
    error?: string;
    findings?: string[];
    artifacts?: {
        name: string;
        type: "file" | "data" | "report";
        path?: string;
        hash?: string;
        mime_type?: string;
    }[];
}

class UpdateTaskTool implements vscode.LanguageModelTool<UpdateTaskInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<UpdateTaskInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<UpdateTaskInput>;
        const { task_id, status, error, findings, artifacts } = input;
        if (!task_id) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { task_id: string, status?: string, error?: string, findings?: string[], artifacts?: Artifact[] }",
                ),
            ]);
        }
        const updates: Partial<{
            status: TaskStatus;
            error: string;
            findings: string[];
            artifacts: UpdateTaskInput["artifacts"];
        }> = {};
        if (status) updates.status = status as TaskStatus;
        if (typeof error === "string") updates.error = error;
        if (findings) updates.findings = findings;
        if (artifacts) updates.artifacts = artifacts;

        const task = await this.bb.updateTask(task_id, updates);
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Task not found: ${task_id}`),
            ]);
        }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Task ${task.id} updated to status: ${task.status}`,
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_complete_task
// ---------------------------------------------------------------------------

interface CompleteTaskInput {
    task_id: string;
    findings?: string[];
    artifacts?: {
        name: string;
        type: "file" | "data" | "report";
        path?: string;
        hash?: string;
        mime_type?: string;
    }[];
}

class CompleteTaskTool implements vscode.LanguageModelTool<CompleteTaskInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CompleteTaskInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<CompleteTaskInput>;
        const { task_id, findings, artifacts } = input;
        if (!task_id) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { task_id: string, findings?: string[] }",
                ),
            ]);
        }
        const task = await this.bb.completeTask(task_id, {
            findings,
            artifacts,
        });
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Task not found: ${task_id}`),
            ]);
        }
        const text = `Task completed: ${task.id}\nTitle: ${task.title}\n${findings?.length ? `Findings: ${findings.join(", ")}` : ""}${artifacts?.length ? `\nArtifacts: ${artifacts.map((a) => a.name).join(", ")}` : ""}`;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_fail_task
// ---------------------------------------------------------------------------

interface FailTaskInput {
    task_id: string;
    error: string;
}

class FailTaskTool implements vscode.LanguageModelTool<FailTaskInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FailTaskInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = (options.input ?? {}) as Partial<FailTaskInput>;
        const { task_id, error } = input;
        if (!task_id || !error) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { task_id: string, error: string }",
                ),
            ]);
        }
        const task = await this.bb.failTask(task_id, error);
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Task not found: ${task_id}`),
            ]);
        }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Task failed: ${task.id}\nError: ${error}`,
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_query_tasks
// ---------------------------------------------------------------------------

interface QueryTasksInput {
    type?: string;
    status?: string;
    priority?: number;
    created_by?: string;
    assigned_to?: string;
    context_id?: string;
    instance_id?: string;
    limit?: number;
}

class QueryTasksTool implements vscode.LanguageModelTool<QueryTasksInput> {
    constructor(
        private readonly bb: YamsBlackboard,
        private readonly getCtx: GetCurrentContext,
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<QueryTasksInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const args = (options.input ?? {}) as Partial<QueryTasksInput>;
        const tasks = await this.bb.queryTasks({
            type: args.type as TaskType | undefined,
            status: args.status as TaskStatus | undefined,
            priority: args.priority as TaskPriority | undefined,
            created_by: args.created_by,
            assigned_to: args.assigned_to,
            context_id: args.context_id || this.getCtx(),
            instance_id: args.instance_id,
            limit: args.limit ?? 20,
            offset: 0,
        });

        if (tasks.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart("No tasks match the query."),
            ]);
        }

        const text = tasks
            .map(
                (t) =>
                    `[${t.id}] P${t.priority} ${t.type} | ${t.title}\n  Status: ${t.status} | Created: ${t.created_by}${t.assigned_to ? ` | Assigned: ${t.assigned_to}` : ""}`,
            )
            .join("\n\n");

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_search_tasks (not in package.json tools but in OpenCode plugin)
// ---------------------------------------------------------------------------

interface SearchTasksInput {
    query: string;
    type?: string;
    instance_id?: string;
    limit?: number;
}

class SearchTasksTool implements vscode.LanguageModelTool<SearchTasksInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchTasksInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const args = (options.input ?? {}) as Partial<SearchTasksInput>;
        if (!args.query) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    "Invalid input: expected { query: string, type?: string, limit?: number }",
                ),
            ]);
        }
        const tasks = await this.bb.searchTasks(args.query, {
            type: args.type,
            limit: args.limit ?? 10,
            instance_id: args.instance_id,
        });

        if (tasks.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart("No tasks match the search."),
            ]);
        }

        const text = tasks
            .map(
                (t) =>
                    `[${t.id}] P${t.priority} ${t.type.toUpperCase()} | ${t.title}\n  Status: ${t.status} | Created: ${t.created_by}${t.assigned_to ? ` | Assigned: ${t.assigned_to}` : ""}\n  ${t.description ? t.description.slice(0, 200) + (t.description.length > 200 ? "..." : "") : ""}`,
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

export function registerTaskTools(
    context: vscode.ExtensionContext,
    bb: YamsBlackboard,
    getCtx: GetCurrentContext,
    defaultAgentId: string,
): void {
    context.subscriptions.push(
        vscode.lm.registerTool(
            "bb_create_task",
            new CreateTaskTool(bb, getCtx, defaultAgentId),
        ),
        vscode.lm.registerTool("bb_get_ready_tasks", new GetReadyTasksTool(bb)),
        vscode.lm.registerTool(
            "bb_claim_task",
            new ClaimTaskTool(bb, defaultAgentId),
        ),
        vscode.lm.registerTool("bb_update_task", new UpdateTaskTool(bb)),
        vscode.lm.registerTool("bb_complete_task", new CompleteTaskTool(bb)),
        vscode.lm.registerTool("bb_fail_task", new FailTaskTool(bb)),
        vscode.lm.registerTool("bb_query_tasks", new QueryTasksTool(bb, getCtx)),
        vscode.lm.registerTool("bb_search_tasks", new SearchTasksTool(bb)),
    );
}
