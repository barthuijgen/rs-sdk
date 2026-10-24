// Melee combat training: fight NPCs matching `targets`, always training
// whichever of Attack/Strength/Defence is lowest. Omit --target (the
// default) to run unbounded - trains forever until --maxMs, same as
// tasks/thieving.ts's unbounded mode - rather than capping out at some
// arbitrary level. Banks non-essential loot (keeping food) whenever the
// inventory fills.
//
// Which targets/spot/bank to use comes from tasks/lib/sites.ts's
// COMBAT_SITES by default.
//
// Standalone:  bun tasks/combat.ts <botname> [--target=30] [--site=lumbridge-cows]
//              [--targets="cow"] [--spot=x,z] [--bankSpot=x,z] [--pickupDrops=false]
//              [--buryBones]
// As a library: import { runCombatTask } from './combat' and call it with
// a shared connection (see plan.ts).

import { runScript, type ScriptContext } from '../sdk/runner';
import type { BotActions } from '../sdk/actions';
import type { BotSDK } from '../sdk/index';
import { newStatus, writeStatus, logEvent, type TaskStatus } from './lib/status';
import { ensureBankSpace } from './lib/bank';
import { fastWalkTo } from './lib/fastWalk';
import { meleeLevels, getLowestMeleeStat, setStyleFor } from './lib/combatStyle';
import { newFailureStreak, recordFailure, recordSuccess, newStaleStreak, checkClientHealth } from './lib/guard';
import { COMBAT_SITES, findCombatSite } from './lib/sites';
import { COOKED_FOOD_PATTERN as FOOD_PATTERN } from './lib/food';

export interface CombatTaskOptions {
    /** Omit to ignore level entirely and run until `maxMs` - see
     * tasks/thieving.ts's ThievingTaskOptions.targetLevel for the same
     * pattern (a required target can be already-met, e.g. a maxed bot
     * fighting for loot, which would stop the loop before the first hit). */
    targetLevel?: number;
    targets: RegExp;
    keepOnBank: RegExp[];
    /** Where to walk if no reachable target has turned up for a while - the
     * bot may have respawned/reconnected somewhere else entirely. */
    fallbackSpot?: { x: number; z: number };
    /** Bank used for loot once the inventory fills. Defaults to Draynor
     * (tasks/lib/bank.ts's DEFAULT_BANK_SPOT) if omitted. */
    bankSpot?: { x: number; z: number };
    /** Safety valve: stop even if the target level isn't reached. */
    maxMs?: number;
    /** Pick up whatever a kill drops (bones, feathers, raw meat, ...) before
     * moving to the next target. On by default. */
    pickupDrops?: boolean;
    /** Bury any Bones picked up, for Prayer xp. Off by default - burying
     * destroys the item, which isn't always what's wanted (e.g. banking
     * bones for the Chaos altar or to sell). */
    buryBones?: boolean;
}

/** Picks up whatever just dropped around the player. Deliberately keyed off
 * the player's current tile rather than the kill's NPC's pre-fight x/z:
 * confirmed live that a wandering target (chickens roam right up to the
 * moment they're attacked) can die several tiles from where it was first
 * targeted, so the drop lands wherever the corpse actually was, not where
 * combat started - melee range (adjacent) is the one position guaranteed to
 * be close, since bot.attack always walks the player there first. Drops
 * don't always publish the same tick the NPC disappears, so this gives it
 * one retry tick before concluding there's nothing (or someone/something
 * else already took it) and moving on. */
async function pickupDropsNearPlayer(
    bot: BotActions,
    sdk: BotSDK,
    botName: string,
    status: TaskStatus,
): Promise<void> {
    const dropsHere = () => {
        const player = sdk.getState()?.player;
        if (!player) return [];
        return sdk.getGroundItems().filter(
            i => Math.abs(i.x - player.worldX) <= 1 && Math.abs(i.z - player.worldZ) <= 1
        );
    };

    let items = dropsHere();
    if (items.length === 0) {
        await sdk.waitForTicks(1);
        items = dropsHere();
    }

    for (const item of items) {
        const result = await bot.pickupItem(item);
        if (result.success) {
            status.lastAction = `picked up ${item.name} x${item.count}`;
            writeStatus(botName, status);
        } else if (result.reason === 'inventory_full') {
            break; // next loop iteration's ensureBankSpace call will handle this
        } else if (result.reason !== 'item_not_found' && result.reason !== 'taken_by_other') {
            logEvent(botName, { task: 'combat', level: 'warn', msg: `pickup failed: ${result.message}` });
        }
    }
}

/** Buries every Bones in the inventory, one at a time. No high-level
 * bot.buryBones() exists yet - this goes through the same low-level
 * sdk.sendUseItem() CLAUDE.md documents for "bury, etc.", using Bones'
 * default option (confirmed live: opIndex 1 is "Bury", no other option
 * listed). Confirmed live: burying takes ~4 ticks ("You dig a hole in the
 * ground..." -> "You bury the bones." -> Prayer xp) and routinely triggers
 * a level-up dialog, so each bury is awaited by the item actually leaving
 * the inventory (not a fixed delay) with dialogs dismissed along the way. */
async function buryAllBones(bot: BotActions, sdk: BotSDK, botName: string, status: TaskStatus): Promise<void> {
    let bones = sdk.findInventoryItem(/^bones$/i);
    while (bones) {
        await bot.dismissBlockingUI();
        const slot = bones.slot;
        const result = await sdk.sendUseItem(slot, 1);
        if (!result.success) {
            logEvent(botName, { task: 'combat', level: 'warn', msg: `bury bones failed: ${result.message}` });
            return;
        }
        try {
            await sdk.waitForCondition(state => {
                if (state.dialog?.isOpen) sdk.sendClickDialog(0).catch(() => {});
                return !state.inventory.some(i => i.slot === slot && /^bones$/i.test(i.name));
            }, 10_000);
        } catch {
            logEvent(botName, { task: 'combat', level: 'warn', msg: 'bury bones timed out' });
            return;
        }
        status.lastAction = 'buried bones';
        writeStatus(botName, status);
        bones = sdk.findInventoryItem(/^bones$/i);
    }
}

export async function runCombatTask(
    ctx: ScriptContext,
    botName: string,
    status: TaskStatus,
    opts: CombatTaskOptions,
): Promise<void> {
    const { bot, sdk } = ctx;
    const deadline = Date.now() + (opts.maxMs ?? 60 * 60_000);
    let noTargetStreak = 0;
    let fallbackWalkFailStreak = 0;
    const errorStreak = newFailureStreak();
    const staleStreak = newStaleStreak();

    const atTarget = () => {
        if (opts.targetLevel === undefined) return false;
        const l = meleeLevels(sdk);
        return l.Attack >= opts.targetLevel && l.Strength >= opts.targetLevel && l.Defence >= opts.targetLevel;
    };

    while (!atTarget() && Date.now() < deadline) {
        status.iteration++;
        const state = sdk.getState();
        if (!state) {
            await sdk.waitForTicks(1);
            continue;
        }

        const health = await checkClientHealth(botName, status, 'combat', sdk, staleStreak);
        if (health === 'stop') return;
        if (health === 'skip') continue;

        // No explicit dialog dismiss here: every bot.* action below
        // (eatFood, bank actions, attack) auto-dismisses blocking UI before
        // executing (see CLAUDE.md), so a separate dismiss-then-continue
        // step here just pays for a second, redundant dismiss cycle on top
        // of the one the next action call does anyway - measured at up to
        // ~7s under current server load for a single level-up dialog. See
        // tasks/README.md "Lessons learned".

        // Survival before anything else.
        const hp = state.player?.hp ?? 10;
        const maxHp = state.player?.maxHp ?? 10;
        if (hp <= Math.max(4, Math.floor(maxHp * 0.3))) {
            const food = sdk.findInventoryItem(FOOD_PATTERN);
            if (food) {
                await bot.eatFood(food);
                status.lastAction = `ate ${food.name} (hp ${hp}/${maxHp})`;
                writeStatus(botName, status);
                continue;
            }
            if (hp <= 3) {
                status.needsAttention = true;
                status.lastError = 'Critical HP with no food in inventory';
                writeStatus(botName, status);
                logEvent(botName, { task: 'combat', level: 'error', msg: 'critical_hp_no_food' });
                return;
            }
        }

        const okToContinue = await ensureBankSpace(bot, sdk, botName, status, {
            keep: opts.keepOnBank,
            restockFood: { pattern: FOOD_PATTERN },
            taskLabel: 'combat',
            bankSpot: opts.bankSpot,
        });
        if (!okToContinue) return;
        if (sdk.getInventory().length >= 28) continue; // just banked, re-check loop state

        const stat = getLowestMeleeStat(sdk);
        await setStyleFor(sdk, stat);

        const target = state.nearbyNpcs
            .filter(n => opts.targets.test(n.name))
            .filter(n => n.reachable !== false)
            .filter(n => !n.inCombat)
            .sort((a, b) => a.distance - b.distance)[0];

        if (!target) {
            noTargetStreak++;
            status.lastAction = `waiting for a free target (${noTargetStreak})`;
            writeStatus(botName, status);
            // Nothing matching nearby for a while - we may have respawned or
            // reconnected somewhere else. Walk toward a known spot instead of
            // waiting forever in a place with no goblins/spiders at all.
            if (opts.fallbackSpot && noTargetStreak === 5) {
                status.lastAction = `no targets nearby, walking to fallback spot (${opts.fallbackSpot.x}, ${opts.fallbackSpot.z})`;
                writeStatus(botName, status);
                logEvent(botName, { task: 'combat', event: 'walk_to_fallback', spot: opts.fallbackSpot });
                // Checked, not swallowed: fastWalkTo resolves with
                // success:false (doesn't throw) when it can't actually get
                // there - e.g. a closed door mid-route, which fastWalkTo's
                // own long-distance click can't open itself and apparently
                // isn't always recovered by its bot.walkTo handoff either
                // (confirmed live: "outside the current build area and no
                // path leads toward its edge" repeated for a real closed
                // door). A bare .catch() here never saw that - only a
                // thrown exception, which this doesn't raise - so it looped
                // silently forever. See tasks/README.md "Lessons learned".
                const walked = await fastWalkTo(bot, sdk, opts.fallbackSpot.x, opts.fallbackSpot.z, {
                    onProgress: msg => logEvent(botName, { task: 'combat', event: 'walk_progress', msg }),
                }).catch(err => ({ success: false, message: String(err) }));
                if (walked.success) {
                    fallbackWalkFailStreak = 0;
                } else {
                    fallbackWalkFailStreak++;
                    status.lastAction = `walk to fallback failed (${fallbackWalkFailStreak}): ${walked.message}`;
                    writeStatus(botName, status);
                    logEvent(botName, { task: 'combat', level: 'warn', msg: `walk to fallback failed: ${walked.message}` });
                    if (fallbackWalkFailStreak >= 10) {
                        status.needsAttention = true;
                        status.lastError = `Could not reach the fallback spot after ${fallbackWalkFailStreak} attempts: ${walked.message}`;
                        writeStatus(botName, status);
                        logEvent(botName, { task: 'combat', level: 'error', msg: 'fallback_walk_unreachable' });
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

        try {
            const result = await bot.attack(target);
            recordSuccess(errorStreak); // dispatch succeeded; a game-logic refusal below isn't a client failure
            if (!result.success) {
                status.lastAction = `attack failed: ${result.message}`;
                // Logged (not just written to status) so tasks/analyze.ts can
                // explain a gap between kills instead of just measuring it.
                logEvent(botName, { task: 'combat', level: 'warn', msg: result.message, reason: result.reason });
                writeStatus(botName, status);
                continue;
            }
            status.lastAction = `attacking ${target.name} (training ${stat})`;

            // Poll in short bounded steps rather than one long wait, so a
            // stuck dialog (stacked level-ups) can't stall this past the
            // task's own deadline - see tasks/README.md "lessons learned".
            let killed = false;
            for (let i = 0; i < 12; i++) {
                await sdk.waitForTicks(1);
                const s = sdk.getState();
                if (s?.dialog?.isOpen) await bot.dismissBlockingUI();
                const stillThere = s?.nearbyNpcs.find(n => n.index === target.index);
                if (!stillThere) {
                    status.actionsCompleted++;
                    logEvent(botName, { task: 'combat', event: 'kill', target: target.name, count: status.actionsCompleted });
                    killed = true;
                    break;
                }
                if (s?.player?.combat.inCombat === false) break;
            }
            if (killed && (opts.pickupDrops ?? true)) {
                await pickupDropsNearPlayer(bot, sdk, botName, status);
                if (opts.buryBones) await buryAllBones(bot, sdk, botName, status);
            }
        } catch (err) {
            const canContinue = await recordFailure(botName, status, 'combat', err, errorStreak);
            if (!canContinue) return;
            continue;
        }

        const l = meleeLevels(sdk);
        status.skills = {
            Attack: { level: l.Attack, xp: sdk.getSkillXp('Attack') ?? 0 },
            Strength: { level: l.Strength, xp: sdk.getSkillXp('Strength') ?? 0 },
            Defence: { level: l.Defence, xp: sdk.getSkillXp('Defence') ?? 0 },
            Hitpoints: { level: sdk.getSkill('Hitpoints')?.baseLevel ?? 1, xp: sdk.getSkillXp('Hitpoints') ?? 0 },
        };
        writeStatus(botName, status);
    }

    logEvent(botName, { task: 'combat', event: 'task_complete', levels: meleeLevels(sdk) });
}

if (import.meta.main) {
    const botName = process.argv[2];
    if (!botName) {
        console.error(
            'Usage: bun tasks/combat.ts <botname> [--target=30] [--site=lumbridge-cows] ' +
            '[--targets="cow"] [--spot=x,z] [--bankSpot=x,z] [--pickupDrops=false] ' +
            '[--buryBones] [--maxMs=600000]\n' +
            '  --target is optional - omit it to fight unbounded until --maxMs,\n' +
            '  regardless of level.\n' +
            `Known sites: ${COMBAT_SITES.map(s => s.name).join(', ')}`
        );
        process.exit(1);
    }
    const argVal = (flag: string) => process.argv.find(a => a.startsWith(flag))?.split('=')[1];

    const targetArg = argVal('--target=');
    const targetLevel = targetArg ? parseInt(targetArg, 10) : undefined;

    const parseCoords = (raw: string | undefined) => {
        if (!raw) return undefined;
        const [x, z] = raw.split(',').map(Number);
        return { x, z };
    };

    const siteArg = argVal('--site=');
    const site = siteArg ? findCombatSite(siteArg) : undefined;
    if (siteArg && !site) {
        console.error(`Unknown --site="${siteArg}". Known sites: ${COMBAT_SITES.map(s => s.name).join(', ')}`);
        process.exit(1);
    }
    const chosen = site ?? COMBAT_SITES[0]!; // default: Lumbridge goblins/spiders

    const targetsArg = argVal('--targets=');
    const targets = targetsArg ? new RegExp(targetsArg, 'i') : chosen.targets;
    const fallbackSpot = parseCoords(argVal('--spot=')) ?? chosen.spot;
    const bankSpot = parseCoords(argVal('--bankSpot=')) ?? chosen.bankSpot;
    const pickupDrops = argVal('--pickupDrops=') !== 'false';
    const buryBones = process.argv.includes('--buryBones');
    const maxMsArg = argVal('--maxMs=');
    const maxMs = maxMsArg ? parseInt(maxMsArg, 10) : undefined;

    await runScript(async ctx => {
        const label = targetLevel !== undefined ? `combat:${targetLevel}` : 'combat:unbounded';
        const status = newStatus(botName, [label]);
        status.currentTask = label;
        writeStatus(botName, status);
        logEvent(botName, { task: 'combat', event: 'site_chosen', site: chosen.name });
        await runCombatTask(ctx, botName, status, {
            targetLevel,
            targets,
            keepOnBank: [FOOD_PATTERN],
            fallbackSpot,
            bankSpot,
            pickupDrops,
            buryBones,
            maxMs,
        });
        status.currentTask = null;
        status.done = true;
        writeStatus(botName, status);
    }, { disconnectAfter: true, printState: false });
    // See tasks/woodcut.ts's matching comment / tasks/README.md "Lessons
    // learned" - a finished/errored run must release the control connection,
    // not hang forever holding it.
    process.exit();
}
