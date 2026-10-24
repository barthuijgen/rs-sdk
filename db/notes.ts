import { getDb, now } from './client';
import { ensureBot } from './bots';

export interface NoteRow {
    id: number;
    created_at: number;
    author: string | null;
    content: string;
}

export function addBotNote(botId: string, content: string, author?: string): NoteRow {
    ensureBot(botId);
    const created_at = now();
    const result = getDb().run('INSERT INTO bot_notes (bot_id, created_at, author, content) VALUES (?, ?, ?, ?)', [
        botId,
        created_at,
        author ?? null,
        content,
    ]);
    return { id: Number(result.lastInsertRowid), created_at, author: author ?? null, content };
}

export function listBotNotes(botId: string, limit = 50): NoteRow[] {
    return getDb()
        .query<NoteRow, [string, number]>('SELECT id, created_at, author, content FROM bot_notes WHERE bot_id = ? ORDER BY id DESC LIMIT ?')
        .all(botId, limit);
}

export function addFleetNote(fleetId: string, content: string, author?: string): NoteRow {
    const created_at = now();
    const result = getDb().run('INSERT INTO fleet_notes (fleet_id, created_at, author, content) VALUES (?, ?, ?, ?)', [
        fleetId,
        created_at,
        author ?? null,
        content,
    ]);
    return { id: Number(result.lastInsertRowid), created_at, author: author ?? null, content };
}

export function listFleetNotes(fleetId: string, limit = 50): NoteRow[] {
    return getDb()
        .query<NoteRow, [string, number]>('SELECT id, created_at, author, content FROM fleet_notes WHERE fleet_id = ? ORDER BY id DESC LIMIT ?')
        .all(fleetId, limit);
}
