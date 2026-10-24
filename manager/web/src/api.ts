import type {
    ActionRow,
    BotDetail,
    BotSummary,
    ClientStatus,
    FleetRow,
    FleetWithMembers,
    NoteRow,
    PendingNotification,
    RunRow,
    SubscriptionRow,
    TaskDef,
} from './types';

/** Thrown by `request()`. `offline` means the fetch itself never completed
 * (daemon not running, network down) - callers that want to tell "the
 * daemon is down" apart from "the daemon said no" check this flag rather
 * than guessing from the message text. */
export class ApiError extends Error {
    status: number | null;
    offline: boolean;
    constructor(message: string, opts: { status?: number | null; offline?: boolean } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = opts.status ?? null;
        this.offline = opts.offline ?? false;
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`/api${path}`, {
            headers: init?.body ? { 'content-type': 'application/json' } : undefined,
            ...init,
        });
    } catch {
        // fetch rejects (not a non-2xx response) when the request never reached
        // a server at all - see README "If the daemon isn't running".
        throw new ApiError("Can't reach the manager daemon. Start it with `bun manager/daemon.ts`.", { offline: true });
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        throw new ApiError(body?.error ?? `Request failed (${res.status})`, { status: res.status });
    }
    return body as T;
}

export const api = {
    listBots: () => request<BotSummary[]>('/bots'),
    getBot: (name: string) => request<BotDetail>(`/bots/${encodeURIComponent(name)}`),
    createBot: (opts: { username?: string; server?: string; local?: boolean }) =>
        request<{ name: string }>('/bots', { method: 'POST', body: JSON.stringify(opts) }),
    listTasks: () => request<TaskDef[]>('/tasks'),

    setGoal: (bot: string, goal: string | null) => request<{ ok: true }>(`/bots/${encodeURIComponent(bot)}/goal`, { method: 'PUT', body: JSON.stringify({ goal }) }),
    setFleet: (bot: string, fleetId: string | null) =>
        request<{ ok: true }>(`/bots/${encodeURIComponent(bot)}/fleet`, { method: 'PUT', body: JSON.stringify({ fleetId }) }),

    listNotes: (bot: string) => request<NoteRow[]>(`/bots/${encodeURIComponent(bot)}/notes`),
    addNote: (bot: string, content: string, author?: string) =>
        request<NoteRow>(`/bots/${encodeURIComponent(bot)}/notes`, { method: 'POST', body: JSON.stringify({ content, author }) }),

    getActions: (bot: string, opts: { limit?: number; runId?: string } = {}) => {
        const qs = new URLSearchParams();
        if (opts.limit) qs.set('limit', String(opts.limit));
        if (opts.runId) qs.set('runId', opts.runId);
        return request<ActionRow[]>(`/bots/${encodeURIComponent(bot)}/actions?${qs.toString()}`);
    },

    enqueueTask: (bot: string, task: string, args: Record<string, unknown>) =>
        request<RunRow>(`/bots/${encodeURIComponent(bot)}/queue`, { method: 'POST', body: JSON.stringify({ task, args }) }),
    removeQueued: (bot: string, id: string) => request<{ ok: true }>(`/bots/${encodeURIComponent(bot)}/queue/${id}`, { method: 'DELETE' }),
    cancelRunning: (bot: string) => request<{ ok: true }>(`/bots/${encodeURIComponent(bot)}/cancel`, { method: 'POST' }),
    cancelEntry: (bot: string, id: string) =>
        request<{ ok: true }>(`/bots/${encodeURIComponent(bot)}/queue/${id}/cancel`, { method: 'POST' }),
    getLog: (bot: string, limit = 200) => request<Record<string, unknown>[]>(`/bots/${encodeURIComponent(bot)}/log?limit=${limit}`),
    getWebclientUrl: (bot: string) => request<{ url: string }>(`/bots/${encodeURIComponent(bot)}/webclient-url`),

    getClientStatus: (bot: string) => request<ClientStatus>(`/bots/${encodeURIComponent(bot)}/client`),
    startClient: (bot: string) => request<ClientStatus>(`/bots/${encodeURIComponent(bot)}/client/start`, { method: 'POST' }),
    stopClient: (bot: string) => request<ClientStatus>(`/bots/${encodeURIComponent(bot)}/client/stop`, { method: 'POST' }),
    startFleetClients: (id: string) => request<{ ok: true; count: number }>(`/fleets/${encodeURIComponent(id)}/client/start`, { method: 'POST' }),
    stopFleetClients: (id: string) => request<{ ok: true; count: number }>(`/fleets/${encodeURIComponent(id)}/client/stop`, { method: 'POST' }),

    listFleets: () => request<FleetRow[]>('/fleets'),
    createFleet: (name: string, goal?: string) => request<FleetRow>('/fleets', { method: 'POST', body: JSON.stringify({ name, goal }) }),
    getFleet: (id: string) => request<FleetWithMembers>(`/fleets/${encodeURIComponent(id)}`),
    setFleetGoal: (id: string, goal: string | null) => request<{ ok: true }>(`/fleets/${encodeURIComponent(id)}/goal`, { method: 'PUT', body: JSON.stringify({ goal }) }),
    listFleetNotes: (id: string) => request<NoteRow[]>(`/fleets/${encodeURIComponent(id)}/notes`),
    addFleetNote: (id: string, content: string, author?: string) =>
        request<NoteRow>(`/fleets/${encodeURIComponent(id)}/notes`, { method: 'POST', body: JSON.stringify({ content, author }) }),

    listNotifications: () => request<PendingNotification[]>('/notifications'),
    ackNotification: (id: number) => request<{ ok: boolean }>(`/notifications/${id}/ack`, { method: 'POST' }),
    listSubscriptions: () => request<SubscriptionRow[]>('/subscriptions'),
    createSubscription: (label: string, eventType: string, opts: { botId?: string; fleetId?: string } = {}) =>
        request<SubscriptionRow>('/subscriptions', { method: 'POST', body: JSON.stringify({ label, eventType, ...opts }) }),
};
