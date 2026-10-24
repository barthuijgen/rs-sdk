// Generalizes the `tracked()` proxy that used to live only in
// mcp/execute-code.ts: wraps bot/sdk in a Proxy that (a) tracks in-flight
// calls in `active`, for "what was running when we got cancelled"
// diagnostics - the original behavior - and (b) now also records every
// completed call (success or throw) to the actions table (db/actions.ts),
// so an agent debugging a misbehaving task or developing a new one can read
// back every action taken and its result, not just what a task's own
// logEvent() calls happened to mention.
//
// Used by both sdk/runner.ts (task scripts, source: 'task') and
// mcp/execute-code.ts (ad-hoc agent calls, source: 'execute_code').
//
// Fails open: a DB write failure disables logging for the rest of the
// process rather than ever breaking the wrapped call - this must never be
// able to take down a real script run.

import { recordAction } from '../db/actions';
import { redactCredentials } from './redact';

export interface ActionLogContext {
    botId: string;
    runId?: string | null;
    source: 'task' | 'execute_code';
}

let loggingDisabled = false;
const MAX_FIELD_LENGTH = 4000;

function safeSummarize(value: unknown): unknown {
    if (value === undefined) return undefined;
    let json: string;
    try {
        json = JSON.stringify(value) ?? 'undefined';
    } catch {
        return String(value);
    }
    const redacted = redactCredentials(json);
    if (redacted.length <= MAX_FIELD_LENGTH) {
        try {
            return JSON.parse(redacted);
        } catch {
            return redacted;
        }
    }
    return { truncated: true, length: redacted.length, preview: redacted.slice(0, MAX_FIELD_LENGTH) };
}

export function tracked<T extends object>(
    object: T,
    label: string,
    active: Map<symbol, string>,
    signal: AbortSignal,
    logCtx?: ActionLogContext
): T {
    return new Proxy(object, {
        get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
                // A throw here would let a catch-all loop in cancelled code spin and starve the server.
                if (signal.aborted) return new Promise(() => {});
                const token = Symbol();
                const method = `${label}.${String(prop)}`;
                active.set(token, method);
                const startedAt = Date.now();

                const record = (result: unknown, error: unknown) => {
                    active.delete(token);
                    if (!logCtx || loggingDisabled) return;
                    try {
                        recordAction({
                            botId: logCtx.botId,
                            runId: logCtx.runId ?? null,
                            source: logCtx.source,
                            method,
                            args: safeSummarize(args),
                            result: error === undefined ? safeSummarize(result) : undefined,
                            success: error === undefined,
                            error: error === undefined ? null : error instanceof Error ? error.message : String(error),
                            startedAt,
                            durationMs: Date.now() - startedAt,
                        });
                    } catch (err) {
                        loggingDisabled = true;
                        console.error(`[actionLogger] disabling action logging after a write failure: ${err instanceof Error ? err.message : err}`);
                    }
                };

                try {
                    const result = value.apply(target, args);
                    if (result && typeof result.then === 'function') {
                        return Promise.resolve(result).then(
                            r => {
                                record(r, undefined);
                                return r;
                            },
                            e => {
                                record(undefined, e);
                                throw e;
                            }
                        );
                    }
                    record(result, undefined);
                    return result;
                } catch (error) {
                    record(undefined, error);
                    throw error;
                }
            };
        },
    });
}
