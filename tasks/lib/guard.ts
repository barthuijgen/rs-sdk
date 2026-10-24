// Protects task loops from spinning forever when something keeps throwing -
// a disconnected client, a crashed browser, any exception we didn't plan
// for. Learned the hard way: a bare try/catch that logs-and-continues can
// retry at effectively zero delay (the gateway rejects instantly while
// disconnected), flooding the log and burning CPU with no chance of
// self-recovery, since standalone scripts never auto-launch a browser.
//
// Every task's catch block should route through `recordFailure`, which
// backs off and escalates to `needsAttention` (telling the caller to stop)
// once failures pile up faster than real progress - instead of trusting
// each call site to remember to do that itself.

import { logEvent, writeStatus, type TaskStatus } from './status';

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_MS = 2000;

export interface FailureStreak {
    count: number;
}

export function newFailureStreak(): FailureStreak {
    return { count: 0 };
}

// How stale `sdk.getState()` can be before we stop trusting it. Pathfinding
// and interactions fail against stale state with ordinary-looking messages
// ("cant_reach", "no fresh world state") that are indistinguishable from a
// momentarily busy server - so a dead game client (browser closed, session
// kicked) just retries forever, identically, with no thrown exception to
// trip the failure-streak guard above. Learned this the hard way: a task sat
// reporting the exact same "Cannot walk to (...): no fresh world state" for
// 20+ minutes while `controllers: []` server-side showed the client was
// actually gone. Call `checkClientHealth` once per loop iteration.
const STALE_STATE_MS = 20_000;
const MAX_STALE_STREAK = 5;

export interface StaleStreak {
    count: number;
}

export function newStaleStreak(): StaleStreak {
    return { count: 0 };
}

export type ClientHealth = 'ok' | 'skip' | 'stop';

/**
 * 'ok' - state is fresh, proceed with this iteration normally.
 * 'skip' - state is stale but under the give-up threshold; already waited a
 *          few ticks, caller should `continue` without acting this time.
 * 'stop' - stale across too many checks; needsAttention is already set and
 *          written, caller should `return` and give up on this task.
 */
export async function checkClientHealth(
    botName: string,
    status: TaskStatus,
    taskLabel: string,
    sdk: { getStateAge(): number; waitForTicks(n?: number): Promise<unknown> },
    streak: StaleStreak,
): Promise<ClientHealth> {
    const age = sdk.getStateAge();
    if (age <= STALE_STATE_MS) {
        streak.count = 0;
        return 'ok';
    }

    streak.count++;
    status.lastAction = `world state stale (${Math.round(age / 1000)}s old, check ${streak.count}/${MAX_STALE_STREAK})`;
    writeStatus(botName, status);

    if (streak.count >= MAX_STALE_STREAK) {
        status.needsAttention = true;
        status.lastError = `Game client appears dead - world state has been stale (${Math.round(age / 1000)}s) across ${streak.count} checks. Needs a fresh browser launch (see tasks/README.md).`;
        writeStatus(botName, status);
        logEvent(botName, { task: taskLabel, level: 'error', msg: 'client_stale_giving_up', ageMs: age });
        return 'stop';
    }

    try {
        await sdk.waitForTicks(3);
    } catch (err) {
        // waitForTicks itself throwing ("no state updates received") is
        // stronger evidence of a dead connection than mere staleness - and
        // left unguarded, this exception propagates straight out of the
        // caller's loop (checkClientHealth sits outside the try/catch that
        // wraps the main action), undoing the whole point of this guard.
        // Learned live: a task sat "alive" per the process list but frozen
        // for 80+ seconds after exactly this went uncaught.
        status.lastError = `waitForTicks failed during health check: ${err}`;
        writeStatus(botName, status);
        logEvent(botName, { task: taskLabel, level: 'warn', msg: `waitForTicks failed: ${err}` });
    }
    return 'skip';
}

export function recordSuccess(streak: FailureStreak): void {
    streak.count = 0;
}

/** Call from a catch block. Returns false when the caller should stop the
 * task entirely (needsAttention is already set and written); true when it's
 * safe to loop around and try again (after a short backoff). */
export async function recordFailure(
    botName: string,
    status: TaskStatus,
    taskLabel: string,
    err: unknown,
    streak: FailureStreak,
): Promise<boolean> {
    streak.count++;
    status.lastAction = `${taskLabel} error (${streak.count}/${MAX_CONSECUTIVE_FAILURES}): ${err}`;
    logEvent(botName, { task: taskLabel, level: 'error', msg: String(err) });

    if (streak.count >= MAX_CONSECUTIVE_FAILURES) {
        status.needsAttention = true;
        status.lastError = `${streak.count} consecutive errors - last: ${err}`;
        writeStatus(botName, status);
        logEvent(botName, { task: taskLabel, level: 'error', msg: 'giving_up_after_repeated_errors' });
        return false;
    }

    writeStatus(botName, status);
    await new Promise(resolve => setTimeout(resolve, BACKOFF_MS));
    return true;
}
