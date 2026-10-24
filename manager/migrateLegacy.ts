// One-time best-effort import from the old bots/*/ JSON files into the
// shared SQLite DB, run once at daemon startup. Only touches a bot folder
// that has no DB row yet, so it never clobbers anything already recorded
// there. queue.json/run.log.jsonl/task-runs.log history is deliberately NOT
// imported (disposable operational logs) - old files are left on disk
// untouched, just no longer written to.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { listBotNames, readBotEnv } from './botRegistry';
import { getBot, ensureBot } from '../db/bots';
import { setStatus } from '../db/status';
import { setBankSnapshot } from '../db/bank';
import { addBotNote } from '../db/notes';

function botsDir(): string {
    return join(import.meta.dir, '..', 'bots');
}

function readJson(path: string): unknown | null {
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
        return null;
    }
}

export function migrateLegacyFiles(): void {
    for (const botName of listBotNames()) {
        if (getBot(botName)) continue; // already migrated / already active

        const env = readBotEnv(botName);
        ensureBot(botName, { username: env?.username, server: env?.server });
        console.log(`[manager] migrating legacy files for "${botName}"...`);

        const status = readJson(join(botsDir(), botName, 'status.json'));
        if (status) setStatus(botName, status);

        const bankCache = readJson(join(botsDir(), botName, 'bank_cache.json')) as { items?: Record<string, number> } | null;
        if (bankCache?.items) setBankSnapshot(botName, bankCache.items);

        const labLogPath = join(botsDir(), botName, 'lab_log.md');
        if (existsSync(labLogPath)) {
            const content = readFileSync(labLogPath, 'utf-8').trim();
            if (content) addBotNote(botName, content, 'migrated from lab_log.md');
        }
    }
}
