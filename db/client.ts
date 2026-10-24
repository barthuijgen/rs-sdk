// Single shared bun:sqlite connection for everything that used to live under
// bots/*/ as JSON files. Any process - the manager daemon, a spawned task
// script, or a bare `bun tasks/x.ts` run with no daemon involved at all -
// opens the same file and gets a working, schema-ready connection.

import { Database } from 'bun:sqlite';
import { dirname, join, isAbsolute } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { applySchema } from './schema';

function repoRoot(): string {
    return join(import.meta.dir, '..');
}

function dbPath(): string {
    const configured = process.env.MANAGER_DB_PATH;
    if (configured) return isAbsolute(configured) ? configured : join(repoRoot(), configured);
    return join(repoRoot(), 'data', 'manager.sqlite');
}

let db: Database | null = null;

export function getDb(): Database {
    if (db) return db;
    const path = dbPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new Database(path, { create: true });
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    applySchema(db);
    return db;
}

export function now(): number {
    return Date.now();
}
