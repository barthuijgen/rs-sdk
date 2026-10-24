// The daemon's WebSocket fan-out: the "subscriptions" half of the live
// dashboard. The daemon is the only process serving HTTP, so it can just
// push a message to every open socket when something changes - no DB-native
// LISTEN/NOTIFY needed. manager/daemon.ts registers/unregisters sockets on
// open/close; manager/worker.ts (and manager/daemon.ts's own route handlers,
// e.g. adding a note) call broadcast()/pingRefresh() after a change.

import type { ServerWebSocket } from 'bun';

const subscribers = new Set<ServerWebSocket<unknown>>();

export function addSubscriber(ws: ServerWebSocket<unknown>): void {
    subscribers.add(ws);
}

export function removeSubscriber(ws: ServerWebSocket<unknown>): void {
    subscribers.delete(ws);
}

export function broadcast(message: Record<string, unknown>): void {
    const data = JSON.stringify(message);
    for (const ws of subscribers) {
        try {
            ws.send(data);
        } catch {
            // A send to a dead/closing socket shouldn't take down the broadcast for everyone else.
            subscribers.delete(ws);
        }
    }
}

/** The dashboard's "something changed, refetch" signal - the UI doesn't
 * need to know what changed, just which bot/fleet to re-poll immediately
 * instead of waiting for its next interval. */
export function pingRefresh(opts: { botId?: string; fleetId?: string }): void {
    broadcast({ type: 'refresh', ...opts });
}
