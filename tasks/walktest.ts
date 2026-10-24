// Fixed-plan orchestrator: runs a sequence of task scripts against one
// shared connection (no reconnect between steps) and keeps tasks/README.md's
// status.json up to date throughout. This is the "executor" tier - it never
// calls an LLM. Run it in the background and let a cheap checkup
// (tasks/checkup.ts) or bun sdk/cli.ts poll its status from the outside.
//
// Usage: bun tasks/plan.ts <botname>
//   (edit PLAN below to change the sequence/targets for this test run)

import { runScript } from '../sdk/runner';


await runScript(async ctx => {
  const { bot, sdk } = ctx;

  const state = sdk.getState();
  console.log(state?.player);

}, { disconnectAfter: true, printState: false });
// A finished/paused/errored plan must release the control connection, not
// hang forever holding it - see tasks/README.md "Lessons learned".
process.exit();
