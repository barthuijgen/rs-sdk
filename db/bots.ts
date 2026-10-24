import { getDb, now } from './client';

export interface BotRow {
    id: string;
    username: string;
    server: string | null;
    goal: string | null;
    fleet_id: string | null;
    created_at: number;
    desired_running: number;
}

/** Idempotent - inserts the bot if missing, otherwise leaves it untouched
 * (so a defensive call from tasks/lib/status.ts never clobbers a goal/fleet
 * someone already set via the dashboard/MCP). */
export function ensureBot(id: string, info?: { username?: string; server?: string }): void {
    const db = getDb();
    const existing = db.query<{ id: string }, [string]>('SELECT id FROM bots WHERE id = ?').get(id);
    if (existing) return;
    db.run('INSERT INTO bots (id, username, server, goal, fleet_id, created_at) VALUES (?, ?, ?, NULL, NULL, ?)', [
        id,
        info?.username ?? id,
        info?.server ?? null,
        now(),
    ]);
}

export function getBot(id: string): BotRow | null {
    return getDb().query<BotRow, [string]>('SELECT * FROM bots WHERE id = ?').get(id) ?? null;
}

export function listBots(): BotRow[] {
    return getDb().query<BotRow, []>('SELECT * FROM bots ORDER BY id').all();
}

export function setGoal(id: string, goal: string | null): void {
    ensureBot(id);
    getDb().run('UPDATE bots SET goal = ? WHERE id = ?', [goal, id]);
}

export function setFleet(id: string, fleetId: string | null): void {
    ensureBot(id);
    getDb().run('UPDATE bots SET fleet_id = ? WHERE id = ?', [fleetId, id]);
}

/** Persists whether the manager should keep a game client connected for this
 * bot (manager/clientRegistry.ts reconciles this on its own tick, so setting
 * it here is enough - no need to spawn/kill from the caller). */
export function setDesiredRunning(id: string, desired: boolean): void {
    ensureBot(id);
    getDb().run('UPDATE bots SET desired_running = ? WHERE id = ?', [desired ? 1 : 0, id]);
}

export function listBotsByFleet(fleetId: string): BotRow[] {
    return getDb().query<BotRow, [string]>('SELECT * FROM bots WHERE fleet_id = ? ORDER BY id').all(fleetId);
}
