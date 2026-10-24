// The daemon's scheduling loop: the single place in the whole system that
// actually spawns/kills `bun tasks/*.ts` child processes. The web API and
// MCP tools only ever enqueue/cancel via db/runs.ts - they never touch a
// child process directly - so there's exactly one thing that can preempt a
// bot's task script, matching the "one controller" rule documented in
// tasks/README.md.
//
// Also doubles as the change-watcher: it already runs every ~1s, so it's
// the natural place to notice "something changed since last tick" (for the
// WebSocket refresh ping) and to detect the fixed small set of
// notification-worthy events (needs_attention flipping true; run_done/
// run_error are fired right where they happen, below).

import { openSync, closeSync, writeSync } from 'fs';
import { join } from 'path';
import { listBotNames } from './botRegistry';
import {
    listQueued,
    getRunningRun,
    claimNextQueued,
    setPid,
    finishRun,
    cancelRunningRow,
    removeQueuedRun,
    getRun,
    type RunRow,
} from '../db/runs';
import { getStatus } from '../db/status';
import type { TaskStatus } from '../tasks/lib/status';
import { findTask } from './taskRegistry';
import { matchingSubscriptions, fireNotification, type NotificationEventType } from '../db/notifications';
import { broadcast, pingRefresh } from './liveUpdates';
import { reconcileClients } from './clientRegistry';

function repoRoot(): string {
    return join(import.meta.dir, '..');
}

// botName -> entryId -> live subprocess handle, so `cancel` can kill a
// process this daemon instance actually spawned.
const children = new Map<string, { runId: string; proc: ReturnType<typeof Bun.spawn> }>();

function runLogPath(botName: string): string {
    return join(repoRoot(), 'bots', botName, 'task-runs.log');
}

function fireEvent(eventType: NotificationEventType, payload: unknown, botId: string): void {
    for (const sub of matchingSubscriptions(eventType, botId)) {
        fireNotification(sub.id, eventType, payload, { botId });
    }
    broadcast({ type: 'event', eventType, botId, payload });
}

function spawnEntry(botName: string, run: RunRow): void {
    const task = findTask(run.task);
    const scriptPath = join(repoRoot(), task?.scriptPath ?? `tasks/${run.task}.ts`);
    const args: string[] = JSON.parse(run.args);
    const fd = openSync(runLogPath(botName), 'a');
    writeSync(fd, `\n--- [${new Date().toISOString()}] run ${run.id}: bun ${scriptPath} ${botName} ${args.join(' ')} ---\n`);

    const proc = Bun.spawn({
        cmd: ['bun', scriptPath, botName, ...args],
        cwd: repoRoot(),
        stdout: fd,
        stderr: fd,
        env: { ...process.env, MANAGER_RUN_ID: run.id },
    });

    setPid(run.id, proc.pid);
    children.set(run.id, { runId: run.id, proc });
    pingRefresh({ botId: botName });

    proc.exited
        .then(exitCode => finishEntry(botName, run.id, exitCode))
        .finally(() => {
            closeSync(fd);
            children.delete(run.id);
        });
}

function finishEntry(botName: string, runId: string, exitCode: number): void {
    // Already handled (e.g. cancelled, which clears the running row itself) - don't double-record.
    const row = getRun(runId);
    if (!row || row.status !== 'running') return;

    const status: RunRow['status'] = exitCode === 0 ? 'done' : 'error';
    finishRun(runId, status, exitCode);
    fireEvent(status === 'done' ? 'run_done' : 'run_error', { runId, task: row.task, exitCode }, botName);
    pingRefresh({ botId: botName });
}

/** One scheduling pass: for every bot that's idle with something queued, start the next run. */
function tick(): void {
    for (const botName of listBotNames()) {
        if (getRunningRun(botName)) continue;
        if (listQueued(botName).length === 0) continue;
        const next = claimNextQueued(botName);
        if (next) spawnEntry(botName, next);
    }
    watchNeedsAttention();
    if (!clientReconcileInFlight) {
        clientReconcileInFlight = true;
        reconcileClients()
            .catch(err => console.error('[worker] client reconcile failed:', err))
            .finally(() => {
                clientReconcileInFlight = false;
            });
    }
}

// reconcileClients() awaits a gateway HTTP request per "on" bot, which can
// outlast a single 1s tick - this guards against two passes overlapping and
// double-spawning instead of letting the next setInterval fire pile up.
let clientReconcileInFlight = false;

// In-memory "last seen" per bot, purely for edge-detection (fire once when
// it flips false -> true, not on every tick while it stays true).
const lastNeedsAttention = new Map<string, boolean>();

function watchNeedsAttention(): void {
    for (const botName of listBotNames()) {
        const status = getStatus<TaskStatus>(botName);
        const needsAttention = Boolean(status?.needsAttention);
        const was = lastNeedsAttention.get(botName) ?? false;
        if (needsAttention && !was) {
            fireEvent('needs_attention', { lastError: status?.lastError, lastAction: status?.lastAction }, botName);
            pingRefresh({ botId: botName });
        }
        lastNeedsAttention.set(botName, needsAttention);
    }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startWorker(intervalMs = 1000): void {
    if (intervalHandle) return;
    intervalHandle = setInterval(tick, intervalMs);
}

/** Call once at daemon startup. A `running` row left over from a previous
 * daemon process means this process has no `Bun.spawn` handle for that
 * child - but the row still has the PID that process was spawned with, and a
 * bare PID is enough to send it a signal even without a handle. Without this,
 * that child (still mid-script, still driving the bot and writing to the
 * shared DB) would be orphaned: invisible to the dashboard's queue panel and
 * unkillable from it, left running forever after every daemon restart. Send
 * it the same SIGTERM a normal cancel would, so it exits via the task
 * runner's existing signal-cleanup path (sdk/runner.ts) instead of leaking. */
export function reconcileOnStartup(): void {
    for (const botName of listBotNames()) {
        const running = getRunningRun(botName);
        if (!running) continue;
        if (running.pid) {
            try {
                process.kill(running.pid, 'SIGTERM');
            } catch {
                // Already dead - nothing to clean up.
            }
        }
        finishRun(running.id, 'error', -1, 'Interrupted by manager daemon restart');
    }
}

/** Cancels the running run (kills the process), or removes a still-queued
 * one if `id` names one of those instead. Omit `id` to cancel whatever is
 * currently running. */
export function cancelEntry(botName: string, id?: string): { ok: boolean; error?: string } {
    const running = getRunningRun(botName);

    if (id && running?.id !== id) {
        if (removeQueuedRun(id)) {
            pingRefresh({ botId: botName });
            return { ok: true };
        }
        return { ok: false, error: `No queued/running entry "${id}"` };
    }

    if (!running) return { ok: false, error: 'Nothing is running for this bot' };

    const child = children.get(running.id);
    if (!child) {
        return { ok: false, error: 'Running entry has no process in this daemon instance (likely survived a daemon restart) - cannot kill it from here' };
    }

    child.proc.kill();
    cancelRunningRow(running.id);
    children.delete(running.id);
    pingRefresh({ botId: botName });
    return { ok: true };
}
