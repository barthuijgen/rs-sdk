// Smithing has two phases, both covered by this script via --mode:
//
// 1. "smelt" (default) - smelt ore into bars at a furnace until
//    `targetQuantity` bars have been made, or the bank runs out of ore.
//    `targetQuantity` is optional - omit it to just run until the ore runs
//    out (or `maxMs`) instead of stopping at a fixed count. Starts with
//    bronze (the only tier buildable at Smithing level 1) - use
//    tasks/mining.ts first to get copper/tin ore into the bank, since
//    smithing only converts what's already there, it doesn't mine anything
//    itself. See tasks/lib/sites.ts's BAR_RECIPES for what each tier needs.
// 2. "smith" - forge banked bars into an item at an anvil (requires a
//    hammer in inventory) until `targetQuantity` items have been made, or
//    the bank runs out of bars. Same as above, `targetQuantity` is optional.
//    See tasks/lib/sites.ts's ITEM_RECIPES for level requirements and
//    bars-per-item.
//
// Standalone:  bun tasks/smithing.ts <botname> --mode=smelt [--bar=bronze]
//              [--target=100] [--furnaceSpot=x,z] [--bankSpot=x,z] [--maxMs=3600000]
//              bun tasks/smithing.ts <botname> --mode=smith --item=dagger
//              [--bar=bronze] [--target=100] [--anvilSpot=x,z] [--bankSpot=x,z]
//              [--maxMs=3600000]
//   (omit --target to run until resources run out instead of a fixed count)
// As a library: import { runSmithingTask, runSmithItemsTask } from './smithing'.

import { runScript, type ScriptContext } from '../sdk/runner';
import { newStatus, writeStatus, logEvent, type TaskStatus } from './lib/status';
import { escapeRegExp } from './lib/bank';
import { fastWalkTo } from './lib/fastWalk';
import { newFailureStreak, recordFailure, recordSuccess, newStaleStreak, checkClientHealth } from './lib/guard';
import {
    BAR_RECIPES, findBarRecipe, FURNACE_PATTERN, SMELT_OPTION, SMITHING_SPOT, SMITHING_BANK_SPOT, type BarRecipe,
    ITEM_RECIPES, findItemRecipe, ANVIL_PATTERN, HAMMER_PATTERN, ANVIL_SPOT, FORGING_BANK_SPOT, type ItemRecipe,
} from './lib/sites';
import type { BotActions } from '../sdk/actions';
import type { BotSDK } from '../sdk/index';

export interface SmithingTaskOptions {
    /** Stop once this many bars have been made. Unbounded (runs until the
     * bank's out of ore, or `maxMs`) if omitted. */
    targetQuantity?: number;
    recipe: BarRecipe;
    furnaceSpot?: { x: number; z: number };
    bankSpot?: { x: number; z: number };
    maxMs?: number;
}

const INVENTORY_SLOTS = 28;
const COAL_PATTERN = /^coal$/i;

/** Inventory slots one bar's worth of smelting materials takes: the primary
 * ore, the secondary ore if any (bronze: tin, 1:1 with copper), and
 * `coalCount` coal for the coal tiers (steel and up, e.g. 1 iron : 2 coal).
 * Used to size each bank trip to fill the inventory while keeping the
 * recipe's ratio intact, instead of a flat ore count that left most of the
 * inventory's 28 slots empty on a single-resource smelt like iron. */
function slotsPerBar(recipe: BarRecipe): number {
    return 1 + (recipe.secondaryOre ? 1 : 0) + (recipe.coalCount ?? 0);
}

/** Sweep every inventory slot not matching `keep` into the open bank, same
 * "snapshot distinct names, deposit -1 of each" approach as
 * tasks/lib/bank.ts's performBankTrip - depositing only the task's own
 * product (bars/items) left unrelated loot (gems, drops, starter gear)
 * piling up in the inventory forever, eventually crowding out the ore/bars
 * batch a bank trip is supposed to make room for. */
async function depositAllExcept(bot: BotActions, sdk: BotSDK, keep: RegExp[]): Promise<void> {
    const toDeposit = sdk.getInventory().filter(item => !keep.some(p => p.test(item.name)));
    const distinctNames = [...new Set(toDeposit.map(item => item.name))];
    for (const name of distinctNames) {
        const pattern = new RegExp(`^${escapeRegExp(name)}$`, 'i');
        await bot.depositItem(pattern, -1).catch(() => {});
    }
}

/** No smeltable ore on hand - bank whatever's carried (bars made so far,
 * plus any unrelated loot) and withdraw another batch of ore (the
 * material). Exception-safe, same lesson as tasks/lib/bank.ts's
 * performBankTrip. */
async function restockOre(
    bot: BotActions,
    sdk: BotSDK,
    botName: string,
    status: TaskStatus,
    bankSpot: { x: number; z: number },
    recipe: BarRecipe,
): Promise<'got_more' | 'nothing_left' | 'failed'> {
    status.lastAction = 'no ore on hand - checking the bank';
    writeStatus(botName, status);
    try {
        const walked = await fastWalkTo(bot, sdk, bankSpot.x, bankSpot.z, {
            onProgress: msg => logEvent(botName, { task: 'smithing', event: 'walk_progress', msg }),
        });
        if (!walked.success) {
            logEvent(botName, { task: 'smithing', level: 'warn', msg: `Could not walk to bank: ${walked.message}` });
            return 'failed';
        }
        const opened = await bot.openBank();
        if (!opened.success) {
            logEvent(botName, { task: 'smithing', level: 'warn', msg: `Bank open failed: ${opened.message}` });
            return 'failed';
        }

        // Smelting needs no tool kept in hand - everything carried in gets
        // deposited, including any leftover ore (a fresh batch is withdrawn
        // below regardless).
        await depositAllExcept(bot, sdk, []);

        const havePrimary = sdk.findBankItem(recipe.primaryOre);
        const haveSecondary = recipe.secondaryOre ? sdk.findBankItem(recipe.secondaryOre) : null;
        const haveCoal = recipe.coalCount ? sdk.findBankItem(COAL_PATTERN) : null;
        if (!havePrimary || (recipe.secondaryOre && !haveSecondary) || (recipe.coalCount && !haveCoal)) {
            await bot.closeBank();
            return 'nothing_left';
        }

        // Fill the inventory, not a flat batch - cap by whichever of
        // {inventory space, primary ore, secondary ore, coal / coalCount}
        // runs out first, so e.g. a steel trip (1 iron : 2 coal, 3 slots/bar)
        // pulls up to 9 iron + 18 coal (27 slots) while iron alone (1
        // slot/bar) pulls up to 28.
        const maxBars = Math.floor(INVENTORY_SLOTS / slotsPerBar(recipe));
        const amount = Math.min(
            maxBars,
            havePrimary.count,
            haveSecondary?.count ?? Infinity,
            recipe.coalCount ? Math.floor((haveCoal?.count ?? 0) / recipe.coalCount) : Infinity,
        );
        if (amount <= 0) {
            await bot.closeBank();
            return 'nothing_left';
        }
        await bot.withdrawItem(recipe.primaryOre, amount).catch(() => {});
        if (recipe.secondaryOre) await bot.withdrawItem(recipe.secondaryOre, amount).catch(() => {});
        if (recipe.coalCount) await bot.withdrawItem(COAL_PATTERN, amount * recipe.coalCount).catch(() => {});
        await bot.closeBank();
        return 'got_more';
    } catch (err) {
        logEvent(botName, { task: 'smithing', level: 'warn', msg: `Ore bank trip threw: ${err}` });
        return 'failed';
    }
}

export async function runSmithingTask(
    ctx: ScriptContext,
    botName: string,
    status: TaskStatus,
    opts: SmithingTaskOptions,
): Promise<void> {
    const { bot, sdk } = ctx;
    const deadline = Date.now() + (opts.maxMs ?? 60 * 60_000);
    const furnaceSpot = opts.furnaceSpot ?? SMITHING_SPOT;
    const bankSpot = opts.bankSpot ?? SMITHING_BANK_SPOT;
    const recipe = opts.recipe;
    const errorStreak = newFailureStreak();
    const staleStreak = newStaleStreak();
    let noFurnaceStreak = 0;
    let fallbackWalkFailStreak = 0;

    const smithingLevel = () => sdk.getSkill('Smithing')?.baseLevel ?? 1;
    const barPattern = new RegExp(`^${escapeRegExp(recipe.bar)}$`, 'i');
    const barCount = () => sdk.getInventory().filter(i => barPattern.test(i.name)).reduce((sum, i) => sum + i.count, 0);

    if (smithingLevel() < recipe.levelReq) {
        status.needsAttention = true;
        status.lastError = `Smithing level ${smithingLevel()} is below the requirement (${recipe.levelReq}) for ${recipe.bar}`;
        writeStatus(botName, status);
        logEvent(botName, { task: 'smithing', level: 'error', msg: 'target_bar_too_high_level', bar: recipe.bar });
        return;
    }

    while ((opts.targetQuantity === undefined || status.actionsCompleted < opts.targetQuantity) && Date.now() < deadline) {
        status.iteration++;
        const state = sdk.getState();
        if (!state) {
            await sdk.waitForTicks(1);
            continue;
        }

        const health = await checkClientHealth(botName, status, 'smithing', sdk, staleStreak);
        if (health === 'stop') return;
        if (health === 'skip') continue;

        const primary = sdk.findInventoryItem(recipe.primaryOre);
        const haveSecondary = recipe.secondaryOre ? sdk.findInventoryItem(recipe.secondaryOre) : true;
        if (!primary || !haveSecondary) {
            const result = await restockOre(bot, sdk, botName, status, bankSpot, recipe);
            if (result === 'nothing_left') {
                status.lastAction = `out of ore for ${recipe.bar} - done for now (${status.actionsCompleted}${opts.targetQuantity !== undefined ? `/${opts.targetQuantity}` : ''})`;
                writeStatus(botName, status);
                logEvent(botName, { task: 'smithing', event: 'task_complete', reason: 'nothing_left', bar: recipe.bar, made: status.actionsCompleted });
                return;
            }
            if (result === 'failed') {
                status.needsAttention = true;
                status.lastError = 'Could not reach the bank to restock ore';
                writeStatus(botName, status);
                logEvent(botName, { task: 'smithing', level: 'error', msg: 'bank_unreachable' });
                return;
            }
            continue; // 'got_more' - re-check inventory next iteration
        }

        const furnace = sdk.findNearbyLoc(FURNACE_PATTERN, { reachable: true, withOption: SMELT_OPTION });
        if (!furnace) {
            noFurnaceStreak++;
            status.lastAction = `no reachable furnace nearby (${noFurnaceStreak})`;
            writeStatus(botName, status);
            if (noFurnaceStreak === 5) {
                status.lastAction = `no furnace nearby, walking to (${furnaceSpot.x}, ${furnaceSpot.z})`;
                writeStatus(botName, status);
                logEvent(botName, { task: 'smithing', event: 'walk_to_furnace', spot: furnaceSpot });
                const walked = await fastWalkTo(bot, sdk, furnaceSpot.x, furnaceSpot.z, {
                    onProgress: msg => logEvent(botName, { task: 'smithing', event: 'walk_progress', msg }),
                }).catch(err => ({ success: false, message: String(err) }));
                if (walked.success) {
                    fallbackWalkFailStreak = 0;
                } else {
                    fallbackWalkFailStreak++;
                    status.lastAction = `walk to furnace failed (${fallbackWalkFailStreak}): ${walked.message}`;
                    writeStatus(botName, status);
                    logEvent(botName, { task: 'smithing', level: 'warn', msg: `walk to furnace failed: ${walked.message}` });
                    if (fallbackWalkFailStreak >= 10) {
                        status.needsAttention = true;
                        status.lastError = `Could not reach the furnace after ${fallbackWalkFailStreak} attempts: ${walked.message}`;
                        writeStatus(botName, status);
                        logEvent(botName, { task: 'smithing', level: 'error', msg: 'fallback_walk_unreachable' });
                        return;
                    }
                }
                noFurnaceStreak = 0;
            } else {
                await sdk.waitForTicks(2);
            }
            continue;
        }
        noFurnaceStreak = 0;

        const beforeCount = barCount();
        try {
            const result = await bot.useItemOnLoc(primary, furnace);
            recordSuccess(errorStreak);
            if (!result.success) {
                status.lastAction = `smelt failed (${recipe.bar}): ${result.message}`;
                logEvent(botName, { task: 'smithing', level: 'warn', msg: result.message, bar: recipe.bar, reason: result.reason });
                writeStatus(botName, status);
                continue;
            }

            // useItemOnLoc's own wait only confirms the attempt started -
            // give the actual bar a few more ticks to appear. Iron (and
            // presumably the coal tiers) can fail the smelt outright per
            // wiki/skills/smithing.md's success-rate note, consuming the
            // ore either way - same "count what's consumed, not just what
            // succeeded" lesson as tasks/cooking.ts.
            for (let i = 0; i < 8; i++) {
                await sdk.waitForTicks(1);
                const s = sdk.getState();
                if (s?.dialog?.isOpen) await bot.dismissBlockingUI();
                if (barCount() > beforeCount) {
                    status.actionsCompleted++;
                    status.lastAction = `smelted ${recipe.bar} #${status.actionsCompleted}${opts.targetQuantity !== undefined ? `/${opts.targetQuantity}` : ''}`;
                    logEvent(botName, { task: 'smithing', event: 'smelt', bar: recipe.bar, count: status.actionsCompleted });
                    break;
                }
            }
        } catch (err) {
            const canContinue = await recordFailure(botName, status, 'smithing', err, errorStreak);
            if (!canContinue) return;
            continue;
        }

        status.skills = { Smithing: { level: smithingLevel(), xp: sdk.getSkillXp('Smithing') ?? 0 } };
        writeStatus(botName, status);
    }

    logEvent(botName, {
        task: 'smithing',
        event: 'task_complete',
        reason: opts.targetQuantity !== undefined ? 'target_reached' : 'deadline_reached',
        bar: recipe.bar,
        made: status.actionsCompleted,
    });
}

export interface SmithItemsTaskOptions {
    /** Stop once this many items have been made. Unbounded (runs until the
     * bank's out of bars, or `maxMs`) if omitted. */
    targetQuantity?: number;
    metal: string; // key into BAR_RECIPES, e.g. 'bronze'
    item: ItemRecipe;
    anvilSpot?: { x: number; z: number };
    bankSpot?: { x: number; z: number };
    maxMs?: number;
}

/** No bars (or no hammer) on hand - bank whatever items were forged (the
 * loot) and withdraw another batch of bars (the material). A missing hammer
 * is topped up from the bank too, since it's a one-time purchase that's
 * normally just sitting there - but a bank with no hammer at all means it
 * was never bought, which this task can't fix on its own. */
async function restockBars(
    bot: BotActions,
    sdk: BotSDK,
    botName: string,
    status: TaskStatus,
    bankSpot: { x: number; z: number },
    barPattern: RegExp,
    barsRequired: number,
    batchSize: number,
): Promise<'got_more' | 'nothing_left' | 'no_hammer' | 'failed'> {
    status.lastAction = 'no bars on hand - checking the bank';
    writeStatus(botName, status);
    try {
        const walked = await fastWalkTo(bot, sdk, bankSpot.x, bankSpot.z, {
            onProgress: msg => logEvent(botName, { task: 'smithing', event: 'walk_progress', msg }),
        });
        if (!walked.success) {
            logEvent(botName, { task: 'smithing', level: 'warn', msg: `Could not walk to bank: ${walked.message}` });
            return 'failed';
        }
        const opened = await bot.openBank();
        if (!opened.success) {
            logEvent(botName, { task: 'smithing', level: 'warn', msg: `Bank open failed: ${opened.message}` });
            return 'failed';
        }

        // Keep the hammer in hand - deposit everything else carried in,
        // including forged items (the loot) and any unrelated junk.
        await depositAllExcept(bot, sdk, [HAMMER_PATTERN]);

        if (!sdk.findInventoryItem(HAMMER_PATTERN)) {
            const bankHammer = sdk.findBankItem(HAMMER_PATTERN);
            if (bankHammer) {
                await bot.withdrawItem(HAMMER_PATTERN, 1).catch(() => {});
            } else {
                await bot.closeBank();
                return 'no_hammer';
            }
        }

        const haveBars = sdk.findBankItem(barPattern);
        // Not just <= 0 - fewer bars than one item needs can never make
        // progress. Withdrawing that remainder anyway and reporting
        // 'got_more' sent the task straight back into this same bank trip
        // next iteration (barsOnHand still under barsRequired), depositing
        // and withdrawing the identical handful of bars forever.
        if (!haveBars || haveBars.count < barsRequired) {
            await bot.closeBank();
            return 'nothing_left';
        }

        const amount = Math.min(batchSize, haveBars.count);
        await bot.withdrawItem(barPattern, amount).catch(() => {});
        await bot.closeBank();
        return 'got_more';
    } catch (err) {
        logEvent(botName, { task: 'smithing', level: 'warn', msg: `Bar bank trip threw: ${err}` });
        return 'failed';
    }
}

/** How many bars to withdraw per bank trip for forging. Kept well under
 * 28 so there's room for whatever's still in the inventory (hammer, leftover
 * bars, forged items not yet banked). */
const BAR_BATCH_SIZE = 24;

export async function runSmithItemsTask(
    ctx: ScriptContext,
    botName: string,
    status: TaskStatus,
    opts: SmithItemsTaskOptions,
): Promise<void> {
    const { bot, sdk } = ctx;
    const deadline = Date.now() + (opts.maxMs ?? 60 * 60_000);
    const anvilSpot = opts.anvilSpot ?? ANVIL_SPOT;
    const bankSpot = opts.bankSpot ?? FORGING_BANK_SPOT;
    const { metal, item } = opts;
    const errorStreak = newFailureStreak();
    const staleStreak = newStaleStreak();
    let noAnvilStreak = 0;
    let fallbackWalkFailStreak = 0;
    // Resolved once and reused for the whole run - the anvil doesn't move,
    // and re-resolving by name every iteration is how the Varrock West
    // smithy's two same-named anvils (1 and 3 tiles apart) got picked
    // inconsistently call to call, sending the player pathing back and
    // forth between them mid-batch even with plenty of bars in hand.
    let pinnedAnvil: { x: number; z: number; id: number } | null = null;

    const barRecipe = findBarRecipe(metal);
    if (!barRecipe) {
        status.needsAttention = true;
        status.lastError = `Unknown metal "${metal}". Known: ${Object.keys(BAR_RECIPES).join(', ')}`;
        writeStatus(botName, status);
        return;
    }
    const barPattern = new RegExp(`^${escapeRegExp(barRecipe.bar)}$`, 'i');
    const productName = `${metal} ${item.item}`;

    const smithingLevel = () => sdk.getSkill('Smithing')?.baseLevel ?? 1;
    const levelReq = item.levelReqByMetal[metal.toLowerCase()];
    if (levelReq === undefined) {
        status.needsAttention = true;
        status.lastError = `No known level requirement for ${metal} ${item.item}`;
        writeStatus(botName, status);
        return;
    }
    if (smithingLevel() < levelReq) {
        status.needsAttention = true;
        status.lastError = `Smithing level ${smithingLevel()} is below the requirement (${levelReq}) for ${productName}`;
        writeStatus(botName, status);
        logEvent(botName, { task: 'smithing', level: 'error', msg: 'target_item_too_high_level', item: productName });
        return;
    }

    while ((opts.targetQuantity === undefined || status.actionsCompleted < opts.targetQuantity) && Date.now() < deadline) {
        status.iteration++;
        const state = sdk.getState();
        if (!state) {
            await sdk.waitForTicks(1);
            continue;
        }

        const health = await checkClientHealth(botName, status, 'smithing', sdk, staleStreak);
        if (health === 'stop') return;
        if (health === 'skip') continue;

        const hasHammer = !!sdk.findInventoryItem(HAMMER_PATTERN);
        // countInventoryItems, not findInventoryItem().count - bars aren't
        // guaranteed to stack into a single slot, and findInventoryItem only
        // reports one slot's count. Undercounting here was sending the task
        // back to the bank every iteration even with a full batch of bars
        // still in hand (deposit-then-immediately-withdraw-the-same-bars
        // loop) whenever an item needed more than 1 bar per smith.
        const barsOnHand = sdk.countInventoryItems(barPattern);
        if (!hasHammer || barsOnHand < item.barsRequired) {
            const result = await restockBars(bot, sdk, botName, status, bankSpot, barPattern, item.barsRequired, BAR_BATCH_SIZE);
            if (result === 'nothing_left') {
                status.lastAction = `out of ${barRecipe.bar} for ${productName} - done for now (${status.actionsCompleted}${opts.targetQuantity !== undefined ? `/${opts.targetQuantity}` : ''})`;
                writeStatus(botName, status);
                logEvent(botName, { task: 'smithing', event: 'task_complete', reason: 'nothing_left', item: productName, made: status.actionsCompleted });
                return;
            }
            if (result === 'no_hammer') {
                status.needsAttention = true;
                status.lastError = 'No hammer in inventory or bank - buy one from a general store first';
                writeStatus(botName, status);
                logEvent(botName, { task: 'smithing', level: 'error', msg: 'no_hammer' });
                return;
            }
            if (result === 'failed') {
                status.needsAttention = true;
                status.lastError = 'Could not reach the bank to restock bars';
                writeStatus(botName, status);
                logEvent(botName, { task: 'smithing', level: 'error', msg: 'bank_unreachable' });
                return;
            }
            continue; // 'got_more' - re-check inventory next iteration
        }

        const anvil = pinnedAnvil ?? sdk.findNearbyLoc(ANVIL_PATTERN, { reachable: true });
        if (!anvil) {
            noAnvilStreak++;
            status.lastAction = `no reachable anvil nearby (${noAnvilStreak})`;
            writeStatus(botName, status);
            if (noAnvilStreak === 5) {
                status.lastAction = `no anvil nearby, walking to (${anvilSpot.x}, ${anvilSpot.z})`;
                writeStatus(botName, status);
                logEvent(botName, { task: 'smithing', event: 'walk_to_anvil', spot: anvilSpot });
                const walked = await fastWalkTo(bot, sdk, anvilSpot.x, anvilSpot.z, {
                    onProgress: msg => logEvent(botName, { task: 'smithing', event: 'walk_progress', msg }),
                }).catch(err => ({ success: false, message: String(err) }));
                if (walked.success) {
                    fallbackWalkFailStreak = 0;
                } else {
                    fallbackWalkFailStreak++;
                    status.lastAction = `walk to anvil failed (${fallbackWalkFailStreak}): ${walked.message}`;
                    writeStatus(botName, status);
                    logEvent(botName, { task: 'smithing', level: 'warn', msg: `walk to anvil failed: ${walked.message}` });
                    if (fallbackWalkFailStreak >= 10) {
                        status.needsAttention = true;
                        status.lastError = `Could not reach the anvil after ${fallbackWalkFailStreak} attempts: ${walked.message}`;
                        writeStatus(botName, status);
                        logEvent(botName, { task: 'smithing', level: 'error', msg: 'fallback_walk_unreachable' });
                        return;
                    }
                }
                noAnvilStreak = 0;
            } else {
                await sdk.waitForTicks(2);
            }
            continue;
        }
        noAnvilStreak = 0;
        pinnedAnvil ??= { x: anvil.x, z: anvil.z, id: anvil.id };

        try {
            const result = await bot.smithAtAnvil(item.item, { barPattern, anvil: pinnedAnvil });
            recordSuccess(errorStreak);
            if (!result.success) {
                status.lastAction = `smith failed (${productName}): ${result.message}`;
                logEvent(botName, { task: 'smithing', level: 'warn', msg: result.message, item: productName, reason: result.reason });
                writeStatus(botName, status);
                if (result.reason === 'no_hammer' || result.reason === 'no_bars' || result.reason === 'level_too_low') {
                    continue; // re-check preconditions next iteration rather than spin
                }
                continue;
            }

            status.actionsCompleted++;
            status.lastAction = `smithed ${productName} #${status.actionsCompleted}${opts.targetQuantity !== undefined ? `/${opts.targetQuantity}` : ''}`;
            logEvent(botName, { task: 'smithing', event: 'smith', item: productName, count: status.actionsCompleted });
        } catch (err) {
            const canContinue = await recordFailure(botName, status, 'smithing', err, errorStreak);
            if (!canContinue) return;
            continue;
        }

        status.skills = { Smithing: { level: smithingLevel(), xp: sdk.getSkillXp('Smithing') ?? 0 } };
        writeStatus(botName, status);
    }

    logEvent(botName, {
        task: 'smithing',
        event: 'task_complete',
        reason: opts.targetQuantity !== undefined ? 'target_reached' : 'deadline_reached',
        item: productName,
        made: status.actionsCompleted,
    });
}

if (import.meta.main) {
    const botName = process.argv[2];
    if (!botName) {
        console.error(
            'Usage: bun tasks/smithing.ts <botname> --mode=smelt [--bar=bronze] [--target=100] ' +
            '[--furnaceSpot=x,z] [--bankSpot=x,z] [--maxMs=3600000] [--embedded]\n' +
            '       bun tasks/smithing.ts <botname> --mode=smith --item=dagger [--bar=bronze] ' +
            '[--target=100] [--anvilSpot=x,z] [--bankSpot=x,z] [--maxMs=3600000] [--embedded]\n' +
            '       (omit --target to run until resources run out)\n' +
            `Known bars: ${Object.keys(BAR_RECIPES).join(', ')}\n` +
            `Known items: ${Object.keys(ITEM_RECIPES).join(', ')}`
        );
        process.exit(1);
    }
    const argVal = (flag: string) => process.argv.find(a => a.startsWith(flag))?.split('=')[1];

    const parseCoords = (raw: string | undefined) => {
        if (!raw) return undefined;
        const [x, z] = raw.split(',').map(Number);
        return { x, z };
    };

    const mode = argVal('--mode=') ?? 'smelt';
    const barArg = argVal('--bar=') ?? 'bronze';
    const targetArg = argVal('--target=');
    const bankSpot = parseCoords(argVal('--bankSpot='));
    const maxArg = argVal('--maxMs=');
    const embedded = process.argv.includes('--embedded');

    let runTask: (ctx: { bot: import('../sdk/actions').BotActions; sdk: any }) => Promise<void>;

    if (mode === 'smith') {
        const itemArg = argVal('--item=') ?? 'dagger';
        const itemRecipe = findItemRecipe(itemArg);
        if (!itemRecipe) {
            console.error(`Unknown --item="${itemArg}". Known items: ${Object.keys(ITEM_RECIPES).join(', ')}`);
            process.exit(1);
        }
        if (!findBarRecipe(barArg)) {
            console.error(`Unknown --bar="${barArg}". Known bars: ${Object.keys(BAR_RECIPES).join(', ')}`);
            process.exit(1);
        }
        const anvilSpot = parseCoords(argVal('--anvilSpot='));

        runTask = async ctx => {
            const label = `smithing-items-${barArg}-${itemArg}`;
            const status = newStatus(botName, [label]);
            status.currentTask = label;
            writeStatus(botName, status);
            await runSmithItemsTask(ctx, botName, status, {
                targetQuantity: targetArg ? parseInt(targetArg, 10) : undefined,
                metal: barArg,
                item: itemRecipe,
                anvilSpot,
                bankSpot,
                maxMs: maxArg ? parseInt(maxArg, 10) : undefined,
            });
            status.currentTask = null;
            status.done = true;
            writeStatus(botName, status);
        };
    } else {
        const recipe = findBarRecipe(barArg);
        if (!recipe) {
            console.error(`Unknown --bar="${barArg}". Known bars: ${Object.keys(BAR_RECIPES).join(', ')}`);
            process.exit(1);
        }
        const furnaceSpot = parseCoords(argVal('--furnaceSpot='));

        runTask = async ctx => {
            const label = `smithing-${barArg}`;
            const status = newStatus(botName, [label]);
            status.currentTask = label;
            writeStatus(botName, status);
            await runSmithingTask(ctx, botName, status, {
                targetQuantity: targetArg ? parseInt(targetArg, 10) : undefined,
                recipe,
                furnaceSpot,
                bankSpot,
                maxMs: maxArg ? parseInt(maxArg, 10) : undefined,
            });
            status.currentTask = null;
            status.done = true;
            writeStatus(botName, status);
        };
    }

    if (embedded) {
        const { runEmbedded } = await import('./lib/embeddedRunner');
        await runEmbedded(botName, runTask);
    } else {
        await runScript(runTask, { disconnectAfter: true, printState: false });
    }
    // A finished/errored run must release the control connection, not hang
    // forever holding it - see tasks/README.md "Lessons learned".
    process.exit();
}
