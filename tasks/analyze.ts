// Turns the bot's event history into a timing/efficiency report, so "what
// took the most time" and "did it get stuck on anything" have a real answer
// instead of manual jq archaeology on a raw event stream. Read-only, no
// connection.
//
// Usage: bun tasks/analyze.ts <botname>

import { readEvents } from './lib/status';

const botName = process.argv[2];
if (!botName) {
    console.error('Usage: bun tasks/analyze.ts <botname>');
    process.exit(1);
}

interface Event {
    ts: number;
    event?: string;
    task?: string;
    level?: string;
    msg?: string;
    durationMs?: number;
    reason?: string;
    [key: string]: unknown;
}

const events = readEvents(botName) as Event[];
if (events.length === 0) {
    console.error(`No events logged yet for "${botName}"`);
    process.exit(1);
}

const SUCCESS_EVENTS = new Set(['chop', 'kill', 'pickpocket']);
const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// Group events into task "runs": a (task label, start timestamp) span,
// bounded by that task's own task_start...task_complete/plan_paused. Plans
// restart from scratch, so the same task label can appear more than once -
// each occurrence is analyzed separately, not merged.
interface TaskRun {
    task: string;
    startTs: number;
    endTs: number | null;
    durationMs: number | null;
    completed: boolean;
    successes: { ts: number; kind: string }[];
    failures: { ts: number; msg: string; level: string }[];
}

const runs: TaskRun[] = [];
let current: TaskRun | null = null;

// task_start/task_complete/plan_paused carry the full label plan.ts uses
// ("thieving:30"); per-action events inside each task script log just the
// short name ("thieving") via their own logEvent() calls. Match on that
// short prefix rather than exact equality.
const shortName = (label: string) => label.split(':')[0];

for (const e of events) {
    if (e.event === 'task_start' && e.task) {
        current = { task: e.task, startTs: e.ts, endTs: null, durationMs: null, completed: false, successes: [], failures: [] };
        runs.push(current);
        continue;
    }
    if (!current) continue;
    const currentShort = shortName(current.task);

    if (e.event === 'task_complete' && e.task === current.task) {
        current.endTs = e.ts;
        current.durationMs = e.durationMs ?? e.ts - current.startTs;
        current.completed = true;
        current = null;
        continue;
    }
    if (e.event === 'plan_paused' && e.task === current.task) {
        current.endTs = e.ts;
        current.durationMs = e.ts - current.startTs;
        current.completed = false;
        current = null;
        continue;
    }
    if (e.task === currentShort && e.event && SUCCESS_EVENTS.has(e.event)) {
        current.successes.push({ ts: e.ts, kind: e.event });
    }
    // `level` is overloaded: a log severity ('warn'/'error') almost
    // everywhere, but woodcut.ts's task_complete event uses the same key
    // for the skill level reached (a number). Only the string form means
    // "this is a failure entry."
    if (e.task === currentShort && (e.level === 'warn' || e.level === 'error')) {
        current.failures.push({ ts: e.ts, msg: e.msg ?? '', level: e.level });
    }
}
// A still-running task (no task_complete/plan_paused yet) stays in `runs`
// with durationMs: null - reported as "still running" below.

console.log(`\n=== Task timing report for "${botName}" (${runs.length} task run${runs.length === 1 ? '' : 's'}) ===\n`);

for (const run of runs) {
    const label = run.completed ? 'complete' : run.endTs ? 'paused/stopped' : 'still running';
    const duration = run.durationMs !== null ? fmt(run.durationMs) : `${fmt(Date.now() - run.startTs)} so far`;
    console.log(`--- ${run.task}  [${label}, ${duration}] ---`);

    if (run.successes.length === 0 && run.failures.length === 0) {
        console.log('  (no actions recorded)\n');
        continue;
    }

    const timeToFirst = run.successes[0] ? run.successes[0].ts - run.startTs : null;
    if (timeToFirst !== null) console.log(`  time to first action: ${fmt(timeToFirst)}`);
    console.log(`  successful actions: ${run.successes.length}`);
    console.log(`  failures/warnings logged: ${run.failures.length}`);

    // Gaps between consecutive successes - the signal for "stuck" that a
    // bare event log doesn't surface: a long gap means something (a stun,
    // a search, a retry) happened in between that we may not have logged.
    if (run.successes.length > 1) {
        const gaps = run.successes.slice(1).map((s, i) => s.ts - run.successes[i].ts);
        const total = gaps.reduce((a, b) => a + b, 0);
        const avg = total / gaps.length;
        const maxGap = Math.max(...gaps);
        const maxGapIdx = gaps.indexOf(maxGap);
        console.log(`  avg gap between actions: ${fmt(avg)}  (median-ish: ${fmt([...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)])})`);
        console.log(`  largest gap: ${fmt(maxGap)} (before action #${maxGapIdx + 2}) - investigate if much bigger than the average`);
    }

    if (run.failures.length > 0) {
        const byMsg = new Map<string, number>();
        for (const f of run.failures) {
            const key = f.msg.slice(0, 80);
            byMsg.set(key, (byMsg.get(key) ?? 0) + 1);
        }
        console.log('  failure reasons:');
        for (const [msg, count] of [...byMsg.entries()].sort((a, b) => b[1] - a[1])) {
            console.log(`    ${count}x  ${msg}`);
        }
    }

    // Overhead estimate: time before the first success, plus time after the
    // last success until the task ended, counts as travel/search/banking
    // rather than training - this is what answered "41% overhead" for the
    // first real plan.ts run.
    if (run.durationMs !== null && run.successes.length > 0) {
        const lastSuccess = run.successes[run.successes.length - 1].ts;
        const tail = run.endTs! - lastSuccess;
        const head = timeToFirst ?? 0;
        const overhead = head + tail;
        const pct = ((overhead / run.durationMs) * 100).toFixed(0);
        console.log(`  overhead (before first + after last action): ${fmt(overhead)} (${pct}% of task duration)`);
    }
    console.log('');
}
