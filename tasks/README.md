# Task System

Keeps an LLM out of the per-tick loop for long training runs, so grinding a
skill for hours doesn't grow anyone's context window. Three tiers:

```
Planner (capable model, rare)   -> decides WHAT to do next
Supervisor (cheap model, often) -> reads status (checkup.ts), decides if it needs to intervene
Executor (plain bun process)    -> DOES it; never talks to a model
```

**Before writing or changing a task**, check `learnings/*.md` and
`wiki/skills/*.md` (plus `wiki/npcs`, `wiki/items`, `wiki/shops` as needed) -
locations, level requirements, item/NPC names and known gotchas belong there,
not rediscovered per script. `tasks/lib/sites.ts` is where that knowledge
gets turned into code (see "Known locations" below).

## Why a real browser, not the lite runner

`sdk/index.ts`'s `launchBrowser()` opens a real, visible browser tab - that
tab *is* the game session, exactly like the headless lite runner is. Only one
game client per bot, so to watch progress, open the browser once (MCP
`execute_code` does this automatically, or visit the bot's URL yourself) and
leave it open; don't also run the lite runner for that bot.

Task scripts connect as a normal controlling SDK client (`control` mode, the
default) and drive that already-open browser. **Never call MCP's
`execute_code` while a task script owns the bot** - a new controller preempts
(kills) the old one (`sdk/index.ts:2041`). Use the observe-mode reads below
instead.

## Known locations: `tasks/lib/sites.ts`

Per-skill tables of `{ name, spot, bankSpot, levelReq, ... }` so a task never
needs `--bankSpot`/`--rockSpot`-style coordinates passed on the command line
for a location that's already known - `mining.ts --ore="iron ore"` and
`thieving.ts --site=varrock-warrior` look up where to stand and which bank to
use themselves. Pass the coordinate flags only to override a site's fields,
or to use a spot that isn't in the table yet.

Add a new location by appending a row (cite the `learnings/`/`wiki/` source
or "confirmed live"), not by inventing a new CLI flag.

Some sites need a tool (and sometimes a consumable like bait/feathers) the
task doesn't produce itself - `tasks/lib/shop.ts`'s `ensureGear()` is the
`ensureBankSpace`-equivalent for that: buys what's short from a known shop
before acting. `fishing.ts` uses it since different fish need different
gear (small net vs. rod+bait vs. fly rod+feathers).

## Embedded engine: skip the gateway entirely (fast, no visual)

The gateway relay (browser/lite client <-> `server/gateway/gateway.ts` <->
SDK) can itself become the bottleneck under load - measured live: 30s
`mineRock` timeouts and 9-10s just to reach the gateway's HTTP endpoint,
while the browser's own game connection (separate from the gateway) stayed
smooth. See `sdk/bug-report.ts` report `mvi9ifvr-18921f6c`.

`tasks/lib/embeddedRunner.ts` bypasses the gateway: it logs directly into the
game engine via the lite client's plumbing (`server/webclient/src/lite/
embedded.ts` + `localBotSDK.ts`) and drives the same unmodified `BotActions`/
`BotSDK` porcelain against that direct connection. Measured: a `mineRock`
call that took 10-30s+ through the gateway completed in **19ms** embedded.

```bash
bun tasks/mining.ts barry --ore="iron ore" --disposal=bank --embedded
```

**Tradeoff**: this process *is* the game client while it runs - same
one-client-per-account rule as the browser, and there's no rendering to
watch. `tasks/lib/worldView.ts` writes a crude text snapshot to
`bots/{name}/view.txt` every second instead (`@` you, `n`/`!` npcs, `P`
players, `R`/`T` rocks/trees, plus HP/inventory/recent messages).

This needed `sdk/index.ts`'s `sendAction`/`handleMessage` changed from
`private` to `protected` so `LocalBotSDK extends BotSDK` can hook in without
duplicating any dispatch/parsing logic. Nothing existing is affected.

Use the gateway path (no `--embedded`) to watch a real browser; use
`--embedded` for throughput, or when the gateway is degraded.

## Running it

```bash
bun tasks/combat.ts barry --target=30
bun tasks/woodcut.ts barry --target=30
bun tasks/thieving.ts barry --target=30
bun tasks/mining.ts barry --ore="iron ore" --disposal=bank
bun tasks/fishing.ts barry --target=30
bun tasks/cooking.ts barry
bun tasks/mining.ts barry --ore="copper ore" --targetQuantity=100 --disposal=bank
bun tasks/smithing.ts barry --bar=bronze --target=100

# Or the fixed sequence (combat -> woodcut -> thieving, edit PLAN in plan.ts
# to change it), backgrounded so it survives independently of any one
# conversation:
nohup bun tasks/plan.ts barry > bots/barry/plan.out.log 2>&1 &
```

Each run writes its status (overwritten every loop iteration - current task,
skill levels/xp, last action, bank trip count, `needsAttention`) and appends
notable events (kills, chops, pickpockets, bank trips, errors) - both now
live in the shared SQLite DB (`db/`, see `manager/README.md`) via
`tasks/lib/status.ts`'s `writeStatus`/`logEvent`, not `bots/{name}/status.json`/
`run.log.jsonl` files. Nothing about calling `writeStatus`/`logEvent` changed -
only where they persist to.

## Money loop: fishing -> cooking -> thieving, zero gp spent

Pickpocketing costs HP on a miss, which costs food, which costs gp if bought
- not great before there's any income. The fix is to produce the food
instead of buying it, and to never buy anything mid-loop either:

- `fishing.ts`'s catch selection (`bestFishCatchForLevel`/
  `bestFishingSiteForLevel` in `tasks/lib/sites.ts`) now prefers a
  bait/feather-free catch (net/harpoon/cage tool only, bought once) over a
  higher-level one that needs a bought consumable per catch - even if the
  bait-needing catch trains faster. Right now that always resolves to
  Draynor's shrimp/anchovies, since lobster/shark (also resource-free, see
  wiki/skills/fishing.md) don't have a sourced site location yet - a good
  follow-up once one's found.
- `cooking.ts` turns whatever raw fish that caught into real food and banks
  it, so it's sitting in the shared bank for...
- `thieving.ts`'s `ensureHealthy()` (`tasks/lib/health.ts`) to eat/withdraw
  from, instead of ever needing a shop.

This only works because `tasks/lib/food.ts`'s `COOKED_FOOD_PATTERN` (used by
every task's food-eating/keep-on-bank logic) now actually recognizes the
fish `cooking.ts` produces - the old per-script `/shrimp|bread|lobster|
cake|cooked/i` copy didn't match "Anchovies" at all, and incorrectly matched
"Raw lobster"/"Burnt lobster" as if they were edible.

**Chaining the three steps is deliberately not coded as one script.** Each
one already stops cleanly on its own (empty inventory+bank for fishing/
cooking, `needsAttention` for thieving) and exits the process (see "Lessons
learned" #8) - so kick off the next step when `tasks/checkup.ts barry`
reports `done: true`, whether that's a human watching, a `/loop` wakeup, or
an agent spawned to wait on one run and launch the next. Don't build a
fixed-sequence orchestrator for this the way `plan.ts` is one for
combat/woodcut/thieving - the whole point here is that switching is a
runtime decision (how much food is banked? is thieving flagging
`needsAttention` yet?), not a fixed loop count.

## Checking on it (the supervisor's whole job)

```bash
bun tasks/checkup.ts barry
```

Pure local file read - no gateway connection, so it can't preempt the
running task and costs nothing. Output: current task, skill snapshot, last
action/error, `needsAttention`, and whether the file has gone stale (no
update in 2 minutes while not done).

For a live game-state read instead of what the task last wrote, `bun
sdk/cli.ts barry --json` connects in `observe` mode, so it can't preempt a
controller (`sdk/cli.ts:221-224`).

A small/cheap model (or a `/loop` wakeup) should poll `checkup.ts` on a timer
and act on `needsAttention`/`stale` - most ticks are a no-op.

## Analyzing a finished (or still-running) run

```bash
bun tasks/analyze.ts barry
```

Turns the bot's logged events into a timing report per task: time to first action,
average/largest gap between successful actions, and failure counts by
reason. A large gap with no matching failure entry right before it means
something happened that isn't logged yet - add a `logEvent()` call there,
don't just shrug at it.

## HP/food guard: `tasks/lib/health.ts`

`ensureHealthy()` is for any task whose actions can cost HP, not just whiff
(thieving Warriors and up deal real damage on a failed pickpocket). Order:
eat from inventory -> walk to a bank and withdraw more -> if the bank has
none either, wait for natural regen instead of flagging an error - running
out of food everywhere isn't a bug.

## Testing/diagnosing the walk logic

Don't tune `tasks/lib/fastWalk.ts` from a single live anecdote - a report like
"it took a weird detour" from watching the browser is real, but it isn't
reproducible evidence, and reactive one-off patches based on it stack up fast
without actually converging. Two complementary tools instead:

1. **Benchmark real routes, both strategies, several times.** A short
   throwaway script (`runScript` callback) that, for each `{from, to}`
   pair: `bot.walkTo` to `from` to reset, then time+measure `bot.walkTo(to)`
   directly vs `fastWalkTo(bot, sdk, to)`, logging success, wall-clock ms,
   and a path-efficiency ratio (sum of per-poll tile deltas / straight-line
   distance - close to 1.0 means no real backtracking). Run each route
   several times, not once; a single run proves nothing about an
   intermittent issue either way. This is what caught `fastWalkTo` being
   both faster *and* no less reliable than plain `bot.walkTo` even on a fast
   local gateway (so the per-waypoint cost isn't purely network-latency
   bound - something tick-rate-bound too), and is also what caught
   `chunkedWalkTo`'s `HOP_TILES` needing to be small enough to actually
   land near a door for `bot.walkTo`'s own door-retry to trigger (see
   "Lessons learned" #12) rather than overshoot it.
2. **Log every leg/hop, not just failures, for after-the-fact diagnosis.**
   Every `fastWalkTo` call from `tasks/lib/health.ts`, `tasks/lib/bank.ts`,
   and each task's own fallback-spot walk now passes `onProgress` wired to
   `logEvent(botName, { task, event: 'walk_progress', msg })` - deliberately
   *not* through the `level: 'warn'` sink used for actual failures, since
   routine progress isn't a warning and would otherwise flood the log and
   confuse `analyze.ts`'s failure counting. A jank report can now be
   checked against `run.log.jsonl`'s `walk_progress` events after the fact,
   without needing someone watching the browser at the exact moment it
   happens.

## Lessons learned (apply these to any new task)

1. Bound every wait inside a loop iteration (e.g. `combat.ts`'s 12-step
   polling attack loop) - an unbounded wait can blow through the task's own
   deadline before the outer loop ever re-checks it.
2. Route every action's `catch` through `tasks/lib/guard.ts`'s
   `recordFailure`/`recordSuccess`. A disconnected client throws instantly
   on every call, so a bare log-and-continue retries at zero cost and floods
   the log forever.
3. Call `checkClientHealth` every iteration, right after `sdk.getState()`. A
   dead client doesn't always throw - `cant_reach`/stale-state failures are
   graceful `result.success: false`, indistinguishable from an ordinary miss.
4. `bot.openBank()` only searches the currently loaded scene - it does
   **not** pathfind to a bank it merely knows the location of.
   `ensureBankSpace` walks there first.
5. Never add a top-level `if (dialog.isOpen) { dismiss; continue }` before an
   action. Every `bot.*` action already calls `dismissBlockingUI()` itself
   (see CLAUDE.md) - a separate check pays for the dismiss twice (measured
   6.8s per level-up under load). Combat's *inner* dismiss inside the
   attack-wait poll is different and stays - it unblocks a stuck wait
   mid-fight, not a pre-action check.
6. Use `tasks/lib/fastWalk.ts`'s `fastWalkTo`, never `bot.walkTo` directly,
   for any walk whose distance isn't known to be short (fallback spots, bank
   trips). `bot.walkTo` re-dispatches a packet per waypoint
   (~1/tile) with a full wait after each; `fastWalkTo` sends one click per
   ~80-tile leg and polls instead, then hands off to `bot.walkTo` for the
   final ~20 tiles where its door-handling matters. A 44-tile walk dropped
   from minutes to 11s. It's a safe drop-in: short distances fall straight
   through to `bot.walkTo` anyway.
7. In embedded mode, wait for a real skills/HP snapshot after
   `waitForReady()`, not just its own position/inGame check - skills/HP can
   still read as zero on the very first ready tick.
8. Every `import.meta.main` CLI block must call `process.exit()` after its
   `runScript`/`runEmbedded` call returns, and should pass
   `disconnectAfter: true`. A finished (or errored, or paused-on-
   `needsAttention`) run that doesn't disconnect+exit just sits there holding
   the control connection forever - `runScript` only disconnects on request
   and never schedules its own process exit (by design, so `plan.ts` can
   chain tasks on one connection). Confirmed live: a completed run was still
   alive 2+ minutes later, and a second accidental launch of the same script
   had to preempt it to get control back at all.
9. Buying anything (`tasks/lib/shop.ts`'s `ensureGear`) needs coins on hand,
   which a fresh or looted-out character may not have. Withdraw from a bank
   first when short, rather than discovering it empty-handed at the shop -
   confirmed live: a bot reached Gerrant's Fishy Business with 0gp and failed
   to buy a 5gp fly fishing rod.
10. `fastWalkTo` resolves `{success: false}` rather than throwing when it
    genuinely can't get somewhere - a bare `.catch(err => logEvent(...))`
    after it (the original shape of every task's fallback-spot walk) never
    sees that, so a real failure just loops silently forever instead of
    showing up anywhere. Always check `.success` and escalate after repeated
    failures, the same way `recordFailure`/`checkClientHealth` do for other
    failure modes. Confirmed live: a closed door mid-route made every
    fallback walk fail ("outside the current build area and no path leads
    toward its edge" in the gateway's own log - not visible anywhere in
    `run.log.jsonl`), and the task just kept retrying it every 5 misses with
    no indication anything was wrong.
11. Food restocking (`tasks/lib/health.ts`'s `ensureHealthy`,
    `tasks/lib/bank.ts`'s `restockFood`) fills up to leave a few free slots,
    not a fixed small count - most tasks' own loot is coins (one stack
    regardless of amount), so a fixed count like 5 meant a bank trip every
    few fights/pickpockets even with 20+ free slots sitting idle. Observed
    live once the local-gateway speedup made bank trips frequent enough to
    actually notice.
12. A single `bot.walkTo()` call over a long distance can fail outright at
    a real chokepoint (a castle gate) even though the identical route
    succeeds when split into several shorter `bot.walkTo()` calls - each
    short call gets its own fresh 3-strikes stuck-detection budget
    (sdk/actions.ts) and a freshly re-planned path, and lands close enough
    to a door for its own door-retry to actually trigger before giving up.
    `fastWalkTo`'s fallback (previously one `bot.walkTo(x, z)` for the whole
    remaining distance) now hops through intermediate points every
    `HOP_TILES` (8) instead - see `tasks/lib/fastWalk.ts`'s `chunkedWalkTo`.
    Tuning note: `sdk.sendFindPath`'s waypoints are one per *direction
    change*, not one per tile (despite this file's own header comment
    assuming the latter) - a long straight stretch comes back as a single
    far waypoint, so picking "the farthest waypoint within HOP_TILES" doesn't
    work on its own; interpolating a point along the line when the nearest
    waypoint is already farther than HOP_TILES is what actually enforces the
    cap. Confirmed live: a 50-tile walk through a Varrock Castle gate failed
    instantly (zero movement) as one call, succeeded reliably in ~18s once
    chunked.
13. A site's `ores`/`catches` list is a claim about what's actually at that
    exact spot, not what's typically found in that general area - don't
    extrapolate from "copper and tin are usually paired" without checking.
    `sw-varrock` originally listed copper ore on exactly that reasoning; live
    scanning (`sdk.scanNearbyLocs`) at that spot found tin/clay/iron/silver
    but zero copper rocks anywhere nearby. The real copper+tin (+iron)
    cluster is `se-varrock`, ~100 tiles east - learnings/mining.md's "SE
    Varrock mine", which was sitting right there in the docs the whole time.

14. A `targetQuantity` tracked only as an in-process action count resets to 0
    on every restart - and tasks restart often (needsAttention, a crash, a
    manual relaunch). Confirmed live: `mining.ts --ore="copper ore,tin ore"
    --targetQuantity=100 --disposal=bank` was restarted 6 times over ~34h,
    each run re-mining copper from 0 again since nothing it could check
    remembered the previous runs' progress - tin ore was only ever reached
    once, by accident, when an unrelated error aborted the copper `mineFor()`
    call early. Fix: `tasks/lib/bankCache.ts` persists a snapshot of the bank
    to disk on every real bank trip (no extra trip needed to write it), so a
    quantity target backed by disposal='bank' can read "how much do I already
    have banked" on startup and count toward that instead of starting over.
    Doesn't help disposal='drop', which leaves nothing to resume from.
    (`--ore` no longer accepts a comma-separated list - queue one mining run
    per ore instead - but the bank-cache resume behavior above still applies
    to each.)

## Adding a new task

1. Write `tasks/yourtask.ts` exporting `runYourTask(ctx, botName, status, opts)`
   (follow `woodcut.ts` as the simplest template):
   - loop until an `sdk.getSkill(...).baseLevel` target is met or a safety
     `maxMs` deadline passes
   - call `ensureBankSpace(bot, sdk, botName, status, { keep, taskLabel, bankSpot })`
     before acting whenever the inventory could be full
   - write `status.lastAction`/`status.skills` and call `writeStatus()`
     after each action, not more often
   - call `logEvent()` for anything worth a line in the human log
   - call `checkClientHealth(...)` right after `if (!state) {...}`, and route
     every action's `catch` through `recordFailure`/`recordSuccess`
   - if a location (spot/bank/level requirement) is reusable, add it to
     `tasks/lib/sites.ts` instead of hardcoding it in the script
2. Add an `import.meta.main` CLI block so it's runnable alone.
3. Add it to `PLAN` in `plan.ts` if it should be part of the default sequence.
