// Long-distance walking, optimized for exactly the case that makes
// bot.walkTo() slow under server latency: it re-dispatches sendWalk() for
// EVERY dense waypoint in the pathfinder's result (sdk.sendFindPath()
// returns roughly one waypoint per tile - see sdk/pathfinding.ts's
// findLongPath), each followed by a full wait-for-arrival. A 130-tile walk
// is ~130 separate network round-trips, each costing multiple seconds under
// current server load - this is the "moves a few tiles, waits, moves a few
// more" behavior observed live.
//
// It doesn't need to be that chatty. A single sendWalk() click can reach up
// to the edge of the client's loaded scene - about 100 tiles (see
// walkTo()'s maxBound=102 in server/webclient/src/client/Client.ts) - and
// the character then walks there continuously, tick by tick, with ZERO
// further packets needed, exactly like a real player's minimap click.
// Confirmed live: one sendWalk() toward a point 50 tiles away produced
// continuous multi-tile movement across 8 polls with no re-dispatch at all.
//
// fastWalkTo() exploits this: compute the path once, send ONE sendWalk per
// ~80-tile leg (margin below the ~100-tile clamp) and POLL for progress
// instead of re-dispatching per tile, then hand off to the existing
// bot.walkTo() for the final short approach, where its door/obstacle
// handling matters far more than raw distance per click.
//
// This is a standalone utility, not a patch to sdk/actions.ts's walkTo() -
// that method is shared by everything in the codebase and its tile-by-tile
// carefulness is almost certainly deliberate for door/collision edge cases.
// A bug report should flag the inefficiency; this is the workaround to use
// meanwhile (see CLAUDE.md "Reporting SDK Bugs" - find a workaround first).

import type { BotActions } from '../../sdk/actions';
import type { BotSDK } from '../../sdk/index';
import type { ActionResult } from '../../sdk/types';

const LEG_TILES = 80;
// Experiment: was 20 (hand off to chunkedWalkTo/bot.walkTo for the final
// approach on the theory that short-range door handling matters more than
// raw click-count that close in). In-game auto-pathing already walks the
// last stretch fine on its own, and a door is no more likely in the last 20
// tiles than anywhere else along the route - so disabled (0) to let the
// long-range leg loop run all the way to the tolerance check. The stall
// (STALL_LEGS) and dispatch-failure fallbacks below still catch a genuinely
// blocked finish and hand off to chunkedWalkTo then.
const FINAL_APPROACH_TILES = 0;
const POLL_TICKS = 3;
const MAX_LEGS = 40;
const STALL_LEGS = 2; // consecutive legs with no real progress before falling back

// bot.walkTo() gives up on a single call after 3 consecutive waypoint-steps
// with no improvement (see sdk/actions.ts's "Stuck at" check) - a budget
// meant for a genuinely blocked route, but confirmed live to also trip on
// a long route from a momentary hiccup (crowd dodging, a brief pathing
// jitter) part way through, failing the ENTIRE remaining distance - even
// though the exact same route succeeds when split into several shorter
// bot.walkTo() calls, each getting its own fresh 3-strikes budget and a
// freshly re-planned path. One 50-tile call failed instantly with zero
// movement; five chained ~10-tile calls over the identical route all
// succeeded. HOP_TILES below is that chunk size - kept fairly small (not
// just "under the stuck-detection threshold") because a hop also needs to
// land close enough to a gate/door for bot.walkTo's own door-retry to
// reliably trigger before giving up; confirmed live that 12-tile hops
// overshot a real castle gate that ~5-tile hops opened and passed through
// without issue.
const HOP_TILES = 8;

function chebyshev(ax: number, az: number, bx: number, bz: number): number {
    return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

/** bot.walkTo() for a long distance, but hopping through intermediate
 * waypoints every HOP_TILES instead of one call for the whole thing - see
 * the HOP_TILES comment above for why. Used as fastWalkTo's fallback
 * wherever it previously handed the full remaining distance to a single
 * bot.walkTo() call. */
async function chunkedWalkTo(
    bot: BotActions,
    sdk: BotSDK,
    x: number,
    z: number,
    tolerance: number,
    deadline: number,
    log: (msg: string) => void,
): Promise<ActionResult> {
    while (Date.now() < deadline) {
        const state = sdk.getState();
        if (!state?.player) return { success: false, message: 'No in-game player state' };
        const pos = { x: state.player.worldX, z: state.player.worldZ };
        const remaining = chebyshev(pos.x, pos.z, x, z);
        if (remaining <= tolerance) return { success: true, message: 'Arrived' };

        if (remaining <= HOP_TILES) {
            return bot.walkTo(x, z, tolerance);
        }

        const path = await sdk.sendFindPath(x, z, 500);
        if (!path.success || !path.waypoints?.length) {
            return { success: false, message: `No path to (${x}, ${z}) from (${pos.x}, ${pos.z}): ${path.error ?? 'no waypoints'}` };
        }

        // Farthest waypoint still within HOP_TILES, same idea as fastWalkTo's
        // own leg-picking above - but a long unobstructed straight stretch
        // comes back as ONE waypoint at the far end (sendFindPath returns a
        // waypoint per direction change, not per tile, despite this file's
        // header comment assuming the latter), so that waypoint alone can
        // already be the first one in the list and far past HOP_TILES. In
        // that case interpolate a point HOP_TILES along the line toward it
        // instead of jumping straight there - the goal is a short hop, not
        // necessarily landing exactly on a path corner.
        let target = path.waypoints[0]!;
        for (const wp of path.waypoints) {
            if (chebyshev(pos.x, pos.z, wp.x, wp.z) > HOP_TILES) { target = wp; break; }
            target = wp;
        }
        const distToTarget = chebyshev(pos.x, pos.z, target.x, target.z);
        const hop = distToTarget > HOP_TILES
            ? {
                x: Math.round(pos.x + (target.x - pos.x) * (HOP_TILES / distToTarget)),
                z: Math.round(pos.z + (target.z - pos.z) * (HOP_TILES / distToTarget)),
            }
            : target;

        log(`chunkedWalkTo: hopping to (${hop.x}, ${hop.z}) - ${remaining} tiles from destination`);
        const result = await bot.walkTo(hop.x, hop.z, 2);
        if (!result.success) {
            log(`chunkedWalkTo: hop failed (${result.message})`);
            return result;
        }
    }
    return { success: false, message: `chunkedWalkTo timed out heading to (${x}, ${z})`, reason: 'timeout' };
}

export interface FastWalkOptions {
    tolerance?: number;
    /** Overall timeout; passed through to the bot.walkTo() fallback too. */
    timeoutMs?: number;
    onProgress?: (msg: string) => void;
}

/**
 * Walk to (x, z), covering long distance in a handful of far clicks instead
 * of one per tile. Falls back to bot.walkTo() for the final short approach
 * and whenever a long-range leg stops making progress (a door or obstacle
 * mid-route - the short-range walker's door-opening logic handles that
 * better than blindly re-clicking far away would).
 */
export async function fastWalkTo(
    bot: BotActions,
    sdk: BotSDK,
    x: number,
    z: number,
    opts: FastWalkOptions = {},
): Promise<ActionResult> {
    const tolerance = opts.tolerance ?? 3;
    const log = opts.onProgress ?? (() => {});
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);

    const distToDest = (px: number, pz: number) => chebyshev(px, pz, x, z);

    let stallStreak = 0;
    let bestRemaining = Infinity;

    for (let leg = 0; leg < MAX_LEGS; leg++) {
        if (Date.now() > deadline) {
            return { success: false, message: `fastWalkTo timed out heading to (${x}, ${z})`, reason: 'timeout' };
        }

        const state = sdk.getState();
        if (!state?.player) return { success: false, message: 'No in-game player state' };
        const pos = { x: state.player.worldX, z: state.player.worldZ };
        const remaining = distToDest(pos.x, pos.z);

        if (remaining <= tolerance) return { success: true, message: 'Arrived' };

        // Close enough that the short-range walker's per-tile care (doors,
        // precise tolerance) matters more than saving a few long clicks.
        if (remaining <= FINAL_APPROACH_TILES) {
            log(`fastWalkTo: ${remaining} tiles out, handing off to chunkedWalkTo for the final approach`);
            return chunkedWalkTo(bot, sdk, x, z, tolerance, deadline, log);
        }

        const path = await sdk.sendFindPath(x, z, 500);
        if (!path.success || !path.waypoints?.length) {
            return { success: false, message: `No path to (${x}, ${z}) from (${pos.x}, ${pos.z}): ${path.error ?? 'no waypoints'}` };
        }

        // Farthest waypoint still within one leg's click range, not the path
        // tail - a single click can't jump past the loaded scene's edge
        // regardless of how far the full path continues beyond it.
        const pickLegTarget = (maxTiles: number) => {
            let target = path.waypoints[0]!;
            for (const wp of path.waypoints) {
                if (chebyshev(pos.x, pos.z, wp.x, wp.z) > maxTiles) break;
                target = wp;
            }
            return target;
        };

        // A click failing ("outside the current build area") means the
        // chosen point isn't in the client's loaded scene from here - which
        // depends on the path's actual bends, not just chebyshev distance,
        // so a waypoint well under LEG_TILES away can still fail. Retry with
        // closer waypoints on the SAME path a couple of times before paying
        // for the much slower chunkedWalkTo fallback - most of the time a
        // nearer point on the same route succeeds outright.
        let legTarget = pickLegTarget(LEG_TILES);
        let dispatch = await sdk.sendWalk(legTarget.x, legTarget.z, true);
        for (const retryTiles of [LEG_TILES / 2, LEG_TILES / 4]) {
            if (dispatch.success) break;
            const retryTarget = pickLegTarget(retryTiles);
            if (retryTarget.x === legTarget.x && retryTarget.z === legTarget.z) continue;
            legTarget = retryTarget;
            log(`fastWalkTo: leg dispatch failed (${dispatch.message}), retrying closer at (${legTarget.x}, ${legTarget.z})`);
            dispatch = await sdk.sendWalk(legTarget.x, legTarget.z, true);
        }
        if (!dispatch.success) {
            log(`fastWalkTo: leg dispatch failed (${dispatch.message}), falling back to chunkedWalkTo`);
            return chunkedWalkTo(bot, sdk, x, z, tolerance, deadline, log);
        }
        log(`fastWalkTo: leg ${leg + 1}, clicking (${legTarget.x}, ${legTarget.z}) - ${remaining} tiles from destination`);

        // Poll for progress instead of re-dispatching per tile - this is the
        // entire point. Stop polling once arrived, once this leg's target is
        // reached (next leg will pick up from there), or once movement has
        // clearly stopped early (a wall/door/npc blocked the route).
        let lastPos = pos;
        let noMoveStreak = 0;
        for (let i = 0; i < 30; i++) {
            if (Date.now() > deadline) break;
            await sdk.waitForTicks(POLL_TICKS);
            const s = sdk.getState();
            if (!s?.player) continue;
            const here = { x: s.player.worldX, z: s.player.worldZ };

            if (distToDest(here.x, here.z) <= tolerance) return { success: true, message: 'Arrived' };
            if (chebyshev(here.x, here.z, legTarget.x, legTarget.z) <= tolerance) break; // leg done, re-path

            if (here.x === lastPos.x && here.z === lastPos.z) {
                if (++noMoveStreak >= 2) break; // stopped moving before reaching the leg target
            } else {
                noMoveStreak = 0;
            }
            lastPos = here;
        }

        const afterState = sdk.getState();
        const afterPos = afterState?.player
            ? { x: afterState.player.worldX, z: afterState.player.worldZ }
            : pos;
        const afterRemaining = distToDest(afterPos.x, afterPos.z);

        if (afterRemaining < bestRemaining - 1) {
            bestRemaining = afterRemaining;
            stallStreak = 0;
        } else if (++stallStreak >= STALL_LEGS) {
            log(`fastWalkTo: no progress across ${stallStreak} long-range legs, falling back to chunkedWalkTo (likely a door/obstacle)`);
            return chunkedWalkTo(bot, sdk, x, z, tolerance, deadline, log);
        }
    }

    log(`fastWalkTo: gave up after ${MAX_LEGS} legs, falling back to chunkedWalkTo`);
    return chunkedWalkTo(bot, sdk, x, z, tolerance, deadline, log);
}
