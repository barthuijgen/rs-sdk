// Generic "don't run out of food silently" guard for any task whose actions
// can cost HP (failed pickpockets, missed attacks, ...). Escalation order:
// eat what's already in inventory -> walk to a bank and withdraw more -> if
// the bank has none either, just wait for natural regen instead of treating
// that as an error - HP comes back on its own over time, no action needed.

import type { BotActions } from '../../sdk/actions';
import type { BotSDK } from '../../sdk/index';
import { fastWalkTo } from './fastWalk';
import { writeStatus, logEvent, type TaskStatus } from './status';

export interface EnsureHealthyOptions {
    foodPattern: RegExp;
    bankSpot: { x: number; z: number };
    taskLabel: string;
    /** Eat/restock once hp drops to or below this fraction of maxHp (floor 4 hp). Default 0.3. */
    lowFraction?: number;
    /** Withdraw as much food as fits, leaving this many free slots for
     * whatever the task's own loot needs (coins stack into one slot
     * regardless of amount, so most tasks need very little room) - default
     * 3. A fixed small withdraw count instead would mean a bank trip every
     * few fights/pickpockets even with a mostly-empty inventory - confirmed
     * live: thieving (loot is a single coin stack) was re-visiting the bank
     * for 5 more food at a time when it had 20+ free slots sitting idle. */
    reserveSlots?: number;
    /** How long to wait between HP checks while paused for natural regen. Default 10 ticks (~3-6s). */
    regenPollTicks?: number;
}

/** One bank trip for food only - walk there, withdraw, walk back is left to
 * the caller's own next action. Exception-safe: a thrown error (disconnect,
 * server hiccup) is treated the same as "couldn't get food this time", not
 * a crash - see tasks/lib/bank.ts's performBankTrip for the same lesson. */
async function withdrawFoodFromBank(
    bot: BotActions,
    sdk: BotSDK,
    bankSpot: { x: number; z: number },
    foodPattern: RegExp,
    reserveSlots: number,
    onWarn: (msg: string) => void,
    onProgress: (msg: string) => void,
): Promise<'withdrawn' | 'bank_empty' | 'failed'> {
    try {
        // onProgress (plain informational event, not onWarn's 'warn' level -
        // every leg/hop decision, not just a failure, would otherwise flood
        // run.log.jsonl with mislabeled "warnings") so a live jank report
        // ("it took a weird detour") can be diagnosed afterward from the log
        // instead of needing someone watching the browser at the exact
        // moment it happens.
        const walked = await fastWalkTo(bot, sdk, bankSpot.x, bankSpot.z, { onProgress });
        if (!walked.success) {
            onWarn(`Could not walk to bank for food: ${walked.message}`);
            return 'failed';
        }

        const opened = await bot.openBank();
        if (!opened.success) {
            onWarn(`Bank open failed (food restock): ${opened.message}`);
            return 'failed';
        }

        const have = sdk.findBankItem(foodPattern);
        if (!have) {
            await bot.closeBank();
            return 'bank_empty';
        }

        // Fill up to leave just `reserveSlots` free, not a fixed count -
        // withdrawItem partial-fills gracefully if the bank has less.
        const count = Math.max(1, 28 - sdk.getInventory().length - reserveSlots);
        const withdrawn = await bot.withdrawItem(foodPattern, count);
        await bot.closeBank();
        if (withdrawn.success || (withdrawn.amountWithdrawn ?? 0) > 0) return 'withdrawn';
        onWarn(`Withdraw failed: ${withdrawn.message}`);
        return 'failed';
    } catch (err) {
        onWarn(`Food bank trip threw: ${err}`);
        return 'failed';
    }
}

/**
 * Call at the top of a task loop, right after the client-health/dialog
 * checks and before the task's normal action.
 *
 * Returns 'proceed' when it's safe for the caller to continue with its
 * normal action this iteration; 'handled' means it already acted (ate,
 * banked) and the caller should just `continue` to the next loop iteration;
 * 'stop' means food is confirmed gone from both inventory and bank while HP
 * is critical - continuing to take damage (failed pickpockets, missed
 * attacks) with no way to heal risks death, so the caller must stop the
 * task rather than pause-and-retry near whatever is costing HP. The caller
 * is expected to `return` on 'stop' and let a human restock food.
 */
export async function ensureHealthy(
    bot: BotActions,
    sdk: BotSDK,
    botName: string,
    status: TaskStatus,
    opts: EnsureHealthyOptions,
): Promise<'proceed' | 'handled' | 'stop'> {
    const state = sdk.getState();
    const hp = state?.player?.hp ?? 10;
    const maxHp = state?.player?.maxHp ?? 10;
    const lowThreshold = Math.max(4, Math.floor(maxHp * (opts.lowFraction ?? 0.3)));

    if (hp > lowThreshold) return 'proceed';

    // 1. Eat from inventory if we have any.
    const food = sdk.findInventoryItem(opts.foodPattern);
    if (food) {
        await bot.eatFood(food);
        status.lastAction = `ate ${food.name} (hp was ${hp}/${maxHp})`;
        writeStatus(botName, status);
        return 'handled';
    }

    // 2. No food carried - try restocking from the bank.
    status.lastAction = `low hp (${hp}/${maxHp}), no food carried - walking to the bank`;
    writeStatus(botName, status);
    const result = await withdrawFoodFromBank(
        bot, sdk, opts.bankSpot, opts.foodPattern, opts.reserveSlots ?? 3,
        msg => logEvent(botName, { task: opts.taskLabel, level: 'warn', msg }),
        msg => logEvent(botName, { task: opts.taskLabel, event: 'walk_progress', msg }),
    );

    if (result === 'withdrawn') {
        status.lastAction = `restocked food from the bank (hp was ${hp}/${maxHp})`;
        writeStatus(botName, status);
        logEvent(botName, { task: opts.taskLabel, event: 'food_restocked' });
        return 'handled';
    }

    // 3. Bank genuinely has none either - no way left to heal. Pausing and
    // hoping natural regen outruns whatever is costing HP is how a thieving
    // bot died with zero food in inventory or bank: a failed pickpocket on a
    // Warrior-tier+ NPC can land again before regen catches up, and nothing
    // was watching for that. Stop instead and flag for a human to restock.
    if (result === 'bank_empty') {
        status.needsAttention = true;
        status.lastError = `Critical hp (${hp}/${maxHp}) with no food in inventory or bank`;
        writeStatus(botName, status);
        logEvent(botName, { task: opts.taskLabel, level: 'error', msg: 'critical_hp_no_food_anywhere' });
        return 'stop';
    }

    // The bank trip itself failed (unreachable, walk blocked) - distinct
    // from confirmed-empty: food may well be there, just not reached yet.
    // Worth a bounded retry rather than giving up immediately.
    status.lastAction = `couldn't reach the bank for food (hp ${hp}/${maxHp}) - pausing and will retry`;
    writeStatus(botName, status);
    await sdk.waitForTicks(opts.regenPollTicks ?? 10);
    return 'handled';
}
