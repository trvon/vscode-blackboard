/**
 * Subscription & notification tools: bb_subscribe, bb_unsubscribe,
 * bb_list_subscriptions, bb_check_notifications, bb_notification_count,
 * bb_mark_notification_read, bb_mark_all_read, bb_dismiss_notification
 */

import * as vscode from "vscode";
import type { YamsBlackboard } from "../blackboard/blackboard.js";
import type { FindingSeverity } from "../blackboard/types.js";

// ---------------------------------------------------------------------------
// bb_subscribe
// ---------------------------------------------------------------------------

interface SubscribeInput {
    agent_id: string;
    pattern_type: string;
    pattern_value: string;
    severity_filter?: string[];
    min_confidence?: number;
    exclude_self?: boolean;
    expires_in_hours?: number;
}

class SubscribeTool implements vscode.LanguageModelTool<SubscribeInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SubscribeInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const args = options.input;
        const expiresAt = args.expires_in_hours
            ? new Date(
                  Date.now() + args.expires_in_hours * 60 * 60 * 1000,
              ).toISOString()
            : undefined;

        const subscription = await this.bb.createSubscription({
            subscriber_id: args.agent_id,
            pattern_type: args.pattern_type as any,
            pattern_value: args.pattern_value,
            filters: {
                severity: args.severity_filter as FindingSeverity[] | undefined,
                min_confidence: args.min_confidence,
                exclude_self: args.exclude_self ?? true,
            },
            expires_at: expiresAt,
        });

        const text = `Subscription created: ${subscription.id}
Pattern: ${subscription.pattern_type}:${subscription.pattern_value}
${args.severity_filter?.length ? `Severity filter: ${args.severity_filter.join(", ")}` : ""}
${args.min_confidence ? `Min confidence: ${args.min_confidence}` : ""}
${expiresAt ? `Expires: ${expiresAt}` : "No expiration"}

Use bb_check_notifications to see matching events.`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_unsubscribe
// ---------------------------------------------------------------------------

interface UnsubscribeInput {
    agent_id: string;
    subscription_id: string;
}

class UnsubscribeTool implements vscode.LanguageModelTool<UnsubscribeInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<UnsubscribeInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { agent_id, subscription_id } = options.input;
        const success = await this.bb.cancelSubscription(agent_id, subscription_id);
        const text = success
            ? `Subscription ${subscription_id} cancelled.`
            : `Failed to cancel subscription ${subscription_id}. It may not exist or is already cancelled.`;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_list_subscriptions
// ---------------------------------------------------------------------------

interface ListSubscriptionsInput {
    agent_id: string;
}

class ListSubscriptionsTool
    implements vscode.LanguageModelTool<ListSubscriptionsInput>
{
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListSubscriptionsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const subscriptions = await this.bb.listSubscriptions(
            options.input.agent_id,
        );

        if (subscriptions.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart("No active subscriptions."),
            ]);
        }

        const text = subscriptions
            .map(
                (s) =>
                    `[${s.id}] ${s.pattern_type}:${s.pattern_value}\n  Created: ${s.created_at}${s.expires_at ? ` | Expires: ${s.expires_at}` : ""}\n  ${s.filters?.severity?.length ? `Severity: ${s.filters.severity.join(", ")}` : ""}`,
            )
            .join("\n\n");

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_check_notifications
// ---------------------------------------------------------------------------

interface CheckNotificationsInput {
    agent_id: string;
    limit?: number;
    mark_as_read?: boolean;
}

class CheckNotificationsTool
    implements vscode.LanguageModelTool<CheckNotificationsInput>
{
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CheckNotificationsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { agent_id, limit, mark_as_read } = options.input;
        const notifications = await this.bb.getUnreadNotifications(
            agent_id,
            limit ?? 10,
        );

        if (notifications.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart("No new notifications."),
            ]);
        }

        // Optionally mark as read
        if (mark_as_read) {
            for (const n of notifications) {
                await this.bb.markNotificationRead(agent_id, n.id);
            }
        }

        const items = notifications.map((n) => {
            const severityStr = n.summary.severity
                ? ` (${n.summary.severity})`
                : "";
            return `[${n.id}] ${n.event_type}: ${n.summary.title}${severityStr}\n  Source: ${n.source_type}/${n.source_id} by ${n.source_agent_id}\n  ${n.summary.topic ? `Topic: ${n.summary.topic} | ` : ""}Time: ${n.created_at}`;
        });

        const text = `## ${notifications.length} New Notification${notifications.length > 1 ? "s" : ""}

${items.join("\n\n")}${mark_as_read ? "\n\n(Marked as read)" : ""}`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_notification_count
// ---------------------------------------------------------------------------

interface NotificationCountInput {
    agent_id: string;
}

class NotificationCountTool
    implements vscode.LanguageModelTool<NotificationCountInput>
{
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<NotificationCountInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const counts = await this.bb.getNotificationCount(
            options.input.agent_id,
        );
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Unread: ${counts.unread} | Total: ${counts.total}`,
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_mark_notification_read
// ---------------------------------------------------------------------------

interface MarkNotificationReadInput {
    agent_id: string;
    notification_id: string;
}

class MarkNotificationReadTool
    implements vscode.LanguageModelTool<MarkNotificationReadInput>
{
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MarkNotificationReadInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { agent_id, notification_id } = options.input;
        const success = await this.bb.markNotificationRead(
            agent_id,
            notification_id,
        );
        const text = success
            ? `Notification ${notification_id} marked as read.`
            : `Failed to mark notification ${notification_id} as read.`;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_mark_all_read
// ---------------------------------------------------------------------------

interface MarkAllReadInput {
    agent_id: string;
}

class MarkAllReadTool implements vscode.LanguageModelTool<MarkAllReadInput> {
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MarkAllReadInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const count = await this.bb.markAllNotificationsRead(
            options.input.agent_id,
        );
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Marked ${count} notification${count !== 1 ? "s" : ""} as read.`,
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// bb_dismiss_notification
// ---------------------------------------------------------------------------

interface DismissNotificationInput {
    agent_id: string;
    notification_id: string;
}

class DismissNotificationTool
    implements vscode.LanguageModelTool<DismissNotificationInput>
{
    constructor(private readonly bb: YamsBlackboard) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DismissNotificationInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { agent_id, notification_id } = options.input;
        const success = await this.bb.dismissNotification(
            agent_id,
            notification_id,
        );
        const text = success
            ? `Notification ${notification_id} dismissed.`
            : `Failed to dismiss notification ${notification_id}.`;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerNotificationTools(
    context: vscode.ExtensionContext,
    bb: YamsBlackboard,
): void {
    context.subscriptions.push(
        vscode.lm.registerTool("bb_subscribe", new SubscribeTool(bb)),
        vscode.lm.registerTool("bb_unsubscribe", new UnsubscribeTool(bb)),
        vscode.lm.registerTool(
            "bb_list_subscriptions",
            new ListSubscriptionsTool(bb),
        ),
        vscode.lm.registerTool(
            "bb_check_notifications",
            new CheckNotificationsTool(bb),
        ),
        vscode.lm.registerTool(
            "bb_notification_count",
            new NotificationCountTool(bb),
        ),
        vscode.lm.registerTool(
            "bb_mark_notification_read",
            new MarkNotificationReadTool(bb),
        ),
        vscode.lm.registerTool("bb_mark_all_read", new MarkAllReadTool(bb)),
        vscode.lm.registerTool(
            "bb_dismiss_notification",
            new DismissNotificationTool(bb),
        ),
    );
}
