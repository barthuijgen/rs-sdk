import { getDb, now } from './client';
import { ensureBot } from './bots';

export interface EventRow {
    ts: number;
    [key: string]: unknown;
}

/** Replaces run.log.jsonl's logEvent() - same free-form object shape, just
 * stored as a row instead of an appended line. */
export function appendEvent(botId: string, data: Record<string, unknown>, runId?: string | null): void {
    ensureBot(botId);
    const ts = typeof data.ts === 'number' ? data.ts : now();
    getDb().run('INSERT INTO events (bot_id, run_id, ts, data) VALUES (?, ?, ?, ?)', [botId, runId ?? null, ts, JSON.stringify({ ts, ...data })]);
}

function parseRow(r: { data: string }): EventRow {
    try {
        return JSON.parse(r.data) as EventRow;
    } catch {
        return { ts: 0, raw: r.data };
    }
}

/** The last `limit` events, oldest-first (a "tail", like the old run.log.jsonl readers expected). */
export function listEvents(botId: string, limit = 200): EventRow[] {
    const rows = getDb()
        .query<{ data: string }, [string, number]>(
            'SELECT data FROM (SELECT id, data FROM events WHERE bot_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'
        )
        .all(botId, limit);
    return rows.map(parseRow);
}

/** Every event for a bot, oldest-first - for tasks/analyze.ts's full-history timing report. */
export function listAllEvents(botId: string): EventRow[] {
    return getDb()
        .query<{ data: string }, [string]>('SELECT data FROM events WHERE bot_id = ? ORDER BY id ASC')
        .all(botId)
        .map(parseRow);
}

export function maxEventId(): number {
    const row = getDb().query<{ m: number | null }, []>('SELECT MAX(id) as m FROM events').get();
    return row?.m ?? 0;
}
