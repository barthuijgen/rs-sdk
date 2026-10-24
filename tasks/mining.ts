// Mining: either benchmarks whatever ore types are reachable nearby (and
// within the current Mining level), spending `benchmarkMs` on each to
// measure xp/hr before settling on the best one, OR - given `targetOre` -
// skips benchmarking and mines that ore type for the whole run, using
// tasks/lib/sites.ts to know where it's found and which bank to use - no
// coordinates need to be passed on the command line for a known ore. Need
// more than one ore (e.g. copper + tin for bronze bars, see
// tasks/smithing.ts)? Queue separate mining runs, one per ore.
// `targetQuantity`, if set, stops mining once that many are accounted for,
// instead of running until `maxMs`. With disposal='bank', that count
// includes whatever's already in the bank per tasks/lib/bankCache.ts's last
// snapshot - a restarted process picks up near where the last one left off
// rather than re-mining from 0 every time (see the comment at its use
// below). With disposal='drop' there's nothing to resume from, so it's a
// plain this-run action count.
//
// Disposal strategy is configurable: 'drop' (default) frees a slot the
// moment it's full with no travel, at the real cost of one server
// round-trip per item (~4-8s each when the server's under load - measured
// live, see tasks/README.md). 'bank' pays a one-off walk instead, which can
// be cheaper overall for a long run even though it costs more up front -
// this is itself worth benchmarking per location, not assumed. Use 'bank'
// when the ore itself is the goal (e.g. smithing materials) - 'drop'
// discards it.
//
// Standalone: bun tasks/mining.ts <botname> [--ore="iron ore"] [--targetQuantity=100]
//             [--disposal=drop|bank] [--bankSpot=x,z] [--rockSpot=x,z]
//             [--benchmarkMs=60000] [--maxMs=3600000]
//   (--bankSpot/--rockSpot override the site tasks/lib/sites.ts picks for
//   --ore automatically; only needed for a location not in that table yet)
// As a library: import { runMiningTask } from './mining'.

import { runScript, type ScriptContext } from '../sdk/runner';
import { newStatus, writeStatus, logEvent, type TaskStatus } from './lib/status';
import { newFailureStreak, recordFailure, recordSuccess, newStaleStreak, checkClientHealth } from './lib/guard';
import { escapeRegExp, ensureBankSpace, depositAllExcept } from './lib/bank';
import { cachedBankCount, writeBankCacheFromLive } from './lib/bankCache';
import { fastWalkTo } from './lib/fastWalk';
import { ORE_LEVEL_REQ, MINING_SITES, findMiningSite } from './lib/sites';

/** "Rocks clay ore" -> "clay ore", "Rocks clay" -> "clay". A bare "Rocks"
 * (depleted, no ore name) has nothing after "Rocks " and returns null. */
function oreKeyFromRockName(name: string): string | null {
    const m = /^rocks\s+(.+)$/i.exec(name.trim());
    return m ? m[1].toLowerCase() : null;
}

export interface MiningBenchmarkOptions {
    /** How long to measure each ore type before moving to the next. Ignored
     * when `targetOre` is set - benchmarking is skipped entirely. */
    benchmarkMs?: number;
    /** Overall safety valve covering both the benchmark phase and the
     * settle-on-the-best phase that follows it. */
    maxMs?: number;
    /** Mine exactly this ore type (e.g. "iron ore") for the whole run -
     * skipping the discover-and-benchmark phase. Must be a rock name
     * fragment matching "Rocks <ore>", and the bot must already meet its
     * level requirement. */
    targetOre?: string;
    /** Stop mining once this many have been mined this run (not counting
     * whatever's already banked). Unbounded (runs to `maxMs`) if omitted. */
    targetQuantity?: number;
    /** 'drop' (default) or 'bank' when the inventory fills. */
    disposal?: 'drop' | 'bank';
    /** Only used when disposal is 'bank'. Defaults to the bank
     * tasks/lib/sites.ts's MINING_SITES lists for `targetOre`. */
    bankSpot?: { x: number; z: number };
    /** Where to walk back to when no reachable rock of the target ore type
     * is nearby - most commonly needed right after a bank trip. Defaults to
     * the site tasks/lib/sites.ts's MINING_SITES lists for `targetOre`. Uses
     * fastWalkTo (see tasks/lib/fastWalk.ts) since this is exactly the
     * long-distance case that makes bot.walkTo slow. */
    rockSpot?: { x: number; z: number };
}

interface BenchResult {
    xpGained: number;
    actions: number;
    xpPerHour: number;
}

export async function runMiningTask(
    ctx: ScriptContext,
    botName: string,
    status: TaskStatus,
    opts: MiningBenchmarkOptions = {},
): Promise<void> {
    const { bot, sdk } = ctx;
    const benchmarkMs = opts.benchmarkMs ?? 60_000;
    const deadline = Date.now() + (opts.maxMs ?? 60 * 60_000);
    const disposal = opts.disposal ?? 'drop';
    // The site table already knows where each ore is found and which bank
    // serves it, re-resolved below once `targetOre` is known - these are
    // just the startup defaults for benchmark mode, where there's no single
    // target ore to look up yet.
    let bankSpot = opts.bankSpot ?? MINING_SITES[0]!.bankSpot;
    let rockSpot = opts.rockSpot ?? MINING_SITES[0]!.spot;
    const errorStreak = newFailureStreak();
    const staleStreak = newStaleStreak();

    // mineRock() has no shortage check of its own - without a pickaxe it
    // just comes back rejected with "need a pickaxe"/"do not have a
    // pickaxe" game text forever. Bank storage is shared across every
    // branch, so any reachable bank works regardless of which ore's site
    // we're about to mine at - this doesn't need to match `bankSpot` for a
    // specific ore.
    async function ensurePickaxe(dest: { x: number; z: number }): Promise<boolean> {
        if (sdk.findInventoryItem(/pickaxe/i)) return true;

        status.lastAction = 'no pickaxe in inventory - checking the bank';
        writeStatus(botName, status);
        logEvent(botName, { task: 'mining', event: 'pickaxe_missing' });

        const walked = await fastWalkTo(bot, sdk, dest.x, dest.z).catch(err => ({ success: false, message: String(err) }));
        if (!walked.success) {
            status.needsAttention = true;
            status.lastError = `No pickaxe and could not reach the bank at (${dest.x}, ${dest.z}): ${walked.message}`;
            writeStatus(botName, status);
            logEvent(botName, { task: 'mining', level: 'error', msg: 'pickaxe_bank_unreachable' });
            return false;
        }

        const opened = await bot.openBank();
        if (!opened.success) {
            status.needsAttention = true;
            status.lastError = `No pickaxe and bank open failed: ${opened.message}`;
            writeStatus(botName, status);
            logEvent(botName, { task: 'mining', level: 'error', msg: 'pickaxe_bank_open_failed' });
            return false;
        }

        // Already at the bank for the pickaxe - clear out anything else
        // this run doesn't need (ore from a prior session, starter junk,
        // etc.) instead of walking back out still carrying it.
        await depositAllExcept(bot, sdk, [/pickaxe/i], msg =>
            logEvent(botName, { task: 'mining', level: 'warn', msg: `pickaxe-trip deposit: ${msg}` }),
        );

        const withdrawn = await bot.withdrawItem(/pickaxe/i, 1).catch(err => ({ success: false, message: String(err) }) as const);
        writeBankCacheFromLive(botName, sdk);
        await bot.closeBank();

        if (!withdrawn.success) {
            status.needsAttention = true;
            status.lastError = `No pickaxe in inventory or bank: ${withdrawn.message}`;
            writeStatus(botName, status);
            logEvent(botName, { task: 'mining', level: 'error', msg: 'no_pickaxe_available' });
            return false;
        }

        status.lastAction = 'withdrew a pickaxe from the bank';
        writeStatus(botName, status);
        logEvent(botName, { task: 'mining', event: 'pickaxe_withdrawn' });
        return true;
    }

    function discoverCandidates(): string[] {
        const state = sdk.getState();
        if (!state) return [];
        const miningLevel = sdk.getSkill('Mining')?.baseLevel ?? 1;
        const seen = new Set<string>();
        for (const loc of state.nearbyLocs) {
            const key = oreKeyFromRockName(loc.name);
            if (!key) continue;
            if (!loc.optionsWithIndex.some(o => /^mine$/i.test(o.text))) continue;
            if (loc.reachable === false) continue;
            const req = ORE_LEVEL_REQ[key] ?? 1;
            if (req > miningLevel) continue;
            seen.add(key);
        }
        return [...seen];
    }

    async function clearInventoryIfFull(): Promise<void> {
        if (sdk.getInventory().length < 28) return;

        if (disposal === 'bank') {
            await ensureBankSpace(bot, sdk, botName, status, {
                keep: [/pickaxe/i],
                taskLabel: 'mining',
                bankSpot,
            });
            // ensureBankSpace already sets needsAttention and logs on
            // repeated failure - nothing more to do here either way.
            return;
        }

        status.lastAction = 'inventory full, dropping ore';
        writeStatus(botName, status);
        const dropped = await bot.dropItem(/ore$|^clay$/i, 'all');
        if (!dropped.success) {
            logEvent(botName, { task: 'mining', level: 'warn', msg: `drop failed: ${dropped.message}` });
        }
    }

    /** Mine one ore type for up to `durationMs` (or until `maxActions` is
     * reached, whichever comes first), disposing per `disposal`. Returns xp
     * gained and successful mines - the caller computes the rate, since a
     * benchmark window, a quantity-targeted run, and the final open-ended
     * run all share this loop but want different things done with the
     * result. */
    async function mineFor(oreKey: string, durationMs: number, maxActions?: number): Promise<{ xpGained: number; actions: number }> {
        const startXp = sdk.getSkillXp('Mining') ?? 0;
        let actions = 0;
        let noRockStreak = 0;
        let fallbackWalkFailStreak = 0;
        const until = Math.min(Date.now() + durationMs, deadline);
        const rockPattern = new RegExp(`^rocks\\s+${escapeRegExp(oreKey)}$`, 'i');
        // Stick with whichever rock we're already working rather than
        // re-picking "nearest" every iteration - a depleted rock elsewhere
        // can respawn mid-swing on our current one and become the new
        // "nearest", which would otherwise yank us off an unfinished rock
        // and back onto the one we just left (x/z identify a rock instance;
        // locs don't move, and a depleted rock's name drops the ore suffix
        // so rockPattern stops matching it here automatically).
        let currentSpot: { x: number; z: number } | null = null;

        while (Date.now() < until && (maxActions === undefined || actions < maxActions)) {
            status.iteration++;
            const state = sdk.getState();
            if (!state) {
                await sdk.waitForTicks(1);
                continue;
            }

            const health = await checkClientHealth(botName, status, 'mining', sdk, staleStreak);
            if (health === 'stop') break;
            if (health === 'skip') continue;

            // No explicit dialog dismiss here - bot.mineRock() (and every
            // bot.* action) auto-dismisses blocking UI before executing
            // (see CLAUDE.md). A separate dismiss-then-continue step here
            // pays for a second, fully redundant dismiss cycle on top of
            // the one mineRock() does anyway - measured live at 6.8s for a
            // single level-up dialog under current server load, which this
            // demo server's fast Mining XP triggers on almost every mine.
            // See tasks/README.md "Lessons learned".

            await clearInventoryIfFull();
            if (status.needsAttention) break; // bank disposal gave up - stop this mining window

            const matching = state.nearbyLocs
                .filter(l => rockPattern.test(l.name))
                .filter(l => l.reachable !== false);
            const current = currentSpot
                ? matching.find(l => l.x === currentSpot!.x && l.z === currentSpot!.z)
                : undefined;
            const rock = current ?? matching.sort((a, b) => a.distance - b.distance)[0];
            currentSpot = rock ? { x: rock.x, z: rock.z } : null;

            if (!rock) {
                noRockStreak++;
                status.lastAction = `no reachable "${oreKey}" rock nearby (${noRockStreak})`;
                writeStatus(botName, status);
                // Most commonly hit right after a bank trip, which can be
                // 60+ tiles from the rocks - walk back instead of waiting
                // forever. fastWalkTo, not bot.walkTo: this is exactly the
                // long-distance case tasks/lib/fastWalk.ts exists for.
                if (noRockStreak === 5) {
                    status.lastAction = `no "${oreKey}" rock nearby, walking back to (${rockSpot.x}, ${rockSpot.z})`;
                    writeStatus(botName, status);
                    logEvent(botName, { task: 'mining', event: 'walk_to_rocks', spot: rockSpot });
                    // Checked, not swallowed - see tasks/README.md "Lessons
                    // learned" (fastWalkTo resolves success:false rather
                    // than throwing when it genuinely can't get there, e.g.
                    // a closed door mid-route; a bare .catch() never sees
                    // that).
                    const walked = await fastWalkTo(bot, sdk, rockSpot.x, rockSpot.z, {
                        onProgress: msg => logEvent(botName, { task: 'mining', event: 'walk_progress', msg }),
                    }).catch(err => ({ success: false, message: String(err) }));
                    if (walked.success) {
                        fallbackWalkFailStreak = 0;
                    } else {
                        fallbackWalkFailStreak++;
                        status.lastAction = `walk back to rocks failed (${fallbackWalkFailStreak}): ${walked.message}`;
                        writeStatus(botName, status);
                        logEvent(botName, { task: 'mining', level: 'warn', msg: `walk back to rocks failed: ${walked.message}` });
                        if (fallbackWalkFailStreak >= 10) {
                            status.needsAttention = true;
                            status.lastError = `Could not reach the rocks after ${fallbackWalkFailStreak} attempts: ${walked.message}`;
                            writeStatus(botName, status);
                            logEvent(botName, { task: 'mining', level: 'error', msg: 'fallback_walk_unreachable' });
                            break;
                        }
                    }
                    noRockStreak = 0;
                } else {
                    await sdk.waitForTicks(2);
                }
                continue;
            }
            noRockStreak = 0;

            try {
                const result = await bot.mineRock(rock);
                recordSuccess(errorStreak);
                if (result.success) {
                    actions++;
                    status.actionsCompleted++;
                    status.lastAction = `mined ${oreKey} #${actions}`;
                    logEvent(botName, { task: 'mining', event: 'mine', ore: oreKey, count: actions });
                } else {
                    status.lastAction = `mine failed (${oreKey}): ${result.message}`;
                    logEvent(botName, { task: 'mining', level: 'warn', msg: result.message, ore: oreKey, reason: result.reason });
                }
            } catch (err) {
                const canContinue = await recordFailure(botName, status, 'mining', err, errorStreak);
                if (!canContinue) break;
                continue;
            }

            status.skills = { Mining: { level: sdk.getSkill('Mining')?.baseLevel ?? 1, xp: sdk.getSkillXp('Mining') ?? 0 } };
            writeStatus(botName, status);
        }

        return { xpGained: (sdk.getSkillXp('Mining') ?? 0) - startXp, actions };
    }

    if (opts.targetOre) {
        const ore = opts.targetOre.trim().toLowerCase();
        const miningLevel = sdk.getSkill('Mining')?.baseLevel ?? 1;
        const req = ORE_LEVEL_REQ[ore];
        if (req !== undefined && req > miningLevel) {
            status.needsAttention = true;
            status.lastError = `Mining level ${miningLevel} is below the requirement (${req}) for "${ore}"`;
            writeStatus(botName, status);
            logEvent(botName, { task: 'mining', level: 'error', msg: 'target_ore_too_high_level', ore, req, miningLevel });
            return;
        }

        const site = findMiningSite(ore);
        bankSpot = opts.bankSpot ?? site?.bankSpot ?? MINING_SITES[0]!.bankSpot;
        rockSpot = opts.rockSpot ?? site?.spot ?? MINING_SITES[0]!.spot;

        if (!(await ensurePickaxe(bankSpot))) return;

        // A per-process action count alone resets to 0 on every restart -
        // and this task gets restarted often (see tasks/README.md "Lessons
        // learned" #8, needsAttention, a dead gateway...). With
        // disposal=bank, what's already banked (tasks/lib/bankCache.ts - a
        // disk snapshot taken on the last real bank trip, so this needs no
        // bank visit of its own) counts toward the target, so a restart
        // picks up near where the last process left off instead of back at
        // 0. Does nothing for disposal=drop, since dropped ore leaves no
        // record anywhere to resume from.
        let remainingTarget = opts.targetQuantity;
        if (remainingTarget !== undefined && disposal === 'bank') {
            const alreadyBanked = cachedBankCount(botName, new RegExp(`^${escapeRegExp(ore)}$`, 'i'));
            remainingTarget = Math.max(0, remainingTarget - alreadyBanked);
            if (remainingTarget === 0) {
                status.lastAction = `already have ${alreadyBanked} "${ore}" banked (target ${opts.targetQuantity}) - done`;
                writeStatus(botName, status);
                logEvent(botName, { task: 'mining', event: 'target_already_met', ore, alreadyBanked, targetQuantity: opts.targetQuantity });
                return;
            }
        }

        status.lastAction = `mining "${ore}" (${disposal}, target ${opts.targetQuantity ?? 'unbounded'}${remainingTarget !== opts.targetQuantity ? `, ${remainingTarget} left` : ''})`;
        writeStatus(botName, status);
        logEvent(botName, { task: 'mining', event: 'target_ore_start', ore, disposal, targetQuantity: opts.targetQuantity, remainingTarget });

        const { xpGained, actions } = await mineFor(ore, deadline - Date.now(), remainingTarget);
        logEvent(botName, { task: 'mining', event: 'task_complete', ore, xpGained, actions });
        status.lastAction = `done with "${ore}" (${xpGained}xp, ${actions} actions)`;
        writeStatus(botName, status);
        return;
    }

    const candidates = discoverCandidates();
    if (candidates.length === 0) {
        status.needsAttention = true;
        status.lastError = 'No mineable rock types found nearby at the current Mining level';
        writeStatus(botName, status);
        logEvent(botName, { task: 'mining', level: 'error', msg: 'no_candidates' });
        return;
    }

    if (!(await ensurePickaxe(bankSpot))) return;

    logEvent(botName, { task: 'mining', event: 'benchmark_start', candidates });
    const results: Record<string, BenchResult> = {};

    for (const ore of candidates) {
        if (Date.now() >= deadline) break;
        status.lastAction = `benchmarking "${ore}" for ${(benchmarkMs / 1000).toFixed(0)}s`;
        writeStatus(botName, status);

        const { xpGained, actions } = await mineFor(ore, benchmarkMs);
        const xpPerHour = (xpGained / benchmarkMs) * 3_600_000;
        results[ore] = { xpGained, actions, xpPerHour };

        logEvent(botName, {
            task: 'mining',
            event: 'benchmark_result',
            ore,
            xpGained,
            actions,
            xpPerHour: Math.round(xpPerHour),
        });
        status.lastAction = `benchmarked "${ore}": ${Math.round(xpPerHour)} xp/hr (${actions} mined, ${xpGained}xp)`;
        writeStatus(botName, status);

        if (status.needsAttention) return; // checkClientHealth gave up mid-benchmark
    }

    const ranked = Object.entries(results).sort((a, b) => b[1].xpPerHour - a[1].xpPerHour);
    if (ranked.length === 0 || ranked[0][1].xpPerHour <= 0) {
        status.needsAttention = true;
        status.lastError = 'Every candidate ore benchmarked at 0 xp/hr - nothing worth committing to';
        writeStatus(botName, status);
        logEvent(botName, { task: 'mining', level: 'error', msg: 'no_viable_ore', results });
        return;
    }

    const [bestOre, bestResult] = ranked[0];
    logEvent(botName, {
        task: 'mining',
        event: 'best_ore',
        ore: bestOre,
        xpPerHour: Math.round(bestResult.xpPerHour),
        allResults: Object.fromEntries(ranked.map(([k, v]) => [k, Math.round(v.xpPerHour)])),
    });
    status.lastAction = `best ore: "${bestOre}" (${Math.round(bestResult.xpPerHour)} xp/hr) - mining it for the rest of the run`;
    writeStatus(botName, status);

    await mineFor(bestOre, deadline - Date.now());

    status.lastAction = `done - settled on "${bestOre}"`;
    writeStatus(botName, status);
    logEvent(botName, { task: 'mining', event: 'task_complete', finalOre: bestOre, results });
}

if (import.meta.main) {
    const botName = process.argv[2];
    if (!botName) {
        console.error(
            'Usage: bun tasks/mining.ts <botname> [--ore="iron ore"] ' +
            '[--targetQuantity=100] [--disposal=drop|bank] ' +
            '[--bankSpot=x,z] [--rockSpot=x,z] [--benchmarkMs=60000] [--maxMs=3600000] [--embedded]'
        );
        process.exit(1);
    }
    const argVal = (flag: string) => process.argv.find(a => a.startsWith(flag))?.split('=')[1];

    const oreArg = argVal('--ore=');
    const disposalArg = argVal('--disposal=');
    if (disposalArg && disposalArg !== 'drop' && disposalArg !== 'bank') {
        console.error(`--disposal must be "drop" or "bank", got "${disposalArg}"`);
        process.exit(1);
    }
    const bankSpotArg = argVal('--bankSpot=');
    const bankSpot = bankSpotArg
        ? (() => {
              const [x, z] = bankSpotArg.split(',').map(Number);
              return { x, z };
          })()
        : undefined;
    const rockSpotArg = argVal('--rockSpot=');
    const rockSpot = rockSpotArg
        ? (() => {
              const [x, z] = rockSpotArg.split(',').map(Number);
              return { x, z };
          })()
        : undefined;
    const benchArg = argVal('--benchmarkMs=');
    const maxArg = argVal('--maxMs=');
    const targetQuantityArg = argVal('--targetQuantity=');
    const embedded = process.argv.includes('--embedded');

    const runTask = async (ctx: { bot: import('../sdk/actions').BotActions; sdk: any }) => {
        const label = oreArg ? `mining-${oreArg}` : 'mining-benchmark';
        const status = newStatus(botName, [label]);
        status.currentTask = label;
        writeStatus(botName, status);
        await runMiningTask(ctx, botName, status, {
            targetOre: oreArg,
            targetQuantity: targetQuantityArg ? parseInt(targetQuantityArg, 10) : undefined,
            disposal: disposalArg as 'drop' | 'bank' | undefined,
            bankSpot,
            rockSpot,
            benchmarkMs: benchArg ? parseInt(benchArg, 10) : undefined,
            maxMs: maxArg ? parseInt(maxArg, 10) : undefined,
        });
        status.currentTask = null;
        status.done = true;
        writeStatus(botName, status);
    };

    if (embedded) {
        // No gateway, no browser - direct, fast engine connection. See
        // tasks/README.md "Embedded engine". Nothing else can be watching
        // or controlling this account while this runs; bots/<name>/view.txt
        // gets a crude text snapshot refreshed every second instead.
        const { runEmbedded } = await import('./lib/embeddedRunner');
        await runEmbedded(botName, runTask);
    } else {
        await runScript(runTask, { disconnectAfter: true, printState: false });
    }
    // A finished/errored run must release the control connection, not hang
    // forever holding it - see tasks/README.md "Lessons learned".
    process.exit();
}
