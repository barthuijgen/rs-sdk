// Owns the daemon's spawned lite-client child processes - the "Start/Stop"
// feature for a bot's game-client connection, mirroring manager/worker.ts's
// ownership of task-script children (same "one place can spawn/kill"
// rule - see manager/README.md "The ownership rule").
//
// "Start" doesn't unconditionally spawn `bun src/lite/runner.ts <bot>`
// (CLAUDE.md "Start a Game Client"): if a web client was opened by hand (the
// dashboard's "Open webclient" button, or a bare browser tab) and is already
// logged in as this bot, spawning a lite runner too would make gateway.ts
// treat it as a session takeover and kick the web client out. So a bot
// marked "on" (bots.desired_running, db/bots.ts) only gets a lite runner
// spawned once reconcile() sees the gateway report no live session for it -
// which is also what makes this an automatic fallback: closing the web
// client leaves the bot "on" with nothing attached, so the very next
// reconcile pass (manager/worker.ts's ~1s tick) spawns the lite runner to
// pick it back up, and a web client that logs in later naturally takes over
// from (and kills) that lite runner via gateway.ts's existing takeover flow.
//
// "Stop" is simpler: it always kills whatever lite runner this daemon has
// spawned for the bot, regardless of gateway state. It never touches a web
// client - there is no way to close someone's browser tab from here, nor
// should there be.

import { openSync, closeSync, writeSync } from 'fs';
import { join, relative } from 'path';
import { listBotNames, readBotEnv } from './botRegistry';
import { deriveGatewayUrl } from '../sdk/index';
import { fetchGatewayStatus } from './gatewayState';
import { getBot, setDesiredRunning } from '../db/bots';
import { pingRefresh } from './liveUpdates';

function repoRoot(): string {
    return join(import.meta.dir, '..');
}

function webclientDir(): string {
    return join(repoRoot(), 'server', 'webclient');
}

function clientLogPath(botName: string): string {
    return join(repoRoot(), 'bots', botName, 'client-runner.log');
}

// botName -> live subprocess handle for a lite runner this daemon spawned.
const children = new Map<string, ReturnType<typeof Bun.spawn>>();

// Exit/failure history, purely for surfacing *why* a bot marked "on" isn't
// attached - reconcile() itself only reads lastExit (for the cooldown below).
interface ExitInfo {
    code: number | null;
    at: number;
}
const lastExit = new Map<string, ExitInfo>();
const lastSpawnError = new Map<string, string>();

// A lite runner that fails immediately (bad revision, bad credentials, bun
// missing from PATH) would otherwise get re-spawned every ~1s tick forever -
// a crash loop that spams bots/<name>/client-runner.log and hides the one
// error that matters under a flood of repeats. Back off instead; the UI still
// shows "on" with the last exit code the whole time.
const RESPAWN_COOLDOWN_MS = 10_000;

function spawn(botName: string): void {
    if (children.has(botName)) return;
    lastSpawnError.delete(botName);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
        const fd = openSync(clientLogPath(botName), 'a');
        writeSync(fd, `\n--- [${new Date().toISOString()}] starting lite client for ${botName} ---\n`);
        proc = Bun.spawn({
            cmd: ['bun', 'src/lite/runner.ts', botName],
            cwd: webclientDir(),
            stdout: fd,
            stderr: fd,
            env: process.env,
        });
        proc.exited.finally(() => closeSync(fd));
    } catch (err: any) {
        lastSpawnError.set(botName, err?.message ?? String(err));
        pingRefresh({ botId: botName });
        return;
    }

    children.set(botName, proc);
    pingRefresh({ botId: botName });

    proc.exited.then(code => {
        lastExit.set(botName, { code, at: Date.now() });
        children.delete(botName);
        pingRefresh({ botId: botName });
    });
}

function kill(botName: string): void {
    const proc = children.get(botName);
    if (!proc) return;
    proc.kill();
    children.delete(botName);
    lastExit.delete(botName);
}

/** Marks the bot "on" - takes effect on the next reconcile() pass, not
 * immediately, since that pass is the only thing allowed to decide whether a
 * web client already covers it. Clears any previous failure so a retry
 * isn't silently swallowed by the next status read looking identical to the
 * old one. */
export function startClient(botName: string): void {
    setDesiredRunning(botName, true);
    lastExit.delete(botName);
    lastSpawnError.delete(botName);
    pingRefresh({ botId: botName });
}

/** Marks the bot "off" and immediately kills any lite runner this daemon
 * spawned for it. */
export function stopClient(botName: string): void {
    setDesiredRunning(botName, false);
    kill(botName);
    lastSpawnError.delete(botName);
    pingRefresh({ botId: botName });
}

export interface ClientStatus {
    desiredRunning: boolean;
    managed: boolean; // this daemon has a lite-runner child alive for this bot
    gateway: 'active' | 'stale' | 'dead' | 'unknown';
    attachedKind: 'web' | 'lite' | null;
    gatewayError: string | null; // why `gateway` is 'unknown', if it is
    lastExitCode: number | null; // the managed lite runner's last exit code, if it has ever exited
    lastExitAt: number | null;
    spawnError: string | null; // set if Bun.spawn itself threw (e.g. log file unwritable)
    logPath: string; // relative to the repo root, for "check this file" error text
}

export async function getClientStatus(botName: string): Promise<ClientStatus> {
    const bot = getBot(botName);
    const env = readBotEnv(botName);
    const result = env ? await fetchGatewayStatus(deriveGatewayUrl(env.server), env.username) : null;
    const exit = lastExit.get(botName);
    return {
        desiredRunning: Boolean(bot?.desired_running),
        managed: children.has(botName),
        gateway: result?.ok ? result.status : 'unknown',
        attachedKind: result?.ok ? result.kind : null,
        gatewayError: result && !result.ok ? result.reason : env ? null : 'No bot.env found for this bot',
        lastExitCode: exit?.code ?? null,
        lastExitAt: exit?.at ?? null,
        spawnError: lastSpawnError.get(botName) ?? null,
        logPath: relative(repoRoot(), clientLogPath(botName)),
    };
}

/** One reconciliation pass, called from manager/worker.ts's ~1s tick.
 * Bots marked "off" need nothing here - stopClient() already killed their
 * child. Bots marked "on" get a lite runner spawned unless one is already
 * running, a previous attempt is still in its cooldown, or the gateway
 * reports some other live session (a web client) already attached. A
 * gateway that can't be reached at all is left alone rather than guessed at,
 * so a transient network blip can't spawn a second client on top of one it
 * simply failed to see - getClientStatus's `gatewayError` is what tells the
 * dashboard *why* nothing is happening in that case. */
export async function reconcileClients(): Promise<void> {
    for (const botName of listBotNames()) {
        const bot = getBot(botName);
        if (!bot?.desired_running || children.has(botName)) continue;

        const exit = lastExit.get(botName);
        if (exit && Date.now() - exit.at < RESPAWN_COOLDOWN_MS) continue;

        const env = readBotEnv(botName);
        if (!env) continue;

        const result = await fetchGatewayStatus(deriveGatewayUrl(env.server), env.username);
        if (!result.ok || result.status !== 'dead') continue;

        spawn(botName);
    }
}
