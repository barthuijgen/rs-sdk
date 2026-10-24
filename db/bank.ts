import { getDb, now } from './client';
import { ensureBot } from './bots';

export interface BankSnapshot {
    updatedAt: number;
    items: Record<string, number>;
}

export function getBankSnapshot(botId: string): BankSnapshot | null {
    const row = getDb().query<{ updated_at: number; items: string }, [string]>('SELECT updated_at, items FROM bank_snapshot WHERE bot_id = ?').get(botId);
    if (!row) return null;
    try {
        return { updatedAt: row.updated_at, items: JSON.parse(row.items) };
    } catch {
        return null;
    }
}

export function setBankSnapshot(botId: string, items: Record<string, number>): void {
    ensureBot(botId);
    const updated_at = now();
    getDb().run(
        `INSERT INTO bank_snapshot (bot_id, updated_at, items) VALUES (?, ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET updated_at = excluded.updated_at, items = excluded.items`,
        [botId, updated_at, JSON.stringify(items)]
    );
}
