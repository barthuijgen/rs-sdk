// Schema for the shared bot-manager SQLite database. One idempotent
// "create everything if missing" pass - no migration framework yet, since
// there's no prior version to migrate from. Add future changes as more
// `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE` statements here.

import type { Database } from 'bun:sqlite';

export function applySchema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS bots (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            server TEXT,
            goal TEXT,
            fleet_id TEXT REFERENCES fleets(id),
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bot_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id),
            created_at INTEGER NOT NULL,
            author TEXT,
            content TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bot_notes_bot ON bot_notes(bot_id, created_at);

        CREATE TABLE IF NOT EXISTS fleets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            goal TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS fleet_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fleet_id TEXT NOT NULL REFERENCES fleets(id),
            created_at INTEGER NOT NULL,
            author TEXT,
            content TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fleet_notes_fleet ON fleet_notes(fleet_id, created_at);

        CREATE TABLE IF NOT EXISTS status (
            bot_id TEXT PRIMARY KEY REFERENCES bots(id),
            data TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bank_snapshot (
            bot_id TEXT PRIMARY KEY REFERENCES bots(id),
            updated_at INTEGER NOT NULL,
            items TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            bot_id TEXT NOT NULL REFERENCES bots(id),
            task TEXT NOT NULL,
            args TEXT NOT NULL,
            status TEXT NOT NULL,
            triggered_by TEXT,
            enqueued_at INTEGER NOT NULL,
            started_at INTEGER,
            finished_at INTEGER,
            pid INTEGER,
            exit_code INTEGER,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_runs_bot ON runs(bot_id, enqueued_at);

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id),
            run_id TEXT REFERENCES runs(id),
            ts INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_bot ON events(bot_id, ts);

        CREATE TABLE IF NOT EXISTS actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id),
            run_id TEXT REFERENCES runs(id),
            source TEXT NOT NULL,
            method TEXT NOT NULL,
            args TEXT,
            result TEXT,
            success INTEGER,
            error TEXT,
            started_at INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_actions_bot ON actions(bot_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_actions_run ON actions(run_id);

        CREATE TABLE IF NOT EXISTS subscriptions (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            event_type TEXT NOT NULL,
            bot_id TEXT,
            fleet_id TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pending_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
            bot_id TEXT,
            fleet_id TEXT,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            acked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_pending_unacked ON pending_notifications(acked_at);
    `);

    // `desired_running` predates a single CREATE TABLE above and SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, so check first - whether this bot's game
    // client (lite runner, auto-managed) should be kept connected. Set via
    // the dashboard/API's Start/Stop; reconciled by manager/clientRegistry.ts.
    const botsColumns = db.query<{ name: string }, []>("PRAGMA table_info(bots)").all();
    if (!botsColumns.some(c => c.name === 'desired_running')) {
        db.exec('ALTER TABLE bots ADD COLUMN desired_running INTEGER NOT NULL DEFAULT 0');
    }
}
