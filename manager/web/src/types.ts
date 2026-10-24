// Mirrors the shapes manager/queue.ts, manager/taskRegistry.ts and
// manager/botRegistry.ts send over the API. Kept as plain types here (not
// imported from the server) since those files pull in `fs`/`path`, which
// don't exist in the browser.

export interface SkillSnapshot {
    level: number;
    xp: number;
}

export interface TaskHistoryEntry {
    task: string;
    result: 'complete' | 'error';
    durationMs: number;
    finishedAt: number;
}

export interface TaskStatus {
    bot: string;
    plan: string[];
    planIndex: number;
    currentTask: string | null;
    startedAt: number;
    taskStartedAt: number;
    updatedAt: number;
    iteration: number;
    actionsCompleted: number;
    bankTrips: number;
    skills: Record<string, SkillSnapshot>;
    lastAction: string;
    lastError: string | null;
    needsAttention: boolean;
    done: boolean;
    history: TaskHistoryEntry[];
}

export type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

// Mirrors db/runs.ts's ApiRun - snake_case, matching the SQLite row shape
// directly (manager/daemon.ts only reshapes `args` back into an array).
export interface RunRow {
    id: string;
    bot_id: string;
    task: string;
    args: string[];
    status: RunStatus;
    triggered_by: string | null;
    enqueued_at: number;
    started_at: number | null;
    finished_at: number | null;
    pid: number | null;
    exit_code: number | null;
    error: string | null;
}

export interface BotRuns {
    running: RunRow | null;
    queued: RunRow[];
    history: RunRow[];
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

export type GatewayClientKind = 'web' | 'lite' | null;

export interface ClientStatus {
    desiredRunning: boolean;
    managed: boolean;
    gateway: 'active' | 'stale' | 'dead' | 'unknown';
    attachedKind: GatewayClientKind;
    gatewayError: string | null;
    lastExitCode: number | null;
    lastExitAt: number | null;
    spawnError: string | null;
    logPath: string;
}

export interface NoteRow {
    id: number;
    created_at: number;
    author: string | null;
    content: string;
}

export interface ActionRow {
    id: number;
    bot_id: string;
    run_id: string | null;
    source: 'task' | 'execute_code';
    method: string;
    args: string | null;
    result: string | null;
    success: number | null;
    error: string | null;
    started_at: number;
    duration_ms: number;
}

export interface FleetRow {
    id: string;
    name: string;
    goal: string | null;
    created_at: number;
}

export interface BotRow {
    id: string;
    username: string;
    server: string | null;
    goal: string | null;
    fleet_id: string | null;
    created_at: number;
    desired_running: number;
}

export interface FleetWithMembers extends FleetRow {
    members: BotRow[];
}

export type NotificationEventType = 'needs_attention' | 'run_done' | 'run_error' | 'note_added';

export interface PendingNotification {
    id: number;
    subscription_id: string;
    bot_id: string | null;
    fleet_id: string | null;
    event_type: NotificationEventType;
    payload: string;
    created_at: number;
    acked_at: number | null;
}

export interface SubscriptionRow {
    id: string;
    label: string;
    event_type: NotificationEventType;
    bot_id: string | null;
    fleet_id: string | null;
    created_at: number;
}

export interface BankCache {
    updatedAt: number;
    items: Record<string, number>;
}

export interface InventoryItem {
    slot: number;
    id: number;
    name: string;
    count: number;
}

export interface PlayerState {
    name: string;
    hp: number;
    maxHp: number;
    combatLevel: number;
    x: number;
    z: number;
    [key: string]: unknown;
}

export interface BotWorldState {
    tick: number;
    inGame: boolean;
    player: PlayerState | null;
    skills: { name: string; baseLevel: number; level: number; experience: number }[];
    inventory: InventoryItem[];
    bank: { isOpen: boolean; items: InventoryItem[] };
    [key: string]: unknown;
}

export type LiveState = { state: BotWorldState; stateAge: number } | { error: string };

export interface BotDetail {
    name: string;
    username: string;
    server?: string;
    goal: string | null;
    fleetId: string | null;
    status: TaskStatus | null;
    queue: BotRuns;
    bankCache: BankCache | null;
    notes: NoteRow[];
    live: LiveState;
}

export type TaskFieldType = 'number' | 'string' | 'select' | 'coords' | 'boolean';

export interface TaskFieldOption {
    value: string;
    label: string;
}

export interface TaskField {
    name: string;
    flag: string;
    label: string;
    type: TaskFieldType;
    default?: string | number | boolean;
    options?: TaskFieldOption[];
}

export interface TaskDef {
    key: string;
    label: string;
    description: string;
    scriptPath: string;
    fields: TaskField[];
}
