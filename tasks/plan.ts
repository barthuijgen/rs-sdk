// Fixed-plan orchestrator: runs a sequence of task scripts against one
// shared connection (no reconnect between steps) and keeps tasks/README.md's
// status.json up to date throughout. This is the "executor" tier - it never
// calls an LLM. Run it in the background and let a cheap checkup
// (tasks/checkup.ts) or bun sdk/cli.ts poll its status from the outside.
//
// Usage: bun tasks/plan.ts <botname>
//   (edit PLAN below to change the sequence/targets for this test run)

import { runScript } from '../sdk/runner';
import { newStatus, writeStatus, logEvent } from './lib/status';
import { performBankTrip, DEFAULT_BANK_SPOT } from './lib/bank';
import { COMBAT_SITES, WOODCUTTING_SITES, bestWoodcuttingSiteForLevel, THIEVING_SITES, bestThievingSiteForLevel } from './lib/sites';
import { runCombatTask } from './combat';
import { runWoodcutTask } from './woodcut';
import { runThievingTask } from './thieving';
import { COOKED_FOOD_PATTERN as FOOD_PATTERN } from './lib/food';

const PLAN = [
    { name: 'combat', target: 30 },
    { name: 'woodcut', target: 30 },
    { name: 'thieving', target: 30 },
] as const;

const botName = process.argv[2];
if (!botName) {
    console.error('Usage: bun tasks/plan.ts <botname>');
    process.exit(1);
}

await runScript(async ctx => {
    const status = newStatus(botName, PLAN.map(p => `${p.name}:${p.target}`));
    writeStatus(botName, status);
    logEvent(botName, { event: 'plan_start', plan: status.plan });

    // Deposit unused starter/leftover gear (fishing net, pickaxe, dagger,
    // shortbow, runes, ...) once upfront rather than reacting once the
    // inventory happens to fill up mid-task. First real run paid for this
    // the hard way: thieving immediately needed a forced bank trip because
    // the inventory was already full of items none of these three tasks
    // use, costing ~2 minutes before any training XP at all - see
    // tasks/README.md "Lessons learned".
    status.lastAction = 'startup cleanup: banking unused gear';
    writeStatus(botName, status);
    const cleaned = await performBankTrip(ctx.bot, ctx.sdk, botName, DEFAULT_BANK_SPOT, [FOOD_PATTERN, /axe/i], undefined, msg => {
        logEvent(botName, { event: 'startup_cleanup', level: 'warn', msg });
    });
    if (cleaned) {
        status.bankTrips++;
        logEvent(botName, { event: 'startup_cleanup', result: 'ok' });
    } else {
        logEvent(botName, { event: 'startup_cleanup', result: 'skipped', reason: 'no bank reachable - continuing anyway' });
    }
    writeStatus(botName, status);

    for (let i = 0; i < PLAN.length; i++) {
        const step = PLAN[i];
        const label = `${step.name}:${step.target}`;

        status.planIndex = i;
        status.currentTask = label;
        status.taskStartedAt = Date.now();
        status.actionsCompleted = 0;
        status.lastError = null;
        status.needsAttention = false;
        writeStatus(botName, status);
        logEvent(botName, { event: 'task_start', task: label });

        const startedAt = Date.now();
        try {
            if (step.name === 'combat') {
                const site = COMBAT_SITES[0]!; // Lumbridge goblins/spiders
                await runCombatTask(ctx, botName, status, {
                    targetLevel: step.target,
                    targets: site.targets,
                    keepOnBank: [FOOD_PATTERN],
                    fallbackSpot: site.spot,
                    bankSpot: site.bankSpot,
                });
            } else if (step.name === 'woodcut') {
                const site = bestWoodcuttingSiteForLevel(ctx.sdk.getSkill('Woodcutting')?.baseLevel ?? 1) ?? WOODCUTTING_SITES[0]!;
                await runWoodcutTask(ctx, botName, status, {
                    targetLevel: step.target,
                    treePattern: site.treePattern,
                    keepOnBank: [FOOD_PATTERN, /axe/i],
                    fallbackSpot: site.spot,
                    bankSpot: site.bankSpot,
                });
            } else if (step.name === 'thieving') {
                const site = bestThievingSiteForLevel(ctx.sdk.getSkill('Thieving')?.baseLevel ?? 1) ?? THIEVING_SITES[0]!;
                await runThievingTask(ctx, botName, status, {
                    targetLevel: step.target,
                    npcPattern: site.npcPattern,
                    keepOnBank: [FOOD_PATTERN],
                    fallbackSpot: site.spot,
                    bankSpot: site.bankSpot,
                });
            }
        } catch (err) {
            status.lastError = String(err);
            status.needsAttention = true;
            writeStatus(botName, status);
            logEvent(botName, { event: 'task_error', task: label, error: String(err) });
            throw err; // stop the whole plan - this needs a human/planner look
        }

        // A task can also return early (needsAttention set, no throw) when
        // it hit something it couldn't resolve itself (e.g. bank unreachable,
        // critical HP with no food). Don't silently move on to the next skill.
        if (status.needsAttention) {
            logEvent(botName, { event: 'plan_paused', task: label, reason: status.lastError });
            writeStatus(botName, status);
            return;
        }

        status.history.push({
            task: label,
            result: 'complete',
            durationMs: Date.now() - startedAt,
            finishedAt: Date.now(),
        });
        logEvent(botName, { event: 'task_complete', task: label, durationMs: Date.now() - startedAt });
    }

    status.currentTask = null;
    status.done = true;
    writeStatus(botName, status);
    logEvent(botName, { event: 'plan_complete' });
}, { disconnectAfter: true, printState: false });
// A finished/paused/errored plan must release the control connection, not
// hang forever holding it - see tasks/README.md "Lessons learned".
process.exit();
