// A BotSDK that talks directly to an embedded LiteClient session instead of
// a remote gateway WebSocket. Every porcelain method on BotActions (mineRock,
// walkTo, attack, ...) is unchanged - they all route through BotSDK's public
// API, which this subclass overrides at exactly two points:
//
//   - sendAction(): the single choke point every send*() wrapper dispatches
//     through. Instead of a network round-trip, this enqueues directly into
//     the embedded runner's BotActionQueue and resolves when it calls back -
//     same tick-paced queue semantics as a real client, zero network latency.
//   - the state side: EmbeddedRunner's onState callback feeds each tick's
//     BotWorldState through the (now protected) handleMessage(), the exact
//     same parsing/normalization path a real gateway message takes, so
//     nothing about skill-name Proxy wrapping or item defaults is duplicated.
//
// sendAction/handleMessage were private -> protected in sdk/index.ts
// specifically to make this subclass possible; see that diff's comments.

import { BotSDK } from '../../../../sdk/index.js';
import type { SDKConfig, BotAction, ActionResult, BotWorldState, ConnectionState } from '../../../../sdk/types.js';
import { startEmbeddedBot, type EmbeddedRunner } from './embedded.js';
import type { SessionOptions } from './session.js';

interface PendingLocalAction {
    resolve: (r: ActionResult) => void;
}

export class LocalBotSDK extends BotSDK {
    private runner: EmbeddedRunner | null = null;
    private pending = new Map<string, PendingLocalAction>();
    private tickWaiters: Array<() => void> = [];
    private loginOptions: SessionOptions;

    constructor(config: SDKConfig, loginOptions: SessionOptions) {
        super({ ...config, autoLaunchBrowser: false, autoReconnect: false });
        this.loginOptions = loginOptions;
    }

    override async connect(): Promise<void> {
        if (this.runner) return;
        const { runner } = await startEmbeddedBot(this.loginOptions, {
            onActionResult: (actionId, result) => {
                const p = this.pending.get(actionId);
                if (p) {
                    this.pending.delete(actionId);
                    p.resolve(result);
                }
            },
            onState: state => {
                // Round-trips through JSON on purpose: this is the exact
                // same shape/path a real gateway message takes, so the base
                // class's parsing (skill Proxy, item amount defaults) and
                // this file's two types (sdk/types.ts vs #/bot/types.ts)
                // never need to structurally match at the TS level - only
                // at the JSON boundary, same as the real gateway protocol.
                this.handleMessage(JSON.stringify({
                    type: 'sdk_state',
                    state,
                    stateReceivedAt: Date.now(),
                }));
                const waiters = this.tickWaiters;
                this.tickWaiters = [];
                for (const w of waiters) w();
            },
        });
        this.runner = runner;
    }

    override async disconnect(): Promise<void> {
        this.runner?.stop();
        this.runner = null;
    }

    override isConnected(): boolean {
        return this.runner !== null;
    }

    override getConnectionState(): ConnectionState {
        return this.runner ? 'connected' : 'disconnected';
    }

    protected override async sendAction(action: BotAction): Promise<ActionResult> {
        if (!this.runner) throw new Error('LocalBotSDK: not connected (call connect() first)');
        const actionId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return new Promise<ActionResult>(resolve => {
            this.pending.set(actionId, { resolve });
            this.runner!.dispatchAction(action, actionId, 60_000);
        });
    }

    // A real server tick is ~300-600ms; if one genuinely never arrives (the
    // underlying game connection stalled - a demo-server-side hang, not
    // just the gateway this time), nothing resolves this without a timeout
    // of its own. Learned live: without one, a stalled tick hung this call
    // forever, and since checkClientHealth's own stale-connection recovery
    // calls waitForTicks internally, the recovery logic got stuck too - a
    // task sat frozen for 17+ minutes looking like it was "about to recover"
    // the whole time. A tick timeout turns that into a thrown exception
    // checkClientHealth/recordFailure can actually act on.
    private static readonly TICK_TIMEOUT_MS = 20_000;

    override async waitForTicks(n: number = 1): Promise<BotWorldState> {
        for (let i = 0; i < Math.max(1, n); i++) {
            await new Promise<void>((resolve, reject) => {
                const onTick = () => {
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(() => {
                    this.tickWaiters = this.tickWaiters.filter(w => w !== onTick);
                    reject(new Error(`LocalBotSDK: no tick arrived within ${LocalBotSDK.TICK_TIMEOUT_MS}ms - game connection may have stalled`));
                }, LocalBotSDK.TICK_TIMEOUT_MS);
                this.tickWaiters.push(onTick);
            });
        }
        const s = this.getState();
        if (!s) throw new Error('LocalBotSDK: no state after waitForTicks');
        return s;
    }

    override async waitForCondition(
        predicate: (state: BotWorldState) => boolean,
        timeout: number = 30_000,
    ): Promise<BotWorldState> {
        const deadline = Date.now() + timeout;
        // First check against whatever state already exists - a real
        // network client might also pass a state captured before a late
        // subscription, but locally the very first tick is usually already
        // in by the time a caller gets here.
        const current = this.getState();
        if (current && predicate(current)) return current;
        while (Date.now() < deadline) {
            await this.waitForTicks(1);
            const s = this.getState();
            if (s && predicate(s)) return s;
        }
        throw new Error('waitForCondition timed out');
    }
}
