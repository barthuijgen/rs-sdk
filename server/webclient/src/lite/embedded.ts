// Embedded bot driver: the same LiteClient session, BotActionQueue, and tick
// loop as runner.ts's LiteGatewayRunner, but with NO gateway WebSocket at
// all - actions and state move via direct function calls within this same
// process instead of a network round-trip through the gateway relay. Exists
// so a task script can run against the real, fast game-engine connection
// without the gateway hop (see rs-sdk tasks/README.md "Embedded engine").
//
// This is runner.ts's LiteGatewayRunner with the WebSocket plumbing (open/
// send/handleMessage/reconnect) replaced by direct calls to `callbacks`.
// Keep the tick/queue logic in sync with runner.ts if that one changes.

import { startSession, type LiteSession, type SessionOptions } from './session.js';
import { type ActionResult } from '#/bot/ActionExecutor.js';
import { BotActionQueue, type QueuedBotAction } from '#/bot/ActionQueue.js';
import type { BotAction, BotWorldState } from '#/bot/types.js';
import type { LiteClient } from './LiteClient.js';

const TICK_MS = 20; // matches runner.ts / the browser draw loop

export interface EmbeddedCallbacks {
    onActionResult(actionId: string, result: ActionResult): void;
    onState(state: BotWorldState): void;
}

export class EmbeddedRunner {
    private client: LiteClient;
    private actionQueue = new BotActionQueue();
    private waitTicks = 0;
    private serverTick = 0;
    private tickTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private session: LiteSession,
        private callbacks: EmbeddedCallbacks,
    ) {
        this.client = session.client;
        this.client.setOnGameTickCallback(() => {
            this.serverTick++;
            this.publishState();
        });
        this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    }

    /** Enqueue an action - this is the local stand-in for a gateway "action" message. */
    dispatchAction(action: BotAction, actionId: string, actionTimeoutMs?: number): void {
        const queueTtlMs = actionTimeoutMs === undefined ? undefined : Math.max(0, actionTimeoutMs - 1_000);
        const queued = this.actionQueue.enqueue({ action, actionId }, queueTtlMs);
        if (!queued) {
            this.callbacks.onActionResult(actionId, {
                success: false,
                message: 'Action queue is full',
                phase: 'validation',
                reason: 'busy',
            });
        }
    }

    stop(): void {
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.session.stop();
    }

    private tick(): void {
        for (const expired of this.actionQueue.expirePending()) {
            if (expired.actionId) {
                this.callbacks.onActionResult(expired.actionId, {
                    success: false,
                    message: `Action expired in queue: ${expired.action.type}`,
                    phase: 'validation',
                    reason: 'queue_expired',
                });
            }
        }

        const activeExpired = this.actionQueue.expireActive();
        if (activeExpired) {
            if (this.actionQueue.isCurrentGeneration(activeExpired) && activeExpired.actionId) {
                this.callbacks.onActionResult(activeExpired.actionId, {
                    success: false,
                    message: `Action expired while active: ${activeExpired.action.type}`,
                    phase: 'completion',
                    reason: 'queue_expired',
                });
            }
            this.publishState();
        }

        if (this.waitTicks > 0) {
            this.waitTicks--;
            const active = this.actionQueue.active;
            if (this.waitTicks === 0 && active) {
                this.finishAction(active, { success: true, message: 'Wait complete', phase: 'completion' });
            }
            return;
        }

        if (this.actionQueue.active) return;

        const queued = this.actionQueue.startNext();
        if (!queued) return;

        const action = queued.action;
        const resultOrPromise = this.client.executeBotAction(action);

        if (resultOrPromise instanceof Promise) {
            resultOrPromise
                .then(result => this.finishAction(queued, result))
                .catch(e =>
                    this.finishAction(queued, {
                        success: false,
                        message: `Error: ${e}`,
                        phase: 'completion',
                        reason: 'execution_error',
                    })
                );
            return;
        }

        if (action.type === 'wait' && resultOrPromise.success) {
            this.waitTicks = (action as any).ticks || 1;
            return;
        }

        this.finishAction(queued, resultOrPromise);
    }

    private finishAction(entry: QueuedBotAction, result: ActionResult): void {
        if (this.actionQueue.active !== entry) return;
        const publishResult = this.actionQueue.isCurrentGeneration(entry);
        this.actionQueue.complete(entry);
        if (!publishResult) return;
        if (entry.actionId) this.callbacks.onActionResult(entry.actionId, result);
        this.publishState();
    }

    private publishState(): void {
        const state = this.client.collectBotState(this.serverTick);
        if (!state) return;
        this.callbacks.onState(state);
    }
}

export async function startEmbeddedBot(
    options: SessionOptions,
    callbacks: EmbeddedCallbacks,
): Promise<{ runner: EmbeddedRunner; session: LiteSession }> {
    const session = await startSession(options);
    const runner = new EmbeddedRunner(session, callbacks);
    return { runner, session };
}
