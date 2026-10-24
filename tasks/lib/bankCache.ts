// Disk-persisted snapshot of bank contents. `sdk.getBankItems()` only answers
// while `state.bank.isOpen` (sdk/index.ts) - the moment a task closes the
// bank, "how much X do I already have banked?" becomes unanswerable without
// walking back and reopening it. This cache keeps the last live snapshot
// around (now in the shared SQLite DB, see db/bank.ts) so a task (including
// a freshly-restarted process, which starts with none of the in-memory
// progress its previous run had) can read a recent answer for free. It's a
// snapshot, not a ledger - it can lag behind the real bank by up to one
// un-banked inventory if the process died between deposits, which is an
// acceptable approximation for the restart-resilience use (see
// tasks/mining.ts's targetQuantity handling), not a source of truth for
// anything that needs an exact count right now.
//
// Exported names/shapes are unchanged from the old file-backed version, so
// every existing caller (tasks/lib/bank.ts, tasks/mining.ts,
// manager/botRegistry.ts) needed no changes.

import type { BotSDK } from '../../sdk/index';
import { getBankSnapshot, setBankSnapshot } from '../../db/bank';

export interface BankCache {
    updatedAt: number;
    items: Record<string, number>; // lowercased item name -> total count across all slots
}

export function readBankCache(botName: string): BankCache | null {
    return getBankSnapshot(botName);
}

/** Snapshot the currently-open bank to disk. No-ops if the bank isn't open -
 * callers should invoke this while they already have it open for a deposit/
 * withdraw, not open the bank just to refresh the cache. */
export function writeBankCacheFromLive(botName: string, sdk: BotSDK): void {
    if (!sdk.isBankOpen()) return;
    const items: Record<string, number> = {};
    for (const item of sdk.getBankItems()) {
        const key = item.name.toLowerCase();
        items[key] = (items[key] ?? 0) + item.count;
    }
    setBankSnapshot(botName, items);
}

/** Cached count of items matching `pattern`, summed across matching names.
 * Returns 0 (never null) when there's no cache yet or nothing matches -
 * callers use this as a baseline to add to, not as a presence check. */
export function cachedBankCount(botName: string, pattern: RegExp): number {
    const cache = readBankCache(botName);
    if (!cache) return 0;
    return Object.entries(cache.items)
        .filter(([name]) => pattern.test(name))
        .reduce((sum, [, count]) => sum + count, 0);
}
