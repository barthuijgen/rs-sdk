// Replaces manager/queue.ts entirely. A "run" is one `bun tasks/X.ts`
// invocation - queued, then running (at most one per bot at a time, enforced
// by manager/worker.ts only ever calling claimNextQueued when a bot has no
// running row), then done/error/cancelled.

import { randomUUID } from 'crypto';
import { getDb, now } from './client';
import { ensureBot } from './bots';

export type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface RunRow {
    id: string;
    bot_id: string;
    task: string;
    args: string; // JSON-encoded string[]
    status: RunStatus;
    triggered_by: string | null;
    enqueued_at: number;
    started_at: number | null;
    finished_at: number | null;
    pid: number | null;
    exit_code: number | null;
    error: string | null;
}

export interface BotRuns {
    running: RunRow | null;
    queued: RunRow[];
    history: RunRow[];
}

export function enqueueRun(botId: string, task: string, args: string[], triggeredBy?: string): RunRow {
    ensureBot(botId);
    const row: RunRow = {
        id: randomUUID(),
        bot_id: botId,
        task,
        args: JSON.stringify(args),
        status: 'queued',
        triggered_by: triggeredBy ?? null,
        enqueued_at: now(),
        started_at: null,
        finished_at: null,
        pid: null,
        exit_code: null,
        error: null,
    };
    getDb().run(
        `INSERT INTO runs (id, bot_id, task, args, status, triggered_by, enqueued_at, started_at, finished_at, pid, exit_code, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
        [row.id, row.bot_id, row.task, row.args, row.status, row.triggered_by, row.enqueued_at]
    );
    return row;
}

export function getRun(id: string): RunRow | null {
    return getDb().query<RunRow, [string]>('SELECT * FROM runs WHERE id = ?').get(id) ?? null;
}

export function getRunningRun(botId: string): RunRow | null {
    return getDb().query<RunRow, [string]>("SELECT * FROM runs WHERE bot_id = ? AND status = 'running'").get(botId) ?? null;
}

export function listQueued(botId: string): RunRow[] {
    return getDb().query<RunRow, [string]>("SELECT * FROM runs WHERE bot_id = ? AND status = 'queued' ORDER BY enqueued_at ASC").all(botId);
}

export function listHistory(botId: string, limit = 50): RunRow[] {
    return getDb()
        .query<RunRow, [string, number]>(
            "SELECT * FROM runs WHERE bot_id = ? AND status IN ('done','error','cancelled') ORDER BY finished_at DESC LIMIT ?"
        )
        .all(botId, limit);
}

export function listRunsForBot(botId: string): BotRuns {
    return { running: getRunningRun(botId), queued: listQueued(botId), history: listHistory(botId) };
}

/** Pops the oldest queued run for a bot and marks it running. Caller (manager/worker.ts)
 * is responsible for actually spawning the process and calling setPid. Returns null if
 * the bot already has a running entry or nothing is queued - callers should check
 * getRunningRun() first, this is not itself atomic against two daemons sharing one DB. */
export function claimNextQueued(botId: string): RunRow | null {
    if (getRunningRun(botId)) return null;
    const next = getDb()
        .query<RunRow, [string]>("SELECT * FROM runs WHERE bot_id = ? AND status = 'queued' ORDER BY enqueued_at ASC LIMIT 1")
        .get(botId);
    if (!next) return null;
    const started_at = now();
    getDb().run("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?", [started_at, next.id]);
    return { ...next, status: 'running', started_at };
}

export function setPid(id: string, pid: number): void {
    getDb().run('UPDATE runs SET pid = ? WHERE id = ?', [pid, id]);
}

export function finishRun(id: string, status: 'done' | 'error', exitCode: number, error?: string): void {
    getDb().run('UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, error = ? WHERE id = ?', [status, now(), exitCode, error ?? null, id]);
}

/** Cancels a running entry. No-op (returns false) if it isn't actually running. */
export function cancelRunningRow(id: string): boolean {
    const row = getRun(id);
    if (!row || row.status !== 'running') return false;
    getDb().run("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?", [now(), id]);
    return true;
}

/** Deletes a still-queued entry outright (no history trace, matching the old
 * queue.json behavior for "remove before it ever ran"). Returns false if it
 * isn't actually queued (e.g. already running/finished). */
export function removeQueuedRun(id: string): boolean {
    const row = getRun(id);
    if (!row || row.status !== 'queued') return false;
    getDb().run('DELETE FROM runs WHERE id = ?', [id]);
    return true;
}

export interface ApiRun extends Omit<RunRow, 'args'> {
    args: string[];
}

/** API/UI-facing shape: `args` parsed back into an array, since the string
 * encoding is a storage detail JSON clients shouldn't need to know about. */
export function toApiRun(row: RunRow): ApiRun {
    return { ...row, args: JSON.parse(row.args) };
}

export interface ApiBotRuns {
    running: ApiRun | null;
    queued: ApiRun[];
    history: ApiRun[];
}

export function toApiRuns(runs: BotRuns): ApiBotRuns {
    return { running: runs.running ? toApiRun(runs.running) : null, queued: runs.queued.map(toApiRun), history: runs.history.map(toApiRun) };
}

export function maxRunRowId(): string {
    // Runs don't have a numeric autoincrement id to watermark on; use the
    // latest enqueued_at/finished_at/started_at instead for the change-watcher.
    const row = getDb()
        .query<{ m: number | null }, []>('SELECT MAX(COALESCE(finished_at, started_at, enqueued_at)) as m FROM runs')
        .get();
    return String(row?.m ?? 0);
}
