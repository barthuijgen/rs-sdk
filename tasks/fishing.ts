// Fishing training: fish at a site's fishing spot, auto-picking the
// highest-level catch the current Fishing level qualifies for (so a single
// run naturally progresses shrimp -> sardine -> herring -> anchovies at
// Draynor, for example) unless `forcedFish` pins one. Buys whatever tool
// (and bait/feathers) that catch needs before fishing - see
// tasks/lib/shop.ts - and banks raw fish (keeping tools/bait/food) when
// full.
//
// Fishing spots are NPCs, not locations, and advertise multiple options at
// once (e.g. "Net"/"Bait") - which option you click decides which fish you
// get, not just which tool you need. See learnings/fishing.md.
//
// Which spot/bank/catches are available comes from tasks/lib/sites.ts's
// FISHING_SITES by default.
//
// Standalone:  bun tasks/fishing.ts <botname> [--target=30] [--site=draynor-net-bait]
//              [--fish="shrimp"] [--spot=x,z] [--bankSpot=x,z] [--embedded]
// As a library: import { runFishingTask } from './fishing'.

import { runScript, type ScriptContext } from '../sdk/runner';
import { newStatus, writeStatus, logEvent, type TaskStatus } from './lib/status';
import { ensureBankSpace } from './lib/bank';
import { ensureGear } from './lib/shop';
import { fastWalkTo } from './lib/fastWalk';
import { newFailureStreak, recordFailure, recordSuccess, newStaleStreak, checkClientHealth } from './lib/guard';
import {
    FISHING_SITES,
    FISHING_GEAR_SHOP,
    FISHING_GEAR_SHOP_BANK,
    findFishingSite,
    bestFishCatchForLevel,
    bestFishingSiteForLevel,
    type FishingSite,
    type FishCatch,
} from './lib/sites';

const FISHING_SPOT_PATTERN = /fishing\s*spot/i;

/** One-time check (not per-iteration) for already-bought bait sitting in
 * the bank, so the initial site choice can treat it the same as bait
 * already in hand - confirmed live: a fly fishing rod + 76 feathers ended
 * up banked by an earlier, differently-focused run, and without this the
 * site picker would never know they were there to use up. */
async function peekBankedBaitNames(
    bot: import('../sdk/actions').BotActions,
    sdk: import('../sdk/index').BotSDK,
    bankSpot: { x: number; z: number },
): Promise<string[]> {
    try {
        const walked = await fastWalkTo(bot, sdk, bankSpot.x, bankSpot.z);
        if (!walked.success) return [];
        const opened = await bot.openBank();
        if (!opened.success) return [];
        const baitPatterns = FISHING_SITES.flatMap(s => s.catches.flatMap(c => c.bait ? [c.bait] : []));
        const names = sdk.getBankItems()
            .filter(i => baitPatterns.some(p => p.test(i.name)))
            .map(i => i.name);
        await bot.closeBank();
        return names;
    } catch {
        return [];
    }
}

export interface FishingTaskOptions {
    targetLevel: number;
    site: FishingSite;
    /** Lock to this fish (matches FishCatch.fish) instead of auto-picking
     * the best one the current Fishing level qualifies for at this site. */
    forcedFish?: string;
    bankSpot?: { x: number; z: number };
    gearShopSpot?: { x: number; z: number };
    maxMs?: number;
}

export async function runFishingTask(
    ctx: ScriptContext,
    botName: string,
    status: TaskStatus,
    opts: FishingTaskOptions,
): Promise<void> {
    const { bot, sdk } = ctx;
    const deadline = Date.now() + (opts.maxMs ?? 60 * 60_000);
    const bankSpot = opts.bankSpot ?? opts.site.bankSpot;
    const gearShopSpot = opts.gearShopSpot ?? FISHING_GEAR_SHOP;
    let noTargetStreak = 0;
    let fallbackWalkFailStreak = 0;
    const errorStreak = newFailureStreak();
    const staleStreak = newStaleStreak();

    const level = () => sdk.getSkill('Fishing')?.baseLevel ?? 1;

    // Bait/feathers already in the inventory are a sunk cost - using them up
    // is free right now even though the catch that needs them isn't
    // "resource-free" in general. Re-checked every call, so this naturally
    // reverts to a true no-bait catch once a carried stock runs dry.
    const alreadyHaveBait = (bait: RegExp) => (sdk.findInventoryItem(bait)?.count ?? 0) > 0;

    const activeCatch = (): FishCatch | undefined => {
        if (opts.forcedFish) {
            return opts.site.catches.find(c => c.fish.toLowerCase() === opts.forcedFish!.toLowerCase());
        }
        return bestFishCatchForLevel(opts.site, level(), alreadyHaveBait);
    };

    while (level() < opts.targetLevel && Date.now() < deadline) {
        status.iteration++;
        const state = sdk.getState();
        if (!state) {
            await sdk.waitForTicks(1);
            continue;
        }

        const health = await checkClientHealth(botName, status, 'fishing', sdk, staleStreak);
        if (health === 'stop') return;
        if (health === 'skip') continue;

        const catchDef = activeCatch();
        if (!catchDef) {
            status.needsAttention = true;
            status.lastError = `No catch at site "${opts.site.name}" fits Fishing level ${level()}`;
            writeStatus(botName, status);
            logEvent(botName, { task: 'fishing', level: 'error', msg: 'no_catch_for_level', site: opts.site.name });
            return;
        }

        // Tool/bait before anything else - fishing with the wrong gear
        // either does nothing or isn't even offered as an option below.
        // coinBankSpot: buying needs gp, which a fresh/looted-out character
        // may not be carrying - see tasks/lib/shop.ts. Bait is `bankOnly`:
        // use up whatever's already bought (inventory or bank), but don't
        // auto-rebuy once it's gone - that would silently turn "use the
        // feathers we already have" into "keep buying feathers forever,"
        // the opposite of why a bait-free catch is preferred in the first
        // place. The tool itself (never consumed) is fine to actually buy.
        const gearOk = await ensureGear(bot, sdk, botName, status, 'fishing', [
            { pattern: catchDef.tool, minCount: 1, shopSpot: gearShopSpot },
            ...(catchDef.bait ? [{ pattern: catchDef.bait, minCount: 1, buyCount: 100, shopSpot: gearShopSpot, bankOnly: true }] : []),
        ], { coinBankSpot: FISHING_GEAR_SHOP_BANK });
        if (!gearOk) {
            status.needsAttention = true;
            status.lastError = `Could not acquire gear for "${catchDef.fish}" (${catchDef.tool})`;
            writeStatus(botName, status);
            logEvent(botName, { task: 'fishing', level: 'error', msg: 'gear_unreachable', fish: catchDef.fish });
            return;
        }

        // Re-pick: ensureGear's bank-only bait attempt may not have panned
        // out (bank was empty of it too), in which case activeCatch() now
        // correctly falls back to a catch that needs no bait at all, rather
        // than pressing on with one we can't actually use.
        const confirmedCatch = activeCatch();
        if (!confirmedCatch) continue; // transient - re-evaluate next iteration

        const okToContinue = await ensureBankSpace(bot, sdk, botName, status, {
            // Keep every tool/bait this site's catches might need (not just
            // the active one) so switching catches mid-run as level rises
            // never gets its own gear deposited by accident.
            keep: [...opts.site.catches.map(c => c.tool), ...opts.site.catches.flatMap(c => c.bait ? [c.bait] : [])],
            taskLabel: 'fishing',
            bankSpot,
        });
        if (!okToContinue) return;
        if (sdk.getInventory().length >= 28) continue;

        const optionPattern = new RegExp(`^${confirmedCatch.option}$`, 'i');
        const spot = state.nearbyNpcs
            .filter(n => FISHING_SPOT_PATTERN.test(n.name))
            .filter(n => n.reachable !== false)
            .filter(n => n.optionsWithIndex.some(o => optionPattern.test(o.text)))
            .sort((a, b) => a.distance - b.distance)[0];

        if (!spot) {
            noTargetStreak++;
            status.lastAction = `no reachable fishing spot for "${confirmedCatch.fish}" (${confirmedCatch.option}) nearby (${noTargetStreak})`;
            writeStatus(botName, status);
            if (noTargetStreak === 5) {
                status.lastAction = `no spot nearby, walking back to (${opts.site.spot.x}, ${opts.site.spot.z})`;
                writeStatus(botName, status);
                logEvent(botName, { task: 'fishing', event: 'walk_to_spot', spot: opts.site.spot });
                // Checked, not swallowed - see tasks/README.md "Lessons
                // learned" (fastWalkTo resolves success:false rather than
                // throwing when it genuinely can't get there, e.g. a closed
                // door mid-route; a bare .catch() never sees that).
                const walked = await fastWalkTo(bot, sdk, opts.site.spot.x, opts.site.spot.z, {
                    onProgress: msg => logEvent(botName, { task: 'fishing', event: 'walk_progress', msg }),
                }).catch(err => ({ success: false, message: String(err) }));
                if (walked.success) {
                    fallbackWalkFailStreak = 0;
                } else {
                    fallbackWalkFailStreak++;
                    status.lastAction = `walk to spot failed (${fallbackWalkFailStreak}): ${walked.message}`;
                    writeStatus(botName, status);
                    logEvent(botName, { task: 'fishing', level: 'warn', msg: `walk to spot failed: ${walked.message}` });
                    if (fallbackWalkFailStreak >= 10) {
                        status.needsAttention = true;
                        status.lastError = `Could not reach the fishing spot after ${fallbackWalkFailStreak} attempts: ${walked.message}`;
                        writeStatus(botName, status);
                        logEvent(botName, { task: 'fishing', level: 'error', msg: 'fallback_walk_unreachable' });
                        return;
                    }
                }
                noTargetStreak = 0;
            } else {
                await sdk.waitForTicks(2);
            }
            continue;
        }
        noTargetStreak = 0;

        const xpBefore = sdk.getSkillXp('Fishing') ?? 0;
        try {
            const result = await bot.interactNpc(spot, confirmedCatch.option);
            recordSuccess(errorStreak);
            if (!result.success) {
                status.lastAction = `fish failed (${confirmedCatch.fish}): ${result.message}`;
                logEvent(botName, { task: 'fishing', level: 'warn', msg: result.message, fish: confirmedCatch.fish, reason: result.reason });
                writeStatus(botName, status);
                continue;
            }

            // interactNpc's own wait already confirmed the animation started;
            // give the catch itself a few more ticks to land before looping
            // back around (fishing spots can also deplete/move mid-catch).
            for (let i = 0; i < 6; i++) {
                await sdk.waitForTicks(1);
                const s = sdk.getState();
                if (s?.dialog?.isOpen) await bot.dismissBlockingUI();
                const xpNow = sdk.getSkillXp('Fishing') ?? 0;
                if (xpNow > xpBefore) {
                    status.actionsCompleted++;
                    status.lastAction = `caught ${confirmedCatch.fish} #${status.actionsCompleted}`;
                    logEvent(botName, { task: 'fishing', event: 'catch', fish: confirmedCatch.fish, count: status.actionsCompleted });
                    break;
                }
            }
        } catch (err) {
            const canContinue = await recordFailure(botName, status, 'fishing', err, errorStreak);
            if (!canContinue) return;
            continue;
        }

        status.skills = { Fishing: { level: level(), xp: sdk.getSkillXp('Fishing') ?? 0 } };
        writeStatus(botName, status);
    }

    logEvent(botName, { task: 'fishing', event: 'task_complete', skillLevel: level() });
}

if (import.meta.main) {
    const botName = process.argv[2];
    if (!botName) {
        console.error(
            'Usage: bun tasks/fishing.ts <botname> [--target=30] [--site=draynor-net-bait] ' +
            '[--fish="shrimp"] [--spot=x,z] [--bankSpot=x,z] [--embedded]\n' +
            `Known sites: ${FISHING_SITES.map(s => s.name).join(', ')}`
        );
        process.exit(1);
    }
    const argVal = (flag: string) => process.argv.find(a => a.startsWith(flag))?.split('=')[1];

    const targetArg = argVal('--target=');
    const targetLevel = targetArg ? parseInt(targetArg, 10) : 30;

    const parseCoords = (raw: string | undefined) => {
        if (!raw) return undefined;
        const [x, z] = raw.split(',').map(Number);
        return { x, z };
    };

    const siteArg = argVal('--site=');
    const site = siteArg ? findFishingSite(siteArg) : undefined;
    if (siteArg && !site) {
        console.error(`Unknown --site="${siteArg}". Known sites: ${FISHING_SITES.map(s => s.name).join(', ')}`);
        process.exit(1);
    }
    const fishArg = argVal('--fish=');
    const embedded = process.argv.includes('--embedded');

    const runTask = async (ctx: { bot: import('../sdk/actions').BotActions; sdk: any }) => {
        // No site named: pick whichever site+catch combo the bot's current
        // Fishing level best qualifies for across every known site. Checks
        // the bank once upfront too (see peekBankedBaitNames), not just
        // inventory, so bait already bought - wherever it's currently
        // sitting - gets used up instead of ignored.
        const bankedBait = site ? [] : await peekBankedBaitNames(ctx.bot, ctx.sdk, FISHING_GEAR_SHOP_BANK);
        const alreadyHaveBait = (bait: RegExp) =>
            (ctx.sdk.findInventoryItem(bait)?.count ?? 0) > 0 || bankedBait.some(name => bait.test(name));
        const chosenSite = site ?? bestFishingSiteForLevel(
            ctx.sdk.getSkill('Fishing')?.baseLevel ?? 1,
            alreadyHaveBait,
        )?.site ?? FISHING_SITES[0]!;
        const fallbackSpot = parseCoords(argVal('--spot=')) ?? chosenSite.spot;
        const bankSpot = parseCoords(argVal('--bankSpot=')) ?? chosenSite.bankSpot;

        const label = `fishing:${targetLevel}`;
        const status = newStatus(botName, [label]);
        status.currentTask = label;
        writeStatus(botName, status);
        logEvent(botName, { task: 'fishing', event: 'site_chosen', site: chosenSite.name });
        await runFishingTask(ctx, botName, status, {
            targetLevel,
            site: { ...chosenSite, spot: fallbackSpot },
            forcedFish: fishArg,
            bankSpot,
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
