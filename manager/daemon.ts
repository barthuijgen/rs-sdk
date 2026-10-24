#!/usr/bin/env bun
// Bot-management daemon: the one long-running process that owns bot task
// queues and the child processes they spawn (see manager/worker.ts), and
// exposes it all over HTTP (+ a WebSocket refresh channel) for the React
// dashboard (manager/web) and the MCP tools (mcp/task-tools.ts,
// mcp/fleet-tools.ts) - all three talk to this same API, none of them
// touch the DB or a child process directly. See manager/README.md.

import { resolve, join, normalize } from 'path';
import { existsSync } from 'fs';
import { createBot } from '../bots/create-bot';
import { listBotNames, botExists, readBotSummary, readBotDetail, buildWebclientUrl } from './botRegistry';
import { TASKS, validateAndBuildArgs } from './taskRegistry';
import { enqueueRun, listRunsForBot, removeQueuedRun, toApiRun, toApiRuns } from '../db/runs';
import { cancelEntry, startWorker, reconcileOnStartup } from './worker';
import { ensureBot, setGoal, setFleet } from '../db/bots';
import { addBotNote, listBotNotes, addFleetNote, listFleetNotes } from '../db/notes';
import { createFleet, listFleets, getFleetWithMembers, setFleetGoal } from '../db/fleets';
import { listActions } from '../db/actions';
import { listEvents } from '../db/events';
import {
    createSubscription,
    listSubscriptions,
    listPendingNotifications,
    ackNotification,
    matchingSubscriptions,
    fireNotification,
    type NotificationEventType,
} from '../db/notifications';
import { addSubscriber, removeSubscriber, broadcast, pingRefresh } from './liveUpdates';
import { migrateLegacyFiles } from './migrateLegacy';
import { startClient, stopClient, getClientStatus } from './clientRegistry';

const PORT = Number(process.env.MANAGER_PORT ?? 7790);
const webDist = resolve(import.meta.dir, 'web', 'dist');

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function errorResponse(message: string, status = 400): Response {
    return json({ error: message }, status);
}

function requireBot(name: string): Response | null {
    return botExists(name) ? null : errorResponse(`Unknown bot "${name}"`, 404);
}

const EVENT_TYPES: NotificationEventType[] = ['needs_attention', 'run_done', 'run_error', 'note_added'];

async function handleApi(req: Request, url: URL): Promise<Response> {
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api', 'bots', 'barry', 'queue']

    // GET  /api/bots
    if (parts.length === 2 && parts[1] === 'bots' && req.method === 'GET') {
        return json(listBotNames().map(readBotSummary));
    }

    // POST /api/bots  { username?, server?, local?, hideChat? }
    if (parts.length === 2 && parts[1] === 'bots' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        try {
            const server = body.local ? 'localhost' : body.server;
            const name = await createBot(body.username, server, body.hideChat);
            ensureBot(name, { server: body.local ? 'localhost' : body.server });
            return json({ name });
        } catch (err: any) {
            return errorResponse(err?.message ?? String(err), 400);
        }
    }

    // GET /api/tasks
    if (parts.length === 2 && parts[1] === 'tasks' && req.method === 'GET') {
        return json(TASKS);
    }

    // --- Fleets ---
    if (parts.length === 2 && parts[1] === 'fleets' && req.method === 'GET') {
        return json(listFleets());
    }
    if (parts.length === 2 && parts[1] === 'fleets' && req.method === 'POST') {
        const body = await req.json().catch(() => null);
        if (!body?.name) return errorResponse('"name" is required');
        return json(createFleet(body.name, body.goal ?? null));
    }
    if (parts[1] === 'fleets' && parts.length >= 3) {
        const fleetId = parts[2]!;
        if (parts.length === 3 && req.method === 'GET') {
            const fleet = getFleetWithMembers(fleetId);
            return fleet ? json(fleet) : errorResponse('Unknown fleet', 404);
        }
        if (parts.length === 4 && parts[3] === 'goal' && req.method === 'PUT') {
            const body = await req.json().catch(() => null);
            setFleetGoal(fleetId, body?.goal ?? null);
            broadcast({ type: 'refresh', fleetId });
            return json({ ok: true });
        }
        if (parts.length === 4 && parts[3] === 'notes') {
            if (req.method === 'GET') return json(listFleetNotes(fleetId, 50));
            if (req.method === 'POST') {
                const body = await req.json().catch(() => null);
                if (typeof body?.content !== 'string' || !body.content) return errorResponse('"content" is required');
                const note = addFleetNote(fleetId, body.content, body.author);
                broadcast({ type: 'refresh', fleetId });
                return json(note);
            }
        }

        // POST /api/fleets/:id/client/start | /stop - start/stop every member's game client
        if (parts.length === 5 && parts[3] === 'client' && (parts[4] === 'start' || parts[4] === 'stop') && req.method === 'POST') {
            const fleet = getFleetWithMembers(fleetId);
            if (!fleet) return errorResponse('Unknown fleet', 404);
            for (const member of fleet.members) {
                if (parts[4] === 'start') startClient(member.id);
                else stopClient(member.id);
            }
            broadcast({ type: 'refresh', fleetId });
            return json({ ok: true, count: fleet.members.length });
        }
    }

    // --- Notifications / subscriptions ---
    if (parts.length === 2 && parts[1] === 'notifications' && req.method === 'GET') {
        return json(listPendingNotifications());
    }
    if (parts.length === 4 && parts[1] === 'notifications' && parts[3] === 'ack' && req.method === 'POST') {
        const id = Number(parts[2]);
        return json({ ok: ackNotification(id) });
    }
    if (parts.length === 2 && parts[1] === 'subscriptions' && req.method === 'GET') {
        return json(listSubscriptions());
    }
    if (parts.length === 2 && parts[1] === 'subscriptions' && req.method === 'POST') {
        const body = await req.json().catch(() => null);
        if (!body?.label || !body?.eventType) return errorResponse('"label" and "eventType" are required');
        if (!EVENT_TYPES.includes(body.eventType)) return errorResponse(`eventType must be one of: ${EVENT_TYPES.join(', ')}`);
        return json(createSubscription(body.label, body.eventType, { botId: body.botId, fleetId: body.fleetId }));
    }

    // --- Per-bot routes ---
    if (parts[1] !== 'bots' || parts.length < 3) return errorResponse('Not found', 404);
    const botName = parts[2]!;

    // GET /api/bots/:name
    if (parts.length === 3 && req.method === 'GET') {
        const missing = requireBot(botName);
        if (missing) return missing;
        return json(await readBotDetail(botName));
    }

    // GET /api/bots/:name/client - current client status (desired on/off,
    // whether this daemon has a lite runner spawned, what the gateway sees)
    if (parts.length === 4 && parts[3] === 'client' && req.method === 'GET') {
        const missing = requireBot(botName);
        if (missing) return missing;
        return json(await getClientStatus(botName));
    }

    // POST /api/bots/:name/client/start | /stop
    if (parts.length === 5 && parts[3] === 'client' && (parts[4] === 'start' || parts[4] === 'stop') && req.method === 'POST') {
        const missing = requireBot(botName);
        if (missing) return missing;
        if (parts[4] === 'start') startClient(botName);
        else stopClient(botName);
        return json(await getClientStatus(botName));
    }

    // GET /api/bots/:name/webclient-url
    if (parts.length === 4 && parts[3] === 'webclient-url' && req.method === 'GET') {
        const missing = requireBot(botName);
        if (missing) return missing;
        const url = buildWebclientUrl(botName);
        return url ? json({ url }) : errorResponse('No bot.env found for this bot', 404);
    }

    // GET /api/bots/:name/log?limit=200
    if (parts.length === 4 && parts[3] === 'log' && req.method === 'GET') {
        const missing = requireBot(botName);
        if (missing) return missing;
        const limit = Number(url.searchParams.get('limit') ?? 200);
        return json(listEvents(botName, limit));
    }

    // GET /api/bots/:name/actions?limit=200&runId=
    if (parts.length === 4 && parts[3] === 'actions' && req.method === 'GET') {
        const missing = requireBot(botName);
        if (missing) return missing;
        const limit = Number(url.searchParams.get('limit') ?? 200);
        const runId = url.searchParams.get('runId') ?? undefined;
        return json(listActions(botName, { limit, runId }));
    }

    // PUT /api/bots/:name/goal  { goal }
    if (parts.length === 4 && parts[3] === 'goal' && req.method === 'PUT') {
        const missing = requireBot(botName);
        if (missing) return missing;
        const body = await req.json().catch(() => null);
        setGoal(botName, body?.goal ?? null);
        pingRefresh({ botId: botName });
        return json({ ok: true });
    }

    // PUT /api/bots/:name/fleet  { fleetId: string|null }
    if (parts.length === 4 && parts[3] === 'fleet' && req.method === 'PUT') {
        const missing = requireBot(botName);
        if (missing) return missing;
        const body = await req.json().catch(() => null);
        setFleet(botName, body?.fleetId ?? null);
        pingRefresh({ botId: botName });
        return json({ ok: true });
    }

    // GET/POST /api/bots/:name/notes
    if (parts.length === 4 && parts[3] === 'notes') {
        const missing = requireBot(botName);
        if (missing) return missing;
        if (req.method === 'GET') return json(listBotNotes(botName, 50));
        if (req.method === 'POST') {
            const body = await req.json().catch(() => null);
            if (typeof body?.content !== 'string' || !body.content) return errorResponse('"content" is required');
            const note = addBotNote(botName, body.content, body.author);
            for (const sub of matchingSubscriptions('note_added', botName)) {
                fireNotification(sub.id, 'note_added', note, { botId: botName });
            }
            pingRefresh({ botId: botName });
            return json(note);
        }
    }

    // POST /api/bots/:name/queue  { task, args }
    if (parts.length === 4 && parts[3] === 'queue' && req.method === 'POST') {
        const missing = requireBot(botName);
        if (missing) return missing;
        const body = await req.json().catch(() => null);
        if (!body?.task) return errorResponse('"task" is required');
        const result = validateAndBuildArgs(body.task, body.args ?? {});
        if (!result.ok) return errorResponse(result.error);
        const run = enqueueRun(botName, body.task, result.args, body.triggeredBy ?? 'ui');
        pingRefresh({ botId: botName });
        return json(toApiRun(run));
    }

    // GET /api/bots/:name/queue
    if (parts.length === 4 && parts[3] === 'queue' && req.method === 'GET') {
        const missing = requireBot(botName);
        if (missing) return missing;
        return json(toApiRuns(listRunsForBot(botName)));
    }

    // DELETE /api/bots/:name/queue/:id - remove a still-queued entry
    if (parts.length === 5 && parts[3] === 'queue' && req.method === 'DELETE') {
        const missing = requireBot(botName);
        if (missing) return missing;
        const ok = removeQueuedRun(parts[4]!);
        if (ok) pingRefresh({ botId: botName });
        return ok ? json({ ok: true }) : errorResponse('Not found (it may already be running)', 404);
    }

    // POST /api/bots/:name/cancel - cancel whatever's running
    // POST /api/bots/:name/queue/:id/cancel - cancel a specific entry (running or queued)
    if (parts.length === 4 && parts[3] === 'cancel' && req.method === 'POST') {
        const missing = requireBot(botName);
        if (missing) return missing;
        const result = cancelEntry(botName);
        return result.ok ? json({ ok: true }) : errorResponse(result.error ?? 'Could not cancel', 400);
    }
    if (parts.length === 6 && parts[3] === 'queue' && parts[5] === 'cancel' && req.method === 'POST') {
        const missing = requireBot(botName);
        if (missing) return missing;
        const result = cancelEntry(botName, parts[4]);
        return result.ok ? json({ ok: true }) : errorResponse(result.error ?? 'Could not cancel', 400);
    }

    return errorResponse('Not found', 404);
}

function contentTypeFor(path: string): string {
    if (path.endsWith('.js')) return 'application/javascript';
    if (path.endsWith('.css')) return 'text/css';
    if (path.endsWith('.html')) return 'text/html';
    if (path.endsWith('.svg')) return 'image/svg+xml';
    if (path.endsWith('.json')) return 'application/json';
    return 'application/octet-stream';
}

function serveStatic(pathname: string): Response {
    if (!existsSync(webDist)) {
        return new Response(
            'Dashboard is not built. From manager/web: `bun run dev` for local dev (proxies /api here), or `bun run build` to serve it from this daemon.',
            { status: 503 }
        );
    }
    const indexPath = join(webDist, 'index.html');
    const requested = resolve(webDist, '.' + normalize(pathname));
    const filePath = requested.startsWith(webDist) && existsSync(requested) && pathname !== '/' ? requested : indexPath;
    return new Response(Bun.file(filePath), { headers: { 'content-type': contentTypeFor(filePath) } });
}

const server = Bun.serve({
    port: PORT,
    async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === '/api/ws') {
            const upgraded = srv.upgrade(req);
            if (upgraded) return undefined as unknown as Response;
            return errorResponse('WebSocket upgrade failed', 400);
        }
        if (url.pathname.startsWith('/api/')) {
            try {
                return await handleApi(req, url);
            } catch (err: any) {
                return errorResponse(err?.message ?? String(err), 500);
            }
        }
        return serveStatic(url.pathname);
    },
    websocket: {
        open(ws) {
            addSubscriber(ws);
        },
        message() {
            // No client->server messages expected yet; the channel is push-only.
        },
        close(ws) {
            removeSubscriber(ws);
        },
    },
});

migrateLegacyFiles();
reconcileOnStartup();
startWorker();

console.log(`[manager] listening on http://localhost:${PORT}`);
console.log(`[manager] bots: ${listBotNames().join(', ') || '(none yet)'}`);
