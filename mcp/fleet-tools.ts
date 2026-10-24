// MCP tools for goals, notes and fleets - the bot-manager daemon's state an
// agent needs to decide what to queue next and to coordinate several bots
// toward a shared goal. Same thin-HTTP-wrapper pattern as mcp/task-tools.ts:
// every tool just calls the daemon's REST API, never the DB directly.

const MANAGER_BASE = process.env.MANAGER_URL ?? `http://localhost:${process.env.MANAGER_PORT ?? 7790}`;

async function callManager(path: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
        res = await fetch(`${MANAGER_BASE}${path}`, init);
    } catch (err: any) {
        throw new Error(
            `Could not reach the bot-manager daemon at ${MANAGER_BASE} (${err?.message ?? err}). Start it with: bun manager/daemon.ts`
        );
    }
    const body: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `Manager request failed with status ${res.status}`);
    return body;
}

function requireString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string' || !value) throw new Error(`"${key}" is required`);
    return value;
}

function jsonPost(path: string, body: unknown) {
    return callManager(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function jsonPut(path: string, body: unknown) {
    return callManager(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export const setBotGoalTool = {
    name: 'set_bot_goal',
    description: 'Set (or clear, with goal: null) a bot\'s current high-level objective. Shown on the dashboard and returned by get_bot_status - the thing an agent deciding what to queue next should read first.',
    inputSchema: {
        type: 'object' as const,
        properties: { bot_name: { type: 'string' }, goal: { type: ['string', 'null'] } },
        required: ['bot_name', 'goal'],
        additionalProperties: false,
    },
};

export const addBotNoteTool = {
    name: 'add_bot_note',
    description: 'Leave a timestamped note on a bot - observations, decisions, gotchas for next time. Append-only; get_bot_status returns the most recent ones. This is the agent-facing replacement for the old lab_log.md file.',
    inputSchema: {
        type: 'object' as const,
        properties: { bot_name: { type: 'string' }, content: { type: 'string' }, author: { type: 'string' } },
        required: ['bot_name', 'content'],
        additionalProperties: false,
    },
};

export const setBotFleetTool = {
    name: 'set_bot_fleet',
    description: 'Assign a bot to a fleet (or unassign, with fleet_id: null).',
    inputSchema: {
        type: 'object' as const,
        properties: { bot_name: { type: 'string' }, fleet_id: { type: ['string', 'null'] } },
        required: ['bot_name', 'fleet_id'],
        additionalProperties: false,
    },
};

export const createFleetTool = {
    name: 'create_fleet',
    description: 'Create a fleet - a named group of bots working toward a shared or coordinated goal. Returns its id; use set_bot_fleet to assign members.',
    inputSchema: {
        type: 'object' as const,
        properties: { name: { type: 'string' }, goal: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
    },
};

export const listFleetsTool = {
    name: 'list_fleets',
    description: 'List all fleets.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
};

export const getFleetStatusTool = {
    name: 'get_fleet_status',
    description: 'Fleet detail: its goal and its member bots (each with their own status/goal).',
    inputSchema: {
        type: 'object' as const,
        properties: { fleet_id: { type: 'string' } },
        required: ['fleet_id'],
        additionalProperties: false,
    },
};

export const setFleetGoalTool = {
    name: 'set_fleet_goal',
    description: 'Set (or clear) a fleet\'s shared goal - what the orchestrator agent coordinating this fleet is working toward.',
    inputSchema: {
        type: 'object' as const,
        properties: { fleet_id: { type: 'string' }, goal: { type: ['string', 'null'] } },
        required: ['fleet_id', 'goal'],
        additionalProperties: false,
    },
};

export const addFleetNoteTool = {
    name: 'add_fleet_note',
    description: 'Leave a timestamped note on a fleet - the fleet-wide equivalent of add_bot_note, for an orchestrator\'s own memory.',
    inputSchema: {
        type: 'object' as const,
        properties: { fleet_id: { type: 'string' }, content: { type: 'string' }, author: { type: 'string' } },
        required: ['fleet_id', 'content'],
        additionalProperties: false,
    },
};

export const listNotificationsTool = {
    name: 'list_notifications',
    description: 'List pending (unacked) notifications - events matching a subscription you created with create_subscription (needs_attention, run_done, run_error, note_added). Poll this; nothing pushes to you.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
};

export const ackNotificationTool = {
    name: 'ack_notification',
    description: 'Mark a notification as handled so it stops showing up in list_notifications.',
    inputSchema: {
        type: 'object' as const,
        properties: { id: { type: 'number' } },
        required: ['id'],
        additionalProperties: false,
    },
};

export const createSubscriptionTool = {
    name: 'create_subscription',
    description:
        'Register interest in an event type (needs_attention, run_done, run_error, note_added), optionally scoped to one bot and/or fleet (omit both to match everything). Matching events show up in list_notifications - poll it from a /loop, a cron, or whenever you check in.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            label: { type: 'string' },
            event_type: { type: 'string', enum: ['needs_attention', 'run_done', 'run_error', 'note_added'] },
            bot_name: { type: 'string' },
            fleet_id: { type: 'string' },
        },
        required: ['label', 'event_type'],
        additionalProperties: false,
    },
};

export const fleetTools = [
    setBotGoalTool,
    addBotNoteTool,
    setBotFleetTool,
    createFleetTool,
    listFleetsTool,
    getFleetStatusTool,
    setFleetGoalTool,
    addFleetNoteTool,
    listNotificationsTool,
    ackNotificationTool,
    createSubscriptionTool,
];

export function isFleetTool(name: string): boolean {
    return fleetTools.some(t => t.name === name);
}

export async function handleFleetTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
        case 'set_bot_goal':
            return jsonPut(`/api/bots/${encodeURIComponent(requireString(args, 'bot_name'))}/goal`, { goal: args.goal ?? null });

        case 'add_bot_note':
            return jsonPost(`/api/bots/${encodeURIComponent(requireString(args, 'bot_name'))}/notes`, {
                content: requireString(args, 'content'),
                author: args.author,
            });

        case 'set_bot_fleet':
            return jsonPut(`/api/bots/${encodeURIComponent(requireString(args, 'bot_name'))}/fleet`, { fleetId: args.fleet_id ?? null });

        case 'create_fleet':
            return jsonPost('/api/fleets', { name: requireString(args, 'name'), goal: args.goal });

        case 'list_fleets':
            return callManager('/api/fleets');

        case 'get_fleet_status':
            return callManager(`/api/fleets/${encodeURIComponent(requireString(args, 'fleet_id'))}`);

        case 'set_fleet_goal':
            return jsonPut(`/api/fleets/${encodeURIComponent(requireString(args, 'fleet_id'))}/goal`, { goal: args.goal ?? null });

        case 'add_fleet_note':
            return jsonPost(`/api/fleets/${encodeURIComponent(requireString(args, 'fleet_id'))}/notes`, {
                content: requireString(args, 'content'),
                author: args.author,
            });

        case 'list_notifications':
            return callManager('/api/notifications');

        case 'ack_notification': {
            const id = args.id;
            if (typeof id !== 'number') throw new Error('"id" (number) is required');
            return jsonPost(`/api/notifications/${id}/ack`, {});
        }

        case 'create_subscription':
            return jsonPost('/api/subscriptions', {
                label: requireString(args, 'label'),
                eventType: requireString(args, 'event_type'),
                botId: args.bot_name,
                fleetId: args.fleet_id,
            });

        default:
            throw new Error(`Unknown fleet tool: ${name}`);
    }
}
