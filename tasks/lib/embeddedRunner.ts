// Embedded-engine runner: the fast alternative to sdk/runner.ts's
// runScript(). Instead of connecting through the gateway relay (see
// tasks/README.md "Embedded engine" for why that's slow under load), this
// logs directly into the game engine via the lite client and drives
// BotActions against that connection with zero network hop for actions or
// state.
//
// The real tradeoff: this process IS the game client for the bot while it
// runs - same one-client-per-account constraint as the lite runner or a
// browser tab. Nothing else (a browser tab, MCP execute_code, another
// script) can be watching or controlling the account at the same time, and
// there is no visual rendering at all - pair this with a crude monitor (see
// tasks/lib/worldView.ts) if you want to keep an eye on it.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { LocalBotSDK } from '../../server/webclient/src/lite/localBotSDK';
import { BotActions } from '../../sdk/actions';
import { writeWorldView } from './worldView';

export interface EmbeddedScriptContext {
    bot: BotActions;
    sdk: LocalBotSDK;
}

export type EmbeddedScriptFunction = (ctx: EmbeddedScriptContext) => Promise<any>;

export interface RunEmbeddedOptions {
    /** Disconnect (log out) when the script finishes. Default true - unlike
     * the gateway runner, there's no shared browser session to preserve. */
    disconnectAfter?: boolean;
    /** Write a crude text world-state snapshot (tasks/lib/worldView.ts) to
     * bots/{name}/view.txt on this interval. Default 1000ms; 0 disables it.
     * There's no browser to watch in embedded mode, so this is the only
     * window into what's happening while it runs. */
    viewRefreshMs?: number;
}

function loadBotEnv(botName: string): Record<string, string> {
    const envPath = join(process.cwd(), 'bots', botName, 'bot.env');
    if (!existsSync(envPath)) throw new Error(`Bot "${botName}" not found at ${envPath}`);
    const env: Record<string, string> = {};
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
}

export async function runEmbedded(
    botName: string,
    fn: EmbeddedScriptFunction,
    options: RunEmbeddedOptions = {},
): Promise<any> {
    const env = loadBotEnv(botName);
    const username = env.BOT_USERNAME;
    const password = env.PASSWORD;
    const host = env.SERVER || 'localhost';
    if (!username || !password) {
        throw new Error(`bot.env for "${botName}" is missing BOT_USERNAME/PASSWORD`);
    }

    const sdk = new LocalBotSDK(
        { botUsername: username, password },
        { host, username, password, quiet: true },
    );
    const bot = new BotActions(sdk);

    console.log(`[embedded] Logging in '${username}' directly against the engine (no gateway)...`);
    await sdk.connect();
    await sdk.waitForReady();

    // waitForReady's own check (position/inGame/entities) can pass on a
    // tick before skills (and hp) are populated - collectBotState's stat
    // data arrives slightly later than position/entities. Caught live: a
    // task's very first read saw "Mining level 0" and bailed immediately
    // thinking the account didn't qualify, when it was actually level 48+.
    // Wait for a real skills snapshot before handing control to the task.
    await sdk.waitForCondition(s => (s.skills?.length ?? 0) > 0 && (s.player?.maxHp ?? 0) > 0, 10_000)
        .catch(() => console.warn('[embedded] Warning: skills/hp never populated within 10s - proceeding anyway'));

    console.log('[embedded] Connected and ready.');

    const viewRefreshMs = options.viewRefreshMs ?? 1000;
    let viewTimer: ReturnType<typeof setInterval> | null = null;
    if (viewRefreshMs > 0) {
        viewTimer = setInterval(() => {
            const state = sdk.getState();
            if (state) writeWorldView(botName, state);
        }, viewRefreshMs);
    }

    try {
        return await fn({ bot, sdk });
    } finally {
        if (viewTimer) clearInterval(viewTimer);
        if (options.disconnectAfter ?? true) {
            await sdk.disconnect();
        }
    }
}
