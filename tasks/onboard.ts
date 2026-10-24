// Gets a freshly created character out of the tutorial and into the main
// world: accepts the character-design dialog, talks to the RuneScape
// Guide, and clicks through to the "skip tutorial" option. All three steps
// are already implemented by bot.skipTutorial() (sdk/actions.ts) - this is
// just the status-tracked, queueable task wrapper around it, per CLAUDE.md
// "Session Workflow"'s "Tutorial Check".
//
// Idempotent: if the character isn't in the tutorial anymore (no tutorial
// NPC nearby), this is a no-op success rather than an error - safe to queue
// on every newly created bot without first checking where it is.
//
// Standalone: bun tasks/onboard.ts <botname> [--embedded]
// As a library: import { runOnboardTask } from './onboard'.

import { runScript, type ScriptContext } from '../sdk/runner';
import { newStatus, writeStatus, logEvent, type TaskStatus } from './lib/status';

export async function runOnboardTask(ctx: ScriptContext, botName: string, status: TaskStatus): Promise<void> {
    const { bot } = ctx;

    status.lastAction = 'accepting character design and skipping tutorial';
    writeStatus(botName, status);

    const result = await bot.skipTutorial();

    if (result.success) {
        status.actionsCompleted++;
        status.lastAction = `tutorial skipped: ${result.message}`;
        logEvent(botName, { task: 'onboard', event: 'tutorial_skipped', msg: result.message });
    } else if (result.message === 'No tutorial NPC found') {
        // skipTutorial()'s own signal for "nothing to do here" - already past
        // the tutorial island, not a failure.
        status.lastAction = 'already past the tutorial - nothing to do';
        logEvent(botName, { task: 'onboard', event: 'already_done', msg: result.message });
    } else {
        status.needsAttention = true;
        status.lastError = `Could not skip tutorial: ${result.message}`;
        logEvent(botName, { task: 'onboard', level: 'error', msg: result.message });
    }

    writeStatus(botName, status);
}

if (import.meta.main) {
    const botName = process.argv[2];
    if (!botName) {
        console.error('Usage: bun tasks/onboard.ts <botname> [--embedded]');
        process.exit(1);
    }
    const embedded = process.argv.includes('--embedded');

    const runTask = async (ctx: { bot: import('../sdk/actions').BotActions; sdk: any }) => {
        const label = 'onboard';
        const status = newStatus(botName, [label]);
        status.currentTask = label;
        writeStatus(botName, status);
        await runOnboardTask(ctx as ScriptContext, botName, status);
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
