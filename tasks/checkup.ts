// The "supervisor" tier's entire read path: a local file read, zero network,
// zero gateway connection, zero risk of preempting whatever task script
// currently controls the bot. Meant to be invoked often and cheaply - by a
// small/cheap model, a cron, or a human - without ever growing a context
// window, since its output is a few hundred bytes regardless of how long
// the plan has been running.
//
// Usage: bun tasks/checkup.ts <botname>

import { readStatus } from './lib/status';

const botName = process.argv[2];
if (!botName) {
    console.error('Usage: bun tasks/checkup.ts <botname>');
    process.exit(1);
}

const status = readStatus(botName);
if (!status) {
    console.log(JSON.stringify({ bot: botName, error: 'no status recorded yet - plan has not started or not written its first update' }));
    process.exit(0);
}

const ageMs = Date.now() - status.updatedAt;
// Any single task loop iteration should land well under a minute; no
// update in 2 minutes while the plan isn't done means something is stuck
// (not necessarily dead - could be a long bank walk - but worth a look).
const stale = !status.done && ageMs > 120_000;

console.log(JSON.stringify({
    bot: status.bot,
    currentTask: status.currentTask,
    planProgress: `${status.planIndex + 1}/${status.plan.length}`,
    plan: status.plan,
    skills: status.skills,
    actionsCompleted: status.actionsCompleted,
    bankTrips: status.bankTrips,
    lastAction: status.lastAction,
    lastError: status.lastError,
    needsAttention: status.needsAttention,
    done: status.done,
    statusAgeMs: ageMs,
    stale,
    history: status.history,
}, null, 2));
