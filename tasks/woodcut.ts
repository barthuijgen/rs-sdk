// Woodcutting training: chop trees matching `treePattern` until Woodcutting
// reaches `targetLevel`. Banks logs (keeping the axe and food) when full.
//
// Which tree/spot/bank to use comes from tasks/lib/sites.ts's
// WOODCUTTING_SITES by default (auto-picks the highest-level site the bot
// already qualifies for).
//
// Standalone:  bun tasks/woodcut.ts <botname> [--target=30] [--site=varrock-oaks]
//              [--tree="oak"] [--spot=x,z] [--bankSpot=x,z]
// As a library: import { runWoodcutTask } from './woodcut' (see plan.ts).

import { runScript, type ScriptContext } from '../sdk/runner';
import { newStatus, writeStatus, logEvent, type TaskStatus } from './lib/status';
import { ensureBankSpace } from './lib/bank';
import { fastWalkTo } from './lib/fastWalk';
import { newFailureStreak, recordFailure, recordSuccess, newStaleStreak, checkClientHealth } from './lib/guard';
import { WOODCUTTING_SITES, findWoodcuttingSite, bestWoodcuttingSiteForLevel } from './lib/sites';
import { COOKED_FOOD_PATTERN as FOOD_PATTERN } from './lib/food';

export interface WoodcutTaskOptions {
    targetLevel: number;
    treePattern: RegExp;
    keepOnBank: RegExp[];
    fallbackSpot?: { x: number; z: number };
    /** Bank used for logs once the inventory fills. Defaults to Draynor
     * (tasks/lib/bank.ts's DEFAULT_BANK_SPOT) if omitted - pass the site's
     * bank explicitly when training somewhere else, e.g. Varrock West for
     * the oak site. */
    bankSpot?: { x: number; z: number };
    maxMs?: number;
}

export async function runWoodcutTask(
    ctx: ScriptContext,
    botName: string,
    status: TaskStatus,
    opts: WoodcutTaskOptions,
): Promise<void> {
    const { bot, sdk } = ctx;
    const deadline = Date.now() + (opts.maxMs ?? 60 * 60_000);
    let noTargetStreak = 0;
    let fallbackWalkFailStreak = 0;
    const errorStreak = newFailureStreak();
    const staleStreak = newStaleStreak();

    const level = () => sdk.getSkill('Woodcutting')?.baseLevel ?? 1;

    while (level() < opts.targetLevel && Date.now() < deadline) {
        status.iteration++;
        const state = sdk.getState();
        if (!state) {
            await sdk.waitForTicks(1);
            continue;
        }

        const health = await checkClientHealth(botName, status, 'woodcut', sdk, staleStreak);
        if (health === 'stop') return;
        if (health === 'skip') continue;

        // No explicit dialog dismiss here - every bot.* action below
        // auto-dismisses blocking UI before executing (see CLAUDE.md); a
        // separate step here just pays for a redundant second dismiss
        // cycle. See tasks/README.md "Lessons learned".

        const okToContinue = await ensureBankSpace(bot, sdk, botName, status, {
            keep: opts.keepOnBank,
            taskLabel: 'woodcut',
            bankSpot: opts.bankSpot,
        });
        if (!okToContinue) return;
        if (sdk.getInventory().length >= 28) continue;

        const tree = sdk.findNearbyLoc(opts.treePattern, { reachable: true });
        if (!tree) {
            noTargetStreak++;
            status.lastAction = `no reachable tree nearby (${noTargetStreak})`;
            writeStatus(botName, status);
            if (opts.fallbackSpot && noTargetStreak === 5) {
                status.lastAction = `no trees nearby, walking to fallback spot (${opts.fallbackSpot.x}, ${opts.fallbackSpot.z})`;
                writeStatus(botName, status);
                logEvent(botName, { task: 'woodcut', event: 'walk_to_fallback', spot: opts.fallbackSpot });
                // Checked, not swallowed - see tasks/README.md "Lessons
                // learned" (fastWalkTo resolves success:false rather than
                // throwing when it genuinely can't get there, e.g. a closed
                // door mid-route; a bare .catch() never sees that).
                const walked = await fastWalkTo(bot, sdk, opts.fallbackSpot.x, opts.fallbackSpot.z, {
                    onProgress: msg => logEvent(botName, { task: 'woodcut', event: 'walk_progress', msg }),
                }).catch(err => ({ success: false, message: String(err) }));
                if (walked.success) {
                    fallbackWalkFailStreak = 0;
                } else {
                    fallbackWalkFailStreak++;
                    status.lastAction = `walk to fallback failed (${fallbackWalkFailStreak}): ${walked.message}`;
                    writeStatus(botName, status);
                    logEvent(botName, { task: 'woodcut', level: 'warn', msg: `walk to fallback failed: ${walked.message}` });
                    if (fallbackWalkFailStreak >= 10) {
                        status.needsAttention = true;
                        status.lastError = `Could not reach the fallback spot after ${fallbackWalkFailStreak} attempts: ${walked.message}`;
                        writeStatus(botName, status);
                        logEvent(botName, { task: 'woodcut', level: 'error', msg: 'fallback_walk_unreachable' });
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
            const result = await bot.chopTree(tree);
            recordSuccess(errorStreak);
            if (result.success) {
                status.actionsCompleted++;
                status.lastAction = `chopped tree #${status.actionsCompleted}`;
                logEvent(botName, { task: 'woodcut', event: 'chop', count: status.actionsCompleted });
            } else {
                status.lastAction = `chop failed: ${result.message}`;
                logEvent(botName, { task: 'woodcut', level: 'warn', msg: result.message });
            }
        } catch (err) {
            const canContinue = await recordFailure(botName, status, 'woodcut', err, errorStreak);
            if (!canContinue) return;
            continue;
        }

        status.skills = { Woodcutting: { level: level(), xp: sdk.getSkillXp('Woodcutting') ?? 0 } };
        writeStatus(botName, status);
    }

    logEvent(botName, { task: 'woodcut', event: 'task_complete', skillLevel: level() });
}

if (import.meta.main) {
    const botName = process.argv[2];
    if (!botName) {
        console.error(
            'Usage: bun tasks/woodcut.ts <botname> [--target=30] [--site=varrock-oaks] ' +
            '[--tree="oak"] [--spot=x,z] [--bankSpot=x,z]\n' +
            `Known sites: ${WOODCUTTING_SITES.map(s => s.name).join(', ')}`
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
    const site = siteArg ? findWoodcuttingSite(siteArg) : undefined;
    if (siteArg && !site) {
        console.error(`Unknown --site="${siteArg}". Known sites: ${WOODCUTTING_SITES.map(s => s.name).join(', ')}`);
        process.exit(1);
    }

    await runScript(async ctx => {
        const chosen = site ?? bestWoodcuttingSiteForLevel(ctx.sdk.getSkill('Woodcutting')?.baseLevel ?? 1) ?? WOODCUTTING_SITES[0]!;

        const treeArg = argVal('--tree=');
        const treePattern = treeArg ? new RegExp(treeArg, 'i') : chosen.treePattern;
        const fallbackSpot = parseCoords(argVal('--spot=')) ?? chosen.spot;
        const bankSpot = parseCoords(argVal('--bankSpot=')) ?? chosen.bankSpot;

        const label = `woodcut:${targetLevel}`;
        const status = newStatus(botName, [label]);
        status.currentTask = label;
        writeStatus(botName, status);
        logEvent(botName, { task: 'woodcut', event: 'site_chosen', site: chosen.name });
        await runWoodcutTask(ctx, botName, status, {
            targetLevel,
            treePattern,
            keepOnBank: [FOOD_PATTERN, /axe/i],
            fallbackSpot,
            bankSpot,
        });
        status.currentTask = null;
        status.done = true;
        writeStatus(botName, status);
    }, { disconnectAfter: true, printState: false });
    // A finished/errored run must actually release the control connection,
    // not sit there as a zombie process holding it - runScript documents
    // that a one-shot CLI caller needs to exit itself (its own handles, like
    // the SDK's reconnect timers, otherwise keep the event loop alive
    // forever). See tasks/README.md "Lessons learned".
    process.exit();
}
