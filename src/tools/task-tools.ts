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
    created_by: string;
    depends_on?: string[];
    context_id?: string;
}

class CreateTaskTool implements vscode.LanguageModelTool<CreateTaskInput> {
    constructor(
        private readonly bb: YamsBlackboard,
        private readonly getCtx: GetCurrentContext,
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CreateTaskInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const args = options.input;
        const task = await this.bb.createTask({
            title: args.title,
            description: args.description,
            type: args.type as TaskType,
            priority: (args.priority ?? 2) as TaskPriority,
            created_by: args.created_by,
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
        const limited = tasks.slice(0, options.input.limit || 10);

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
    agent_id: string;
}

class ClaimTaskTool implements vscode.LanguageModelTool<ClaimTaskInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ClaimTaskInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { task_id, agent_id } = options.input;
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
    status: string;
    error?: string;
}

class UpdateTaskTool implements vscode.LanguageModelTool<UpdateTaskInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<UpdateTaskInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { task_id, status, error } = options.input;
        const task = await this.bb.updateTask(task_id, {
            status: status as TaskStatus,
            error,
        });
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
}

class CompleteTaskTool implements vscode.LanguageModelTool<CompleteTaskInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CompleteTaskInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { task_id, findings } = options.input;
        const task = await this.bb.completeTask(task_id, { findings });
        if (!task) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Task not found: ${task_id}`),
            ]);
        }
        const text = `Task completed: ${task.id}\nTitle: ${task.title}\n${findings?.length ? `Findings: ${findings.join(", ")}` : ""}`;
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
        const { task_id, error } = options.input;
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
        const args = options.input;
        const tasks = await this.bb.queryTasks({
            type: args.type as TaskType | undefined,
            status: args.status as TaskStatus | undefined,
            priority: args.priority as TaskPriority | undefined,
            created_by: args.created_by,
            assigned_to: args.assigned_to,
            context_id: args.context_id || this.getCtx(),
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
    limit?: number;
}

class SearchTasksTool implements vscode.LanguageModelTool<SearchTasksInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchTasksInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const args = options.input;
        const tasks = await this.bb.searchTasks(args.query, {
            type: args.type,
            limit: args.limit ?? 10,
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
): void {
    context.subscriptions.push(
        vscode.lm.registerTool("bb_create_task", new CreateTaskTool(bb, getCtx)),
        vscode.lm.registerTool("bb_get_ready_tasks", new GetReadyTasksTool(bb)),
        vscode.lm.registerTool("bb_claim_task", new ClaimTaskTool(bb)),
        vscode.lm.registerTool("bb_update_task", new UpdateTaskTool(bb)),
        vscode.lm.registerTool("bb_complete_task", new CompleteTaskTool(bb)),
        vscode.lm.registerTool("bb_fail_task", new FailTaskTool(bb)),
        vscode.lm.registerTool("bb_query_tasks", new QueryTasksTool(bb, getCtx)),
        vscode.lm.registerTool("bb_search_tasks", new SearchTasksTool(bb)),
    );
}
