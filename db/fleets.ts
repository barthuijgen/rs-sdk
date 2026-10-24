import { randomUUID } from 'crypto';
import { getDb, now } from './client';
import { listBotsByFleet, type BotRow } from './bots';

export interface FleetRow {
    id: string;
    name: string;
    goal: string | null;
    created_at: number;
}

export interface FleetWithMembers extends FleetRow {
    members: BotRow[];
}

export function createFleet(name: string, goal?: string | null): FleetRow {
    const row: FleetRow = { id: randomUUID(), name, goal: goal ?? null, created_at: now() };
    getDb().run('INSERT INTO fleets (id, name, goal, created_at) VALUES (?, ?, ?, ?)', [row.id, row.name, row.goal, row.created_at]);
    return row;
}

export function listFleets(): FleetRow[] {
    return getDb().query<FleetRow, []>('SELECT * FROM fleets ORDER BY created_at').all();
}

export function getFleet(id: string): FleetRow | null {
    return getDb().query<FleetRow, [string]>('SELECT * FROM fleets WHERE id = ?').get(id) ?? null;
}

export function getFleetWithMembers(id: string): FleetWithMembers | null {
    const fleet = getFleet(id);
    if (!fleet) return null;
    return { ...fleet, members: listBotsByFleet(id) };
}

export function setFleetGoal(id: string, goal: string | null): void {
    getDb().run('UPDATE fleets SET goal = ? WHERE id = ?', [goal, id]);
}
