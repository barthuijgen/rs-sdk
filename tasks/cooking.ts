// Cooking: turn raw fish or meat into food at a range/fire, closing the
// fishing -> cooking -> thieving money loop without ever buying anything
// (fish), or the combat -> pickupDrops -> cooking loop (meat) - see
// tasks/README.md. Cooks whatever raw fish/meat is in the inventory (or,
// once that runs out, withdraws more from the bank), banking the cooked
// result for tasks/lib/health.ts's ensureHealthy() to withdraw later. Stops
// once neither the inventory nor the bank has any raw food left that the
// current Cooking level can actually cook - there's no fixed target level
// to loop on the way other tasks do.
//
// Standalone:  bun tasks/cooking.ts <botname> [--spot=x,z] [--bankSpot=x,z] [--maxMs=3600000]
// As a library: import { runCookingTask } from './cooking'.

import { runScript, type ScriptContext } from '../sdk/runner';
import { newStatus, writeStatus, logEvent, type TaskStatus } from './lib/status';
import { escapeRegExp, depositAllExcept, DEFAULT_BANK_SPOT } from './lib/bank';
import { fastWalkTo } from './lib/fastWalk';
import { newFailureStreak, recordFailure, recordSuccess, newStaleStreak, checkClientHealth } from './lib/guard';
import { RAW_FOOD_PATTERN, cookingLevelReqFor } from './lib/food';
import { COOKING_SPOT, COOKING_SOURCE_PATTERN } from './lib/sites';
import type { BotActions } from '../sdk/actions';
import type { BotSDK } from '../sdk/index';

export interface CookingTaskOptions {
    rangeSpot?: { x: number; z: number };
    bankSpot?: { x: number; z: number };
    maxMs?: number;
}

/** No cookable raw fish/meat on hand - bank whatever cooked food we're
 * carrying (so every other task's ensureHealthy() restock can find it) and
 * withdraw one raw type to work through next. Exception-safe, same lesson
 * as tasks/lib/bank.ts's performBankTrip. */
async function restockRawFood(
    bot: BotActions,
    sdk: BotSDK,
    botName: string,
    status: TaskStatus,
    bankSpot: { x: number; z: number },
    cookingLevel: number,
): Promise<'got_more' | 'nothing_left' | 'failed'> {
    status.lastAction = 'no cookable raw fish/meat on hand - checking the bank';
    writeStatus(botName, status);
    try {
        const walked = await fastWalkTo(bot, sdk, bankSpot.x, bankSpot.z, {
            onProgress: msg => logEvent(botName, { task: 'cooking', event: 'walk_progress', msg }),
        });
        if (!walked.success) {
            logEvent(botName, { task: 'cooking', level: 'warn', msg: `Could not walk to bank: ${walked.message}` });
            return 'failed';
        }
        const opened = await bot.openBank();
        if (!opened.success) {
            logEvent(botName, { task: 'cooking', level: 'warn', msg: `Bank open failed: ${opened.message}` });
            return 'failed';
        }

        // Deposit everything except raw food - not just COOKED_FOOD_PATTERN
        // matches. That pattern deliberately excludes burnt fish/meat (0
        // heal, see tasks/lib/food.ts), so a cooked-only sweep left burnt
        // food (and any other junk) piling up in the inventory forever,
        // eventually crowding out the withdraw-space check below.
        await depositAllExcept(bot, sdk, [RAW_FOOD_PATTERN], msg =>
            logEvent(botName, { task: 'cooking', level: 'warn', msg }),
        );

        const rawInBank = sdk.getBankItems()
            .filter(i => RAW_FOOD_PATTERN.test(i.name))
            .filter(i => cookingLevelReqFor(i.name) <= cookingLevel);
        if (rawInBank.length === 0) {
            await bot.closeBank();
            return 'nothing_left';
        }

        // One raw type per trip is enough - the main loop comes back
        // for another type later if this one runs out first.
        const space = 28 - sdk.getInventory().length;
        let withdrew = false;
        if (space > 0) {
            const item = rawInBank[0]!;
            const result = await bot.withdrawItem(new RegExp(`^${escapeRegExp(item.name)}$`, 'i'), Math.min(20, space));
            withdrew = (result.amountWithdrawn ?? 0) > 0;
        }
        await bot.closeBank();
        return withdrew ? 'got_more' : 'nothing_left';
    } catch (err) {
        logEvent(botName, { task: 'cooking', level: 'warn', msg: `Raw fish bank trip threw: ${err}` });
        return 'failed';
    }
}

export async function runCookingTask(
    ctx: ScriptContext,
    botName: string,
    status: TaskStatus,
    opts: CookingTaskOptions = {},
): Promise<void> {
    const { bot, sdk } = ctx;
    const deadline = Date.now() + (opts.maxMs ?? 60 * 60_000);
    const rangeSpot = opts.rangeSpot ?? COOKING_SPOT;
    const bankSpot = opts.bankSpot ?? DEFAULT_BANK_SPOT;
    const errorStreak = newFailureStreak();
    const staleStreak = newStaleStreak();
    let noRangeStreak = 0;
    let fallbackWalkFailStreak = 0;

    const cookingLevel = () => sdk.getSkill('Cooking')?.baseLevel ?? 1;

    while (Date.now() < deadline) {
        status.iteration++;
        const state = sdk.getState();
        if (!state) {
            await sdk.waitForTicks(1);
            continue;
        }

        const health = await checkClientHealth(botName, status, 'cooking', sdk, staleStreak);
        if (health === 'stop') return;
        if (health === 'skip') continue;

        const raw = sdk.getInventory()
            .filter(i => RAW_FOOD_PATTERN.test(i.name))
            .find(i => cookingLevelReqFor(i.name) <= cookingLevel());

        if (!raw) {
            const result = await restockRawFood(bot, sdk, botName, status, bankSpot, cookingLevel());
            if (result === 'nothing_left') {
                status.lastAction = 'no cookable raw fish/meat in inventory or bank - done for now';
                writeStatus(botName, status);
                logEvent(botName, { task: 'cooking', event: 'task_complete', reason: 'nothing_left', skillLevel: cookingLevel() });
                return;
            }
            if (result === 'failed') {
                status.needsAttention = true;
                status.lastError = 'Could not reach the bank to restock raw fish/meat';
                writeStatus(botName, status);
                logEvent(botName, { task: 'cooking', level: 'error', msg: 'bank_unreachable' });
                return;
            }
            continue; // 'got_more' - re-check inventory next iteration
        }

        const source = sdk.findNearbyLoc(COOKING_SOURCE_PATTERN, { reachable: true });
        if (!source) {
            noRangeStreak++;
            status.lastAction = `no reachable cooking source nearby (${noRangeStreak})`;
            writeStatus(botName, status);
            if (noRangeStreak === 5) {
                status.lastAction = `no cooking source nearby, walking to (${rangeSpot.x}, ${rangeSpot.z})`;
                writeStatus(botName, status);
                logEvent(botName, { task: 'cooking', event: 'walk_to_range', spot: rangeSpot });
                // Checked, not swallowed - see tasks/README.md "Lessons
                // learned" (fastWalkTo resolves success:false rather than
                // throwing when it genuinely can't get there, e.g. a closed
                // door mid-route; a bare .catch() never sees that).
                const walked = await fastWalkTo(bot, sdk, rangeSpot.x, rangeSpot.z, {
                    onProgress: msg => logEvent(botName, { task: 'cooking', event: 'walk_progress', msg }),
                }).catch(err => ({ success: false, message: String(err) }));
                if (walked.success) {
                    fallbackWalkFailStreak = 0;
                } else {
                    fallbackWalkFailStreak++;
                    status.lastAction = `walk to range failed (${fallbackWalkFailStreak}): ${walked.message}`;
                    writeStatus(botName, status);
                    logEvent(botName, { task: 'cooking', level: 'warn', msg: `walk to range failed: ${walked.message}` });
                    if (fallbackWalkFailStreak >= 10) {
                        status.needsAttention = true;
                        status.lastError = `Could not reach a cooking source after ${fallbackWalkFailStreak} attempts: ${walked.message}`;
                        writeStatus(botName, status);
                        logEvent(botName, { task: 'cooking', level: 'error', msg: 'fallback_walk_unreachable' });
                        return;
                    }
                }
                noRangeStreak = 0;
            } else {
                await sdk.waitForTicks(2);
            }
            continue;
        }
        noRangeStreak = 0;

        const beforeCount = sdk.getInventory().filter(i => i.name === raw.name).reduce((sum, i) => sum + i.count, 0);
        try {
            const result = await bot.useItemOnLoc(raw, source);
            recordSuccess(errorStreak);
            if (!result.success) {
                status.lastAction = `cook failed (${raw.name}): ${result.message}`;
                logEvent(botName, { task: 'cooking', level: 'warn', msg: result.message, item: raw.name, reason: result.reason });
                writeStatus(botName, status);
                continue;
            }

            // useItemOnLoc's own wait only confirms the attempt started
            // (animation/dialog/inventory change) - give the specific raw
            // fish's count a few more ticks to actually drop before
            // counting this as one resolved attempt (burnt or not, the
            // raw fish is consumed either way).
            for (let i = 0; i < 8; i++) {
                await sdk.waitForTicks(1);
                const s = sdk.getState();
                if (s?.dialog?.isOpen) await bot.dismissBlockingUI();
                const nowCount = (s?.inventory ?? []).filter(it => it.name === raw.name).reduce((sum, it) => sum + it.count, 0);
                if (nowCount < beforeCount) {
                    status.actionsCompleted++;
                    status.lastAction = `cooked ${raw.name} #${status.actionsCompleted}`;
                    logEvent(botName, { task: 'cooking', event: 'cook', item: raw.name, count: status.actionsCompleted });
                    break;
                }
            }
        } catch (err) {
            const canContinue = await recordFailure(botName, status, 'cooking', err, errorStreak);
            if (!canContinue) return;
            continue;
        }

        status.skills = { Cooking: { level: cookingLevel(), xp: sdk.getSkillXp('Cooking') ?? 0 } };
        writeStatus(botName, status);
    }

    logEvent(botName, { task: 'cooking', event: 'task_complete', reason: 'maxMs', skillLevel: cookingLevel() });
}

if (import.meta.main) {
    const botName = process.argv[2];
    if (!botName) {
        console.error('Usage: bun tasks/cooking.ts <botname> [--spot=x,z] [--bankSpot=x,z] [--maxMs=3600000] [--embedded]');
        process.exit(1);
    }
    const argVal = (flag: string) => process.argv.find(a => a.startsWith(flag))?.split('=')[1];

    const parseCoords = (raw: string | undefined) => {
        if (!raw) return undefined;
        const [x, z] = raw.split(',').map(Number);
        return { x, z };
    };
    const rangeSpot = parseCoords(argVal('--spot='));
    const bankSpot = parseCoords(argVal('--bankSpot='));
    const maxArg = argVal('--maxMs=');
    const embedded = process.argv.includes('--embedded');

    const runTask = async (ctx: { bot: import('../sdk/actions').BotActions; sdk: any }) => {
        const label = 'cooking';
        const status = newStatus(botName, [label]);
        status.currentTask = label;
        writeStatus(botName, status);
        await runCookingTask(ctx, botName, status, {
            rangeSpot,
            bankSpot,
            maxMs: maxArg ? parseInt(maxArg, 10) : undefined,
        });
        status.currentTask = null;
        status.done = true;
        writeStatus(botName, status);
    };

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
