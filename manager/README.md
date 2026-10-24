# Bot Manager

A dashboard + API for everything about your bots: live position, HP,
skills, inventory and bank at a glance; a full record of every action a
task took and its result; a goal and a notes/memory feed per bot (and per
**fleet** - a named group of bots working toward a shared or coordinated
goal); and a queue so you don't start/kill `nohup` processes by hand.

```
┌─────────────────┐   HTTP + WebSocket    ┌──────────────────────────┐
│ React dashboard  │ ───────────────────▶ │  manager/daemon.ts         │
│ (manager/web)    │ ◀─────────────────── │  (Bun.serve, long-running) │
└─────────────────┘   push "refresh"      │  - REST API + WS fan-out   │
┌─────────────────┐   HTTP                │  - owns the task queue     │
│ MCP tools        │ ───────────────────▶ │    (db/runs.ts)            │
│ (mcp/task-tools, │                       │  - spawns/kills             │
│  mcp/fleet-tools)│                       │    `bun tasks/X.ts ...`    │
└─────────────────┘                       └──────────────────────────┘
                                                         │
                                                         ▼
                                        shared SQLite DB (data/manager.sqlite)
                                        bots, fleets, notes, status, bank
                                        snapshot, runs, actions, events,
                                        subscriptions, pending_notifications
                                                         ▲
                                                         │
                               bare `bun tasks/x.ts barry` (no daemon running)
                               writes to the exact same DB file directly
```

## Storage: a shared SQLite DB, not `bots/*/` JSON files

`bots/{name}/bot.env` (credentials) is the one thing still a plain file -
it's read directly, with zero manager involvement, by `sdk/runner.ts`,
`sdk/cli.ts`, `sdk/chat.ts`, `sdk/bug-report.ts`, the lite runner/bench/swarm
scripts, and the `execute_code` MCP tool. Moving it into the DB would break
every one of those standalone entry points.

**Everything else** - status, the task queue, the bank snapshot, the event
log, the full action log, goals, notes, fleets, notifications - lives in
one `bun:sqlite` database (`db/`, path from `MANAGER_DB_PATH`, default
`data/manager.sqlite`). Crucially, `tasks/lib/status.ts` and
`tasks/lib/bankCache.ts` write to this DB directly too, not just through the
manager - so `bun tasks/mining.ts barry --ore="iron ore"` run from a bare
terminal, with no daemon running at all, still works exactly as before and
the dashboard will show its progress correctly the next time the daemon
*is* running. See `db/schema.ts` for the full table list.

"Subscriptions" (for the dashboard's live updates) are implemented at the
app layer, not via a DB-native `LISTEN/NOTIFY`: the daemon is the only
process serving HTTP, so `manager/worker.ts`'s already-running ~1s
scheduling tick doubles as a change-watcher, pushing a `{type:'refresh',
botId}` ping over WebSocket (`manager/liveUpdates.ts`) whenever anything
changes for a bot - whether that change came from the daemon's own spawned
child or a manually-run task script sharing the same DB file. The dashboard
still polls as a robust fallback; the WS ping just makes it refetch
immediately instead of waiting for the next interval.

## Full action log

Every `bot.*`/`sdk.*` call a task script or an `execute_code` session makes
gets recorded - method, args, result, success/error, duration - to the
`actions` table, via `sdk/actionLogger.ts`'s `tracked()` proxy (wired into
both `sdk/runner.ts` and `mcp/execute-code.ts`). This is the full record an
agent needs to debug a misbehaving task or develop a new one: `GET
/api/bots/:name/actions` or the dashboard's "Action log" panel. Action
logging fails open - a DB write failure disables it for the rest of that
process rather than ever breaking a real script run.

## Running it

```bash
bun manager/daemon.ts            # the daemon: API + WS on :7790, serves manager/web/dist if built
cd manager/web && bun run dev    # live frontend dev server on :5173, proxies /api to :7790
```

For a one-process setup (no separate frontend dev server): `cd manager/web
&& bun run build`, then just run the daemon - it serves the built dashboard
itself at `http://localhost:7790/`.

`MANAGER_PORT` overrides the daemon's port (default `7790`); the frontend
dev server and MCP tools both read the same variable, or `MANAGER_URL` for
the MCP tools specifically if the daemon runs on a different host.
`MANAGER_DB_PATH` overrides the DB file location.

## Starting/stopping a bot's game client

Most of the dashboard (live position/HP/inventory/bank, and anything the MCP
tools do) needs a game client logged in and connected to the gateway - see
CLAUDE.md "Start a Game Client". Previously that meant opening a browser tab
by hand. Now a bot has an on/off switch (`bots.desired_running`, the
dashboard's Start/Stop button on a bot or a whole fleet) that the daemon
reconciles on its own ~1s tick (`manager/clientRegistry.ts`, called from
`manager/worker.ts`): "on" with nothing attached spawns `bun src/lite/runner.ts
<bot>`; "on" with something already attached (checked via the gateway's `GET
/status/:username`, extended with a `kind: 'web'|'lite'|null` field for this)
is left alone, so a manually-opened web client is never pre-empted by a
spawned lite one; "off" kills whatever lite runner this daemon spawned. A web
client that logs in later still takes over from (and kills) a running lite
runner via the gateway's existing session-takeover flow - and if it later
closes, the bot is still "on" from the dashboard's point of view, so the next
tick spawns the lite runner again. `GET/POST /api/bots/:name/client[/start|
/stop]` and `POST /api/fleets/:id/client/start|stop` (all members at once).

## The ownership rule

**`manager/daemon.ts` is the only thing that spawns or kills `bun
tasks/*.ts` child processes**, and (per the previous section)
`manager/clientRegistry.ts` is the only thing that spawns or kills a bot's
lite-runner game client. The dashboard and the MCP tools
(`mcp/task-tools.ts`: `create_bot`, `list_tasks`, `enqueue_task`,
`get_bot_status`, `cancel_task`; `mcp/fleet-tools.ts`: goals/notes/fleets/
notifications) never spawn a process or write to the DB's `runs` table
directly - they only call the daemon's HTTP API, exactly like each other.
This keeps "what can take control of a bot" answerable from one place
(`manager/worker.ts`).

It does **not**, and cannot, stop a human or another MCP session from
calling `execute_code` on a bot that has a queued/running task - a new
controller always preempts the old one (see `tasks/README.md`). Check
`get_bot_status`/the dashboard before using `execute_code` on a bot that
might be mid-task.

If the daemon isn't running, the dashboard shows a 503 and the MCP tools
return a clear "start it with `bun manager/daemon.ts`" error - neither
silently no-ops.

## Fleets and notifications

A **fleet** is just a named group of bots (`fleet_id` on the `bots` table)
with its own goal and notes - for an orchestrator agent coordinating several
bots toward one objective, whether they're all doing the same thing or each
doing something different toward a shared goal. `set_bot_fleet`/
`create_fleet`/`get_fleet_status` (MCP) or the dashboard's Fleets page.

**Notifications are poll-based, not push**: `create_subscription` registers
interest in one of four event types (`needs_attention`, `run_done`,
`run_error`, `note_added`), optionally scoped to a bot/fleet.
`manager/worker.ts`'s tick (for `needs_attention`, detected by edge-watching
`status`) or the exact point a run finishes/a note is added (for the other
three) fires any matching subscription into `pending_notifications`. An
agent polls `list_notifications` and clears each with `ack_notification` -
the daemon has no way to invoke an LLM itself, so this is the same
Planner/Supervisor/Executor pattern `tasks/README.md` already documents,
just made persistent and queryable instead of a human eyeballing
`checkup.ts`.

## Files

- `db/` - the schema and all typed read/write functions (shared with
  `tasks/lib/status.ts`/`bankCache.ts`, not manager-only).
- `manager/queue.ts` - removed; replaced by `db/runs.ts`.
- `manager/worker.ts` - the scheduling loop + change-watcher + notification
  detection described above, plus (as of the Start/Stop feature) calling
  `clientRegistry.ts`'s reconcile pass each tick.
- `manager/clientRegistry.ts` - owns spawning/killing a bot's lite-runner
  game client per its on/off switch, described above.
- `manager/taskRegistry.ts` - the list of runnable tasks and the fields each
  one's form/MCP call accepts, built from `tasks/lib/sites.ts`'s site tables.
- `manager/botRegistry.ts` - reads `bot.env` (credentials only) plus the DB
  for everything else about a bot.
- `manager/gatewayState.ts` - live state via the gateway's `GET
  /state/:bot`, the same read `sdk/cli.ts` does (returning a result instead
  of calling `process.exit()`, since this runs inside a daemon).
- `manager/liveUpdates.ts` - the WebSocket subscriber set + broadcast/
  pingRefresh used by `worker.ts` and `daemon.ts`'s route handlers.
- `manager/migrateLegacy.ts` - one-time best-effort import of any
  pre-existing `bots/*/status.json`/`bank_cache.json`/`lab_log.md` into the
  DB, run once at daemon startup. Old `queue.json`/`run.log.jsonl`/
  `task-runs.log` history is not imported (disposable operational logs);
  old files are left on disk, just no longer written to.
- `manager/daemon.ts` - the HTTP API + WebSocket + static dashboard serving.
- `manager/web/` - the React dashboard (Vite + TS). Polls every few
  seconds, with the WS channel pushing immediate refetches on change.
