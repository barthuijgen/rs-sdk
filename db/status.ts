import { getDb, now } from './client';
import { ensureBot } from './bots';

/** One JSON blob per bot - same shape as the old status.json, just stored
 * here instead. See tasks/lib/status.ts for the TaskStatus type this holds. */
export function getStatus<T>(botId: string): T | null {
    const row = getDb().query<{ data: string }, [string]>('SELECT data FROM status WHERE bot_id = ?').get(botId);
    if (!row) return null;
    try {
        return JSON.parse(row.data) as T;
    } catch {
        return null;
    }
}

export function setStatus(botId: string, status: unknown): void {
    ensureBot(botId);
    const data = JSON.stringify(status);
    const updated_at = now();
    getDb().run(
        `INSERT INTO status (bot_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        [botId, data, updated_at]
    );
}
