// Reads everything the dashboard/MCP tools need to know about a bot: from
// bots/{name}/bot.env (credentials - deliberately NOT moved into the DB,
// see manager/README.md) and from the gateway's live-state endpoint, plus
// the shared SQLite DB (db/) for everything else that used to be separate
// JSON files.

import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { deriveGatewayUrl } from '../sdk/index';
import { getStatus } from '../db/status';
import type { TaskStatus } from '../tasks/lib/status';
import { getBankSnapshot, type BankSnapshot } from '../db/bank';
import { listRunsForBot, toApiRuns, type ApiBotRuns } from '../db/runs';
import { listBotNotes, type NoteRow } from '../db/notes';
import { getBot } from '../db/bots';
import { fetchLiveState, type LiveStateOk, type LiveStateError } from './gatewayState';
import type { BotWorldState } from '../sdk/types';

function repoRoot(): string {
    return join(import.meta.dir, '..');
}

function botsDir(): string {
    return join(repoRoot(), 'bots');
}

function parseEnv(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return result;
}

export interface BotEnv {
    username: string;
    server?: string;
}

interface BotCredentials extends BotEnv {
    password?: string;
    gatewayUrl: string;
}

function readRawEnv(botName: string): Record<string, string> | null {
    const p = join(botsDir(), botName, 'bot.env');
    if (!existsSync(p)) return null;
    return parseEnv(readFileSync(p, 'utf-8'));
}

export function readBotEnv(botName: string): BotEnv | null {
    const env = readRawEnv(botName);
    if (!env) return null;
    return { username: env.BOT_USERNAME || botName, server: env.SERVER };
}

/** Server-side only - includes the password needed to call the gateway's
 * /state endpoint. Never return this object (or its `password` field)
 * from an API route. */
function readBotCredentials(botName: string): BotCredentials | null {
    const env = readRawEnv(botName);
    if (!env) return null;
    const gatewayUrl = env.GATEWAY_URL || deriveGatewayUrl(env.SERVER);
    return { username: env.BOT_USERNAME || botName, server: env.SERVER, password: env.PASSWORD, gatewayUrl };
}

// The local-proxy.ts dev workflow (server/webclient/local-proxy.ts): a
// locally-built, patched webclient bundle served at this port, proxying
// static game assets from the bot's real engine (`server`/`engine` param)
// while its game and gateway sockets connect straight through to their real
// targets - the gateway override here is a locally-run one (manager/README.md
// "Running your own gateway"), not the bot's actual engine-relayed gateway.
// Overridable since not everyone runs local-proxy.ts/their gateway on the
// defaults it prints.
const WEBCLIENT_PROXY_PORT = process.env.WEBCLIENT_PROXY_PORT ?? '8899';
const WEBCLIENT_GATEWAY = process.env.WEBCLIENT_GATEWAY ?? 'localhost:7780';

/** URL for the "Open webclient" dashboard button - opens this bot's live
 * session in the local-proxy dev client against its real engine, through a
 * locally-run gateway. Returns null when there's no bot.env to read
 * credentials from. The password ends up in this URL the same way it
 * already does in sdk/runner.ts's/sdk/index.ts's printed browser-launch
 * URLs - that's the one deliberate exception to "never return credentials
 * from an API route" above, since the whole point is handing the browser a
 * clickable login link. */
export function buildWebclientUrl(botName: string): string | null {
    const creds = readBotCredentials(botName);
    if (!creds || !creds.password) return null;
    const params = new URLSearchParams({
        bot: creds.username,
        password: creds.password,
        engine: creds.server || 'rs-sdk-demo.fly.dev',
        gateway: WEBCLIENT_GATEWAY,
    });
    return `http://localhost:${WEBCLIENT_PROXY_PORT}/bot?${params.toString()}`;
}

export function listBotNames(): string[] {
    if (!existsSync(botsDir())) return [];
    return readdirSync(botsDir(), { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '_template')
        .map(d => d.name)
        .sort();
}

export function botExists(botName: string): boolean {
    return existsSync(join(botsDir(), botName, 'bot.env'));
}

export interface BotSummary {
    name: string;
    username: string;
    server?: string;
    goal: string | null;
    fleetId: string | null;
    status: TaskStatus | null;
    queue: { runningTask: string | null; queuedCount: number };
    desiredRunning: boolean;
}

export function readBotSummary(botName: string): BotSummary {
    const env = readBotEnv(botName);
    const botRow = getBot(botName);
    const status = getStatus<TaskStatus>(botName);
    const runs = listRunsForBot(botName);
    return {
        name: botName,
        username: env?.username ?? botName,
        server: env?.server,
        goal: botRow?.goal ?? null,
        fleetId: botRow?.fleet_id ?? null,
        status,
        queue: { runningTask: runs.running?.task ?? null, queuedCount: runs.queued.length },
        desiredRunning: Boolean(botRow?.desired_running),
    };
}

export interface BotDetail {
    name: string;
    username: string;
    server?: string;
    goal: string | null;
    fleetId: string | null;
    status: TaskStatus | null;
    queue: ApiBotRuns;
    bankCache: BankSnapshot | null;
    notes: NoteRow[];
    live: { state: BotWorldState; stateAge: number } | { error: string };
}

export async function readBotDetail(botName: string): Promise<BotDetail> {
    const env = readBotEnv(botName);
    const creds = readBotCredentials(botName);
    const botRow = getBot(botName);
    const live = creds
        ? await fetchLiveState(creds.gatewayUrl, creds.username, creds.password).then(
              (result: LiveStateOk | LiveStateError) => (result.ok ? { state: result.state, stateAge: result.stateAge } : { error: result.reason })
          )
        : { error: 'No bot.env found' };

    return {
        name: botName,
        username: env?.username ?? botName,
        server: env?.server,
        goal: botRow?.goal ?? null,
        fleetId: botRow?.fleet_id ?? null,
        status: getStatus<TaskStatus>(botName),
        queue: toApiRuns(listRunsForBot(botName)),
        bankCache: getBankSnapshot(botName),
        notes: listBotNotes(botName, 50),
        live,
    };
}
