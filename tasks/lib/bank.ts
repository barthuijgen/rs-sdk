// Generic "keep the inventory usable" helper shared by every task script.
// A task declares what it needs to keep (food, a tool); everything else is
// swept to the bank the moment the inventory fills up.
//
// `bot.openBank()` only looks at the CURRENTLY LOADED nearby scene (via
// findNearbyNpc/findUsableBankBooth) - it does not pathfind across the map
// to a bank it merely knows about. Learned this the hard way: the quick
// reference's "opens nearest bank" reads as global pathfinding, but it
// fails with "No banker NPC or bank booth found nearby" from anywhere that
// isn't already next to one. Callers must `bot.walkTo` a known bank first -
// see learnings/banking.md's "Full Banking Loop Pattern", which this mirrors.
//
// Note (see learnings/banking.md): there is no bank in Lumbridge town in this
// server's ruleset. Draynor is the nearest bank to every Lumbridge-area
// training spot used by tasks/combat.ts, woodcut.ts and thieving.ts.
export const DEFAULT_BANK_SPOT = { x: 3092, z: 3243 }; // Draynor, ground floor

import type { BotActions } from '../../sdk/actions';
import type { BotSDK } from '../../sdk/index';
import { logEvent, writeStatus, type TaskStatus } from './status';
import { fastWalkTo } from './fastWalk';
import { writeBankCacheFromLive } from './bankCache';

export const INVENTORY_CAPACITY = 28;

export function isInventoryFull(sdk: BotSDK): boolean {
    return sdk.getInventory().length >= INVENTORY_CAPACITY;
}

export function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Deposit everything in the inventory not matching `keep`, one
 * `depositItem(pattern, -1)` call per distinct item name (a name-anchored
 * pattern with amount -1 sweeps every matching slot in one call - see
 * learnings/banking.md). Assumes the bank is already open. Shared by
 * `performBankTrip` and any other caller that needs to empty out junk
 * mid-trip, e.g. right before withdrawing a tool so the trip doesn't walk
 * back out still carrying whatever's no longer needed. */
export async function depositAllExcept(
    bot: BotActions,
    sdk: BotSDK,
    keep: RegExp[],
    onWarn: (msg: string) => void = () => {},
): Promise<void> {
    const toDeposit = sdk.getInventory().filter(item => !keep.some(p => p.test(item.name)));
    const distinctNames = [...new Set(toDeposit.map(item => item.name))];

    for (const name of distinctNames) {
        const pattern = new RegExp(`^${escapeRegExp(name)}$`, 'i');
        const result = await bot.depositItem(pattern, -1);
        if (!result.success && !result.partial && result.reason !== 'item_not_found') {
            onWarn(`Deposit failed for "${name}": ${result.message}`);
        }
    }
}

/** One bank trip: walk to a known bank, open it, deposit everything not
 * matching `keep`, optionally top up a food pattern if we're now carrying
 * none, close. Exported directly (not just via `ensureBankSpace`) so a plan
 * can run one proactively - e.g. depositing unused starter gear once at
 * startup instead of only reacting once the inventory is already full. */
export async function performBankTrip(
    bot: BotActions,
    sdk: BotSDK,
    botName: string,
    bankSpot: { x: number; z: number },
    keep: RegExp[],
    restockFood?: { pattern: RegExp; reserveSlots?: number },
    onWarn: (msg: string) => void = () => {},
    // Every leg/hop decision, not just a failure - lets a live jank report
    // ("it took a weird detour") be diagnosed afterward from run.log.jsonl
    // instead of needing someone watching the browser at the exact moment
    // it happens. Not routed through onWarn: that's 'warn'-level in callers,
    // and most of these messages are routine progress, not warnings.
    onProgress: (msg: string) => void = () => {},
): Promise<boolean> {
    // Everything below can throw, not just return {success:false} - a
    // disconnect mid-trip, a server timeout inside fastWalkTo/openBank/
    // depositItem, etc. Without this try/catch, that exception propagates
    // straight out of performBankTrip -> ensureBankSpace -> the caller's
    // loop (which calls this with no catch of its own), crashing the whole
    // task uncaught instead of being treated as "this bank trip failed,
    // retry per ensureBankSpace's own attempt budget." Learned live: a
    // sibling gap in checkClientHealth's unguarded waitForTicks left a task
    // "alive" per the process list but frozen for 80+ seconds.
    try {
        // fastWalkTo, not bot.walkTo directly: a long bank trip is exactly
        // the case where bot.walkTo's per-tile re-dispatching dominates
        // wall-clock time under server latency - see tasks/lib/fastWalk.ts.
        const walked = await fastWalkTo(bot, sdk, bankSpot.x, bankSpot.z, { onProgress });
        if (!walked.success) {
            onWarn(`Could not walk to bank at (${bankSpot.x}, ${bankSpot.z}): ${walked.message}`);
            return false;
        }

        const opened = await bot.openBank();
        if (!opened.success) {
            onWarn(`Bank open failed: ${opened.message}`);
            return false;
        }

        await depositAllExcept(bot, sdk, keep, onWarn);

        if (restockFood && !sdk.findInventoryItem(restockFood.pattern)) {
            const have = sdk.findBankItem(restockFood.pattern);
            if (have) {
                // Fill up to leave just `reserveSlots` free (default 3), not
                // a fixed count - the inventory's just been emptied of
                // everything not in `keep` above, so there's usually plenty
                // of room. A fixed small withdraw here meant a bank trip
                // every few fights even with 20+ free slots sitting idle.
                const space = 28 - sdk.getInventory().length - (restockFood.reserveSlots ?? 3);
                if (space > 0) {
                    await bot.withdrawItem(restockFood.pattern, space).catch(() => {});
                }
            }
        }

        // Snapshot after deposits/withdrawals, still inside the open bank,
        // so a later process (including this one after a restart) can read
        // an up-to-date count without paying for a trip just to check - see
        // tasks/lib/bankCache.ts.
        writeBankCacheFromLive(botName, sdk);

        await bot.closeBank();
        return true;
    } catch (err) {
        onWarn(`Bank trip threw: ${err}`);
        return false;
    }
}

export interface EnsureBankSpaceOptions {
    /** Items to never deposit (food patterns, a task's required tool). */
    keep: RegExp[];
    /** If, after depositing, none of this pattern remains in inventory, fill
     * up to `reserveSlots` free (default 3) from the bank before closing. */
    restockFood?: { pattern: RegExp; reserveSlots?: number };
    taskLabel: string;
    maxAttempts?: number;
    /** Defaults to Draynor - see DEFAULT_BANK_SPOT above. */
    bankSpot?: { x: number; z: number };
}

/**
 * Call this whenever the inventory might be full. No-ops instantly when
 * there's room. When full, makes up to `maxAttempts` bank trips (a stale
 * path or a momentarily unreachable booth is worth retrying a couple of
 * times) and only then gives up - setting `status.needsAttention` rather
 * than spinning forever once we'd be stuck. Returns false when the caller
 * should stop the current task.
 */
export async function ensureBankSpace(
    bot: BotActions,
    sdk: BotSDK,
    botName: string,
    status: TaskStatus,
    opts: EnsureBankSpaceOptions,
): Promise<boolean> {
    if (!isInventoryFull(sdk)) return true;

    status.lastAction = 'inventory full, heading to the bank';
    writeStatus(botName, status);

    const maxAttempts = opts.maxAttempts ?? 3;
    const bankSpot = opts.bankSpot ?? DEFAULT_BANK_SPOT;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const ok = await performBankTrip(bot, sdk, botName, bankSpot, opts.keep, opts.restockFood, msg => {
            status.lastError = msg;
            logEvent(botName, { task: opts.taskLabel, level: 'warn', msg });
        }, msg => logEvent(botName, { task: opts.taskLabel, event: 'walk_progress', msg }));
        if (ok) {
            status.bankTrips++;
            status.lastError = null;
            logEvent(botName, { task: opts.taskLabel, event: 'bank_trip', trip: status.bankTrips });
            writeStatus(botName, status);
            return true;
        }
        await sdk.waitForTicks(3);
    }

    status.needsAttention = true;
    status.lastError = `Could not reach/open a bank after ${maxAttempts} attempts`;
    writeStatus(botName, status);
    logEvent(botName, { task: opts.taskLabel, level: 'error', msg: 'bank_unreachable' });
    return false;
}
