// MCP tools for the bot-manager daemon (manager/daemon.ts): creating bots
// and queuing/checking/cancelling task-script runs. Each tool is a thin
// fetch() to the daemon's HTTP API - the exact same API the React dashboard
// uses - so the daemon stays the single owner of bot task processes (see
// manager/README.md). These tools never spawn or kill a process directly.

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

export const createBotTool = {
    name: 'create_bot',
    description: 'Create a new bot (a bots/{username}/ folder with fresh credentials) via the bot-manager daemon. Leave username empty to auto-generate one.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            username: { type: 'string', maxLength: 12, description: 'Alphanumeric, max 12 chars. Omit to auto-generate a random one.' },
            server: { type: 'string', description: 'Game server hostname, e.g. rs-sdk-demo.fly.dev. Omit for the default.' },
            local: { type: 'boolean', description: 'Point the new bot at a local dev stack (localhost engine/gateway) instead of `server`.' },
        },
        additionalProperties: false,
    },
};

export const listTasksTool = {
    name: 'list_tasks',
    description: 'List the task scripts (tasks/*.ts) that can be queued on a bot via enqueue_task, with the fields each one accepts.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
};

export const enqueueTaskTool = {
    name: 'enqueue_task',
    description:
        'Queue a task script (see list_tasks for valid task keys and args) to run against a bot. The bot-manager daemon runs at most one queued task per bot at a time, strictly after whatever is already queued/running finishes. It CANNOT stop a human or another MCP session from calling execute_code on the same bot while a queued task owns it - a new controller always preempts the old one - so never call execute_code on a bot while it has a running/queued task (check get_bot_status first).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            bot_name: { type: 'string' },
            task: { type: 'string', description: 'Task key from list_tasks, e.g. "mining".' },
            args: { type: 'object', description: 'Field values from that task\'s definition in list_tasks, e.g. {"ore": "iron ore", "disposal": "bank"}.' },
        },
        required: ['bot_name', 'task'],
        additionalProperties: false,
    },
};

export const getBotStatusTool = {
    name: 'get_bot_status',
    description:
        'Full status for a bot: live position/HP/skills/inventory (if a game client is attached), the status.json written by its current/last task, its task queue, and the bank_cache.json snapshot (bank contents as of the last time a task had the bank open).',
    inputSchema: {
        type: 'object' as const,
        properties: { bot_name: { type: 'string' } },
        required: ['bot_name'],
        additionalProperties: false,
    },
};

export const cancelTaskTool = {
    name: 'cancel_task',
    description: 'Cancel a bot\'s currently running task, or remove a specific still-queued entry by id. Omit queue_id to cancel whatever is currently running.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            bot_name: { type: 'string' },
            queue_id: { type: 'string' },
        },
        required: ['bot_name'],
        additionalProperties: false,
    },
};

export const taskTools = [createBotTool, listTasksTool, enqueueTaskTool, getBotStatusTool, cancelTaskTool];

export function isTaskTool(name: string): boolean {
    return taskTools.some(t => t.name === name);
}

export async function handleTaskTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
        case 'create_bot':
            return callManager('/api/bots', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: args.username, server: args.server, local: args.local }),
            });

        case 'list_tasks':
            return callManager('/api/tasks');

        case 'enqueue_task': {
            const botName = requireString(args, 'bot_name');
            const task = requireString(args, 'task');
            return callManager(`/api/bots/${encodeURIComponent(botName)}/queue`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ task, args: args.args ?? {} }),
            });
        }

        case 'get_bot_status':
            return callManager(`/api/bots/${encodeURIComponent(requireString(args, 'bot_name'))}`);

        case 'cancel_task': {
            const botName = requireString(args, 'bot_name');
            const path = args.queue_id
                ? `/api/bots/${encodeURIComponent(botName)}/queue/${encodeURIComponent(String(args.queue_id))}/cancel`
                : `/api/bots/${encodeURIComponent(botName)}/cancel`;
            return callManager(path, { method: 'POST' });
        }

        default:
            throw new Error(`Unknown task tool: ${name}`);
    }
}
