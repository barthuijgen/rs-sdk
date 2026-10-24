// Live bot state for the dashboard, via the gateway's `GET /state/:bot` HTTP
// endpoint - the same read `sdk/cli.ts`'s `fetchStateViaHttp()` does. Not
// reused directly from there: that function calls `process.exit()` on
// failure, which is correct for a one-shot CLI but would take the whole
// long-running daemon down with it. This is the same request/response shape,
// just returning a result instead of exiting.

import type { BotWorldState } from '../sdk/types';

// deriveGatewayUrl's relayed form (e.g. wss://rs-sdk-demo.fly.dev/gateway)
// is only valid for the WebSocket upgrade - the engine's web server treats
// that exact path as reserved for it and 404s any HTTP GET under it
// (confirmed against the real demo server: GET .../gateway/status/x -> 404,
// GET .../status/x on the bare origin -> 200). Its HTTP admin routes
// (/status, /state, /chat, /say) live at the origin root, so strip the
// '/gateway' suffix along with the scheme swap. A bare ws://host:port with
// no path (the local-dev case) has nothing to strip.
function gatewayHttpBase(gatewayUrl: string): string {
    return gatewayUrl
        .replace(/^ws(s?):\/\//, 'http$1://')
        .replace(/\/gateway\/?$/, '')
        .replace(/\/$/, '');
}

export interface LiveStateOk {
    ok: true;
    state: BotWorldState;
    stateAge: number;
}

export interface LiveStateError {
    ok: false;
    reason: string;
}

export async function fetchLiveState(
    gatewayUrl: string,
    username: string,
    password: string | undefined,
    timeoutMs = 4000
): Promise<LiveStateOk | LiveStateError> {
    const params = new URLSearchParams();
    if (password) params.set('password', password);
    const qs = params.toString();
    const url = `${gatewayHttpBase(gatewayUrl)}/state/${encodeURIComponent(username)}${qs ? `?${qs}` : ''}`;

    let res: Response;
    try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err: any) {
        return { ok: false, reason: `Could not reach gateway: ${err?.message ?? err}` };
    }

    if (!(res.headers.get('content-type') ?? '').includes('json')) {
        return { ok: false, reason: 'Gateway did not answer with JSON (old gateway, or not a gateway at all)' };
    }

    const body: any = await res.json().catch(() => null);
    if (res.status === 404 || !body?.state) {
        return { ok: false, reason: 'No game client is currently logged in as this bot' };
    }

    return { ok: true, state: body.state as BotWorldState, stateAge: Number(body.stateAge) || 0 };
}

export interface GatewayStatusOk {
    ok: true;
    status: 'active' | 'stale' | 'dead';
    kind: 'web' | 'lite' | null;
}

export interface GatewayStatusError {
    ok: false;
    reason: string;
}

/** Whether, and via what kind of client, a bot is currently attached to the
 * gateway - via its unauthenticated `GET /status/:username` (no password
 * needed, unlike /state). manager/clientRegistry.ts uses this before
 * spawning a lite runner, so it never starts one over a live web client. */
export async function fetchGatewayStatus(
    gatewayUrl: string,
    username: string,
    timeoutMs = 3000
): Promise<GatewayStatusOk | GatewayStatusError> {
    const url = `${gatewayHttpBase(gatewayUrl)}/status/${encodeURIComponent(username)}`;

    let res: Response;
    try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err: any) {
        return { ok: false, reason: `Could not reach gateway: ${err?.message ?? err}` };
    }

    if (!(res.headers.get('content-type') ?? '').includes('json')) {
        return { ok: false, reason: 'Gateway did not answer with JSON (old gateway, or not a gateway at all)' };
    }

    const body: any = await res.json().catch(() => null);
    if (!body || typeof body.status !== 'string') {
        return { ok: false, reason: 'Malformed response from gateway' };
    }

    return { ok: true, status: body.status, kind: body.kind ?? null };
}
