// Poll-based agent notification queue: manager/worker.ts's tick detects a
// fixed small set of event types (needs_attention, run_done, run_error,
// note_added) and fires any matching subscription into
// pending_notifications. An agent (via the MCP tools in mcp/fleet-tools.ts)
// polls and acks - no daemon-side LLM invocation needed.

import { randomUUID } from 'crypto';
import { getDb, now } from './client';

export type NotificationEventType = 'needs_attention' | 'run_done' | 'run_error' | 'note_added';

export interface SubscriptionRow {
    id: string;
    label: string;
    event_type: NotificationEventType;
    bot_id: string | null;
    fleet_id: string | null;
    created_at: number;
}

export interface PendingNotificationRow {
    id: number;
    subscription_id: string;
    bot_id: string | null;
    fleet_id: string | null;
    event_type: NotificationEventType;
    payload: string; // JSON
    created_at: number;
    acked_at: number | null;
}

export function createSubscription(label: string, eventType: NotificationEventType, opts: { botId?: string; fleetId?: string } = {}): SubscriptionRow {
    const row: SubscriptionRow = {
        id: randomUUID(),
        label,
        event_type: eventType,
        bot_id: opts.botId ?? null,
        fleet_id: opts.fleetId ?? null,
        created_at: now(),
    };
    getDb().run('INSERT INTO subscriptions (id, label, event_type, bot_id, fleet_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        row.id,
        row.label,
        row.event_type,
        row.bot_id,
        row.fleet_id,
        row.created_at,
    ]);
    return row;
}

export function listSubscriptions(): SubscriptionRow[] {
    return getDb().query<SubscriptionRow, []>('SELECT * FROM subscriptions ORDER BY created_at').all();
}

/** Subscriptions that match a given event, scoped to a bot and/or fleet (or
 * global - bot_id/fleet_id both NULL means "every bot/fleet"). */
export function matchingSubscriptions(eventType: NotificationEventType, botId?: string, fleetId?: string): SubscriptionRow[] {
    return getDb()
        .query<SubscriptionRow, [string, string | null, string | null]>(
            `SELECT * FROM subscriptions WHERE event_type = ?
             AND (bot_id IS NULL OR bot_id = ?)
             AND (fleet_id IS NULL OR fleet_id = ?)`
        )
        .all(eventType, botId ?? null, fleetId ?? null);
}

export function fireNotification(subscriptionId: string, eventType: NotificationEventType, payload: unknown, opts: { botId?: string; fleetId?: string } = {}): void {
    getDb().run('INSERT INTO pending_notifications (subscription_id, bot_id, fleet_id, event_type, payload, created_at, acked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)', [
        subscriptionId,
        opts.botId ?? null,
        opts.fleetId ?? null,
        eventType,
        JSON.stringify(payload),
        now(),
    ]);
}

export function listPendingNotifications(limit = 100): PendingNotificationRow[] {
    return getDb()
        .query<PendingNotificationRow, [number]>('SELECT * FROM pending_notifications WHERE acked_at IS NULL ORDER BY id ASC LIMIT ?')
        .all(limit);
}

export function ackNotification(id: number): boolean {
    const result = getDb().run('UPDATE pending_notifications SET acked_at = ? WHERE id = ? AND acked_at IS NULL', [now(), id]);
    return result.changes > 0;
}

export function maxPendingNotificationId(): number {
    const row = getDb().query<{ m: number | null }, []>('SELECT MAX(id) as m FROM pending_notifications').get();
    return row?.m ?? 0;
}
