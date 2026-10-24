import { getDb, now } from './client';
import { ensureBot } from './bots';

export interface RecordActionInput {
    botId: string;
    runId?: string | null;
    source: 'task' | 'execute_code';
    method: string;
    args?: unknown;
    result?: unknown;
    success?: boolean | null;
    error?: string | null;
    startedAt: number;
    durationMs: number;
}

export interface ActionRow {
    id: number;
    bot_id: string;
    run_id: string | null;
    source: string;
    method: string;
    args: string | null;
    result: string | null;
    success: number | null;
    error: string | null;
    started_at: number;
    duration_ms: number;
}

function safeJson(value: unknown): string | null {
    if (value === undefined) return null;
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify(String(value));
    }
}

export function recordAction(input: RecordActionInput): void {
    ensureBot(input.botId);
    getDb().run(
        `INSERT INTO actions (bot_id, run_id, source, method, args, result, success, error, started_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            input.botId,
            input.runId ?? null,
            input.source,
            input.method,
            safeJson(input.args),
            safeJson(input.result),
            input.success === undefined ? null : input.success ? 1 : 0,
            input.error ?? null,
            input.startedAt,
            input.durationMs,
        ]
    );
}

export function listActions(botId: string, opts: { limit?: number; runId?: string } = {}): ActionRow[] {
    const limit = opts.limit ?? 200;
    if (opts.runId) {
        return getDb()
            .query<ActionRow, [string, string, number]>('SELECT * FROM actions WHERE bot_id = ? AND run_id = ? ORDER BY id DESC LIMIT ?')
            .all(botId, opts.runId, limit);
    }
    return getDb().query<ActionRow, [string, number]>('SELECT * FROM actions WHERE bot_id = ? ORDER BY id DESC LIMIT ?').all(botId, limit);
}

export function maxActionId(): number {
    const row = getDb().query<{ m: number | null }, []>('SELECT MAX(id) as m FROM actions').get();
    return row?.m ?? 0;
}

export { now };
