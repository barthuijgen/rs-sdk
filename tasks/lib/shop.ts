// Generic "make sure a required item is carried" escalation for tools and
// consumables a skill needs but doesn't produce itself (a net, a rod,
// bait, feathers). Mirrors tasks/lib/bank.ts's role for the opposite
// direction - that module empties the inventory of what a task no longer
// needs, this one tops it up with what a task can't act without.
//
// Buying needs coins, which a fresh/looted-out character may not be
// carrying - this withdraws from the bank first when short, rather than
// walking all the way to the shop only to find out it can't afford
// anything there (confirmed live: a bot arrived at Gerrant's Fishy Business
// with 0 gp and failed to buy a 5gp fly fishing rod).
//
// Also checks the bank for the gear itself before buying a replacement -
// confirmed live: a fly fishing rod + 76 feathers ended up banked by an
// earlier run (its bank `keep` list only protected its own site's gear, not
// every site's), and without this check the next run would have walked to
// the shop and bought a second rod from scratch instead of just withdrawing
// the one already sitting there for free.

import type { BotActions } from '../../sdk/actions';
import type { BotSDK } from '../../sdk/index';
import { fastWalkTo } from './fastWalk';
import { logEvent, writeStatus, type TaskStatus } from './status';

const COINS_PATTERN = /^coins$/i;

export interface GearRequirement {
    pattern: RegExp;
    /** Buy more once carried count drops below this. 1 for a tool (never
     * consumed), higher for bait/feathers so a trip buys a real buffer. */
    minCount: number;
    /** How many to buy per shop trip. Defaults to `minCount`. */
    buyCount?: number;
    shopSpot: { x: number; z: number };
    /** Only ever try the bank for this one, never the shop - for a resource
     * that's fine to use up from an existing stock (bought once, or just
     * sitting banked already) but shouldn't trigger buying more forever
     * once it runs dry. Running out doesn't fail `ensureGear` either - the
     * caller is expected to fall back to something that doesn't need it. */
    bankOnly?: boolean;
}

export interface EnsureGearOptions {
    /** Bank to withdraw coins from when short before heading to the shop.
     * Skipped entirely if omitted - caller must then already be carrying
     * enough gp. */
    coinBankSpot?: { x: number; z: number };
    /** Keep at least this many coins on hand before shopping. Default 200 -
     * comfortably covers every tool/bait purchase these scripts make (a few
     * gp each, up to a couple hundred for a bulk bait/feather buy). */
    minCoins?: number;
}

/**
 * Call at the top of a task loop, before acting. No-ops instantly once every
 * requirement is already met. Returns false when a shop trip failed (no
 * path, shop wouldn't open, out of stock, genuinely out of coins even after
 * the bank) - the caller should treat that like any other blocked-on-setup
 * failure (log, back off, retry next iteration), not crash.
 */
export async function ensureGear(
    bot: BotActions,
    sdk: BotSDK,
    botName: string,
    status: TaskStatus,
    taskLabel: string,
    requirements: GearRequirement[],
    opts: EnsureGearOptions = {},
): Promise<boolean> {
    const amountHeld = (pattern: RegExp) =>
        sdk.getInventory().filter(i => pattern.test(i.name)).reduce((sum, i) => sum + i.count, 0);
    let short = requirements.filter(req => amountHeld(req.pattern) < req.minCount);
    if (short.length === 0) return true;

    if (opts.coinBankSpot) {
        status.lastAction = 'short on gear - checking the bank before buying';
        writeStatus(botName, status);
        try {
            const walked = await fastWalkTo(bot, sdk, opts.coinBankSpot.x, opts.coinBankSpot.z);
            if (!walked.success) {
                logEvent(botName, { task: taskLabel, level: 'warn', msg: `Could not walk to bank: ${walked.message}` });
                return false;
            }
            const opened = await bot.openBank();
            if (!opened.success) {
                logEvent(botName, { task: taskLabel, level: 'warn', msg: `Bank open failed: ${opened.message}` });
                return false;
            }

            // Withdraw whatever's already banked before paying for anything.
            for (const req of short) {
                const have = amountHeld(req.pattern);
                if (have >= req.minCount) continue;
                const banked = sdk.findBankItem(req.pattern);
                if (!banked) continue;
                const need = (req.buyCount ?? req.minCount) - have;
                const withdrawn = await bot.withdrawItem(req.pattern, Math.min(need, banked.count)).catch(() => null);
                if (withdrawn?.amountWithdrawn) {
                    logEvent(botName, { task: taskLabel, event: 'gear_withdrawn_from_bank', amount: withdrawn.amountWithdrawn });
                }
            }

            const coins = sdk.findInventoryItem(COINS_PATTERN)?.count ?? 0;
            const minCoins = opts.minCoins ?? 200;
            if (coins < minCoins && sdk.findBankItem(COINS_PATTERN)) {
                await bot.withdrawItem(COINS_PATTERN, minCoins - coins).catch(() => {});
                logEvent(botName, { task: taskLabel, event: 'coins_withdrawn', hadBefore: coins });
            }
            await bot.closeBank();
        } catch (err) {
            logEvent(botName, { task: taskLabel, level: 'warn', msg: `Gear/coin bank trip threw: ${err}` });
            return false;
        }
    }

    // Re-check: the bank visit above may have fully covered some (or all)
    // of what looked short before it.
    short = requirements.filter(req => amountHeld(req.pattern) < req.minCount);

    for (const req of short) {
        const have = amountHeld(req.pattern);
        if (have >= req.minCount) continue; // topped up by an earlier req's purchase at the same shop
        if (req.bankOnly) {
            logEvent(botName, { task: taskLabel, event: 'gear_not_restocked', msg: 'bank-only requirement still short, not buying more', have, need: req.minCount });
            continue;
        }

        const buyCount = req.buyCount ?? req.minCount;
        status.lastAction = `short on gear (have ${have}, need ${req.minCount}) - walking to shop`;
        writeStatus(botName, status);
        logEvent(botName, { task: taskLabel, event: 'gear_shortage', have, need: req.minCount });

        try {
            const walked = await fastWalkTo(bot, sdk, req.shopSpot.x, req.shopSpot.z);
            if (!walked.success) {
                logEvent(botName, { task: taskLabel, level: 'warn', msg: `Could not walk to gear shop: ${walked.message}` });
                return false;
            }

            const opened = await bot.openShop();
            if (!opened.success) {
                logEvent(botName, { task: taskLabel, level: 'warn', msg: `Shop open failed: ${opened.message}` });
                return false;
            }

            const bought = await bot.buyFromShop(req.pattern, buyCount - have);
            await bot.closeShop();
            if (!bought.success && (bought.amountBought ?? 0) === 0) {
                logEvent(botName, { task: taskLabel, level: 'error', msg: `Could not buy gear: ${bought.message}` });
                return false;
            }

            status.lastAction = `bought ${bought.amountBought ?? buyCount - have} gear item(s)`;
            writeStatus(botName, status);
            logEvent(botName, { task: taskLabel, event: 'gear_bought', amount: bought.amountBought ?? buyCount - have });
        } catch (err) {
            logEvent(botName, { task: taskLabel, level: 'warn', msg: `Gear shop trip threw: ${err}` });
            return false;
        }
    }
    return true;
}
