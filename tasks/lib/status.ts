// Shared status contract between task scripts (the executor tier) and cheap
// checkup reads (the supervisor tier). A task script writes status after
// every notable step so a checkup never needs to connect to the gateway or
// re-read game state. Notable events also get a row in the events table for
// a detailed trail.
//
// Backed by the shared SQLite DB (see db/) instead of status.json/
// run.log.jsonl - this file's exported names/signatures/types are
// unchanged, so no task script needed to change for the move. bun:sqlite is
// fully synchronous, so no async signature changes were needed either.
//
// See tasks/README.md for the architecture this implements.

import { getStatus, setStatus } from '../../db/status';
import { appendEvent, listEvents, listAllEvents } from '../../db/events';
import { ensureBot } from '../../db/bots';

export interface SkillSnapshot {
    level: number;
    xp: number;
}

export interface TaskHistoryEntry {
    task: string;
    result: 'complete' | 'error';
    durationMs: number;
    finishedAt: number;
}

export interface TaskStatus {
    bot: string;
    plan: string[];
    planIndex: number;
    currentTask: string | null;
    startedAt: number;
    taskStartedAt: number;
    updatedAt: number;
    iteration: number;
    actionsCompleted: number;
    bankTrips: number;
    skills: Record<string, SkillSnapshot>;
    lastAction: string;
    lastError: string | null;
    /** Set when a task stopped itself because it hit something only a human
     * or the planner should resolve (no food + critical HP, bank unreachable,
     * repeated errors). A checkup should always surface this. */
    needsAttention: boolean;
    done: boolean;
    history: TaskHistoryEntry[];
}

export function newStatus(botName: string, plan: string[]): TaskStatus {
    const now = Date.now();
    return {
        bot: botName,
        plan,
        planIndex: 0,
        currentTask: null,
        startedAt: now,
        taskStartedAt: now,
        updatedAt: now,
        iteration: 0,
        actionsCompleted: 0,
        bankTrips: 0,
        skills: {},
        lastAction: 'starting',
        lastError: null,
        needsAttention: false,
        done: false,
        history: [],
    };
}

export function writeStatus(botName: string, status: TaskStatus): void {
    ensureBot(botName);
    status.updatedAt = Date.now();
    setStatus(botName, status);
}

export function readStatus(botName: string): TaskStatus | null {
    return getStatus<TaskStatus>(botName);
}

export function logEvent(botName: string, event: Record<string, unknown>): void {
    ensureBot(botName);
    appendEvent(botName, event);
}

/** Last `limit` events, oldest-first - what tasks/checkup.ts and the
 * manager's log feed want (a tail, not the whole history). */
export function readEventsTail(botName: string, limit = 200): Record<string, unknown>[] {
    return listEvents(botName, limit);
}

/** Every event ever logged for this bot, oldest-first - tasks/analyze.ts's
 * full-history timing report needs the whole thing, not just a tail. */
export function readEvents(botName: string): Record<string, unknown>[] {
    return listAllEvents(botName);
}
