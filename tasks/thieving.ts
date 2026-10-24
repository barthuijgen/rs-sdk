// Thieving training: pickpocket NPCs matching `npcPattern` until Thieving
// reaches `targetLevel`. Banks loot (keeping food) when full, and guards
// HP: a failed pickpocket on higher-level NPCs (Warriors and up) can deal
// real damage, not just stun - see tasks/lib/health.ts for the eat ->
// bank -> pause-for-natural-regen escalation.
//
// Which NPC/spot/bank to use comes from tasks/lib/sites.ts's THIEVING_SITES
// by default (auto-picks the highest-level site the bot already qualifies
// for) - no coordinates need to be passed on the command line for a known
// site.
//
// Standalone:  bun tasks/thieving.ts <botname> [--target=30] [--site=varrock-warrior]
//              [--npc="warrior"] [--spot=x,z] [--bankSpot=x,z] [--embedded]
//   (--npc/--spot/--bankSpot override a site's fields individually; only
//   needed for a location not in that table yet)
// As a library: import { runThievingTask } from './thieving' (see plan.ts).

import { runScript, type ScriptContext } from '../sdk/runner';
import { newStatus, writeStatus, logEvent, type TaskStatus } from './lib/status';
import { ensureBankSpace } from './lib/bank';
import { fastWalkTo } from './lib/fastWalk';
import { newFailureStreak, recordFailure, recordSuccess, newStaleStreak, checkClientHealth } from './lib/guard';
import { ensureHealthy } from './lib/health';
import { THIEVING_SITES, findThievingSite, bestThievingSiteForLevel } from './lib/sites';
import { DEFAULT_BANK_SPOT } from './lib/bank';
import { COOKED_FOOD_PATTERN as FOOD_PATTERN } from './lib/food';

export interface ThievingTaskOptions {
    /** Omit to ignore level entirely and run until `maxMs` - e.g. a level
     * 99 (max) bot pickpocketing for gp/loot, not xp, which a required
     * target made impossible (level() < targetLevel is false before the
     * loop even starts). */
    targetLevel?: number;
    npcPattern: RegExp;
    keepOnBank: RegExp[];
    /** Where to return to when no reachable target has turned up for a
     * while - the known spawn point this task was set up for. */
    fallbackSpot?: { x: number; z: number };
    /** Bank used both for depositing loot and restocking food when a
     * failed pickpocket draws HP down and none is carried. */
    bankSpot?: { x: number; z: number };
    maxMs?: number;
}

export async function runThievingTask(
    ctx: ScriptContext,
    botName: string,
    status: TaskStatus,
    opts: ThievingTaskOptions,
): Promise<void> {
    const { bot, sdk } = ctx;
    const deadline = Date.now() + (opts.maxMs ?? 60 * 60_000);
    const bankSpot = opts.bankSpot ?? DEFAULT_BANK_SPOT;
    let noTargetStreak = 0;
    let fallbackWalkFailStreak = 0;
    const errorStreak = newFailureStreak();
    const staleStreak = newStaleStreak();

    const level = () => sdk.getSkill('Thieving')?.baseLevel ?? 1;

    while ((opts.targetLevel === undefined || level() < opts.targetLevel) && Date.now() < deadline) {
        status.iteration++;
        const state = sdk.getState();
        if (!state) {
            await sdk.waitForTicks(1);
            continue;
        }

        const health = await checkClientHealth(botName, status, 'thieving', sdk, staleStreak);
        if (health === 'stop') return;
        if (health === 'skip') continue;

        // No explicit dialog dismiss here - every bot.* action below
        // auto-dismisses blocking UI before executing (see CLAUDE.md); a
        // separate step here just pays for a redundant second dismiss
        // cycle. See tasks/README.md "Lessons learned".

        // HP before anything else - a failed pickpocket on a Warrior-tier
        // NPC can deal real damage, not just stun.
        const healthy = await ensureHealthy(bot, sdk, botName, status, {
            foodPattern: FOOD_PATTERN,
            bankSpot,
            taskLabel: 'thieving',
        });
        if (healthy === 'stop') return;
        if (healthy === 'handled') continue;

        const okToContinue = await ensureBankSpace(bot, sdk, botName, status, {
            keep: opts.keepOnBank,
            taskLabel: 'thieving',
            bankSpot,
        });
        if (!okToContinue) return;
        if (sdk.getInventory().length >= 28) continue;

        const target = sdk.findNearbyNpc(opts.npcPattern, { reachable: true });
        if (!target) {
            noTargetStreak++;
            status.lastAction = `no target nearby (${noTargetStreak})`;
            writeStatus(botName, status);
            if (opts.fallbackSpot && noTargetStreak === 5) {
                status.lastAction = `no targets nearby, walking to fallback spot (${opts.fallbackSpot.x}, ${opts.fallbackSpot.z})`;
                writeStatus(botName, status);
                logEvent(botName, { task: 'thieving', event: 'walk_to_fallback', spot: opts.fallbackSpot });
                // Checked, not swallowed - see tasks/README.md "Lessons
                // learned" (fastWalkTo resolves success:false rather than
                // throwing when it genuinely can't get there, e.g. a closed
                // door mid-route; a bare .catch() never sees that).
                const walked = await fastWalkTo(bot, sdk, opts.fallbackSpot.x, opts.fallbackSpot.z, {
                    onProgress: msg => logEvent(botName, { task: 'thieving', event: 'walk_progress', msg }),
                }).catch(err => ({ success: false, message: String(err) }));
                if (walked.success) {
                    fallbackWalkFailStreak = 0;
                } else {
                    fallbackWalkFailStreak++;
                    status.lastAction = `walk to fallback failed (${fallbackWalkFailStreak}): ${walked.message}`;
                    writeStatus(botName, status);
                    logEvent(botName, { task: 'thieving', level: 'warn', msg: `walk to fallback failed: ${walked.message}` });
                    if (fallbackWalkFailStreak >= 10) {
                        status.needsAttention = true;
                        status.lastError = `Could not reach the fallback spot after ${fallbackWalkFailStreak} attempts: ${walked.message}`;
                        writeStatus(botName, status);
                        logEvent(botName, { task: 'thieving', level: 'error', msg: 'fallback_walk_unreachable' });
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
            const result = await bot.pickpocketNpc(target);
            recordSuccess(errorStreak);
            if (result.success) {
                status.actionsCompleted++;
                status.lastAction = `pickpocketed #${status.actionsCompleted} (+${result.xpGained ?? 0}xp)`;
                logEvent(botName, {
                    task: 'thieving',
                    event: 'pickpocket',
                    count: status.actionsCompleted,
                    xp: result.xpGained,
                });
            } else {
                status.lastAction = `pickpocket failed: ${result.reason ?? result.message}`;
                logEvent(botName, { task: 'thieving', level: 'warn', msg: result.message, reason: result.reason });
                if (result.reason === 'stunned') {
                    await sdk.waitForTicks(3); // let the stun clear before trying again
                }
            }
        } catch (err) {
            const canContinue = await recordFailure(botName, status, 'thieving', err, errorStreak);
            if (!canContinue) return;
            continue;
        }

        status.skills = { Thieving: { level: level(), xp: sdk.getSkillXp('Thieving') ?? 0 } };
        writeStatus(botName, status);
    }

    logEvent(botName, { task: 'thieving', event: 'task_complete', skillLevel: level() });
}

if (import.meta.main) {
    const botName = process.argv[2];
    if (!botName) {
        console.error(
            'Usage: bun tasks/thieving.ts <botname> [--target=30] [--site=varrock-warrior] ' +
            '[--npc="warrior"] [--spot=x,z] [--bankSpot=x,z] [--maxMs=3600000] [--embedded]\n' +
            '  --target is optional - omit it to pickpocket for gp/loot until --maxMs\n' +
            '  regardless of level (e.g. an already-level-99 bot, for which any target\n' +
            '  is already met before the first pickpocket).\n' +
            `Known sites: ${THIEVING_SITES.map(s => s.name).join(', ')}`
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
    const site = siteArg ? findThievingSite(siteArg) : undefined;
    if (siteArg && !site) {
        console.error(`Unknown --site="${siteArg}". Known sites: ${THIEVING_SITES.map(s => s.name).join(', ')}`);
        process.exit(1);
    }

    const runTask = async (ctx: { bot: import('../sdk/actions').BotActions; sdk: any }) => {
        // No site named explicitly: pick the highest-level one the bot's
        // current Thieving level already qualifies for, so a fresh
        // character lands on man/woman and a trained one on warriors
        // without anyone having to pass coordinates.
        const chosen = site ?? bestThievingSiteForLevel(ctx.sdk.getSkill('Thieving')?.baseLevel ?? 1) ?? THIEVING_SITES[0]!;

        const npcArg = argVal('--npc=');
        const npcPattern = npcArg ? new RegExp(npcArg, 'i') : chosen.npcPattern;
        const fallbackSpot = parseCoords(argVal('--spot=')) ?? chosen.spot;
        const bankSpot = parseCoords(argVal('--bankSpot=')) ?? chosen.bankSpot;
        const maxArg = argVal('--maxMs=');

        const label = targetLevel !== undefined ? `thieving:${targetLevel}` : 'thieving:unbounded';
        const status = newStatus(botName, [label]);
        status.currentTask = label;
        writeStatus(botName, status);
        logEvent(botName, { task: 'thieving', event: 'site_chosen', site: chosen.name });
        await runThievingTask(ctx, botName, status, {
            targetLevel,
            npcPattern,
            keepOnBank: [FOOD_PATTERN],
            fallbackSpot,
            bankSpot,
            maxMs: maxArg ? parseInt(maxArg, 10) : undefined,
        });
        status.currentTask = null;
        status.done = true;
        writeStatus(botName, status);
    };

    const embedded = process.argv.includes('--embedded');

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
