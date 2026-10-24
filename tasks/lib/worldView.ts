// A crude, text-only reconstruction of world state - not a renderer, just
// enough to "keep an eye on it" while a script runs with no browser/gateway
// involved (see tasks/lib/embeddedRunner.ts). A rough top-down grid of
// nearby entities plus a stats block, refreshed periodically to a plain
// file any terminal can tail.

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { BotWorldState } from '../../sdk/types';

const GRID_RADIUS = 10; // tiles each direction from the player

function viewPath(botName: string): string {
    return `bots/${botName}/view.txt`;
}

export function renderCrudeView(state: BotWorldState): string {
    const p = state.player;
    if (!p) return 'No player state yet.';

    const size = GRID_RADIUS * 2 + 1;
    const grid: string[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => '.'));

    const place = (dx: number, dz: number, symbol: string) => {
        const gx = GRID_RADIUS + dx;
        const gz = GRID_RADIUS - dz; // flip so +z renders upward, roughly matching the minimap
        if (gx >= 0 && gx < size && gz >= 0 && gz < size) grid[gz]![gx] = symbol;
    };

    for (const loc of state.nearbyLocs ?? []) {
        const dx = loc.x - p.worldX, dz = loc.z - p.worldZ;
        if (Math.abs(dx) <= GRID_RADIUS && Math.abs(dz) <= GRID_RADIUS) {
            place(dx, dz, /rock/i.test(loc.name) ? 'R' : /tree/i.test(loc.name) ? 'T' : /door|gate/i.test(loc.name) ? 'D' : 'o');
        }
    }
    for (const npc of state.nearbyNpcs ?? []) {
        const dx = npc.x - p.worldX, dz = npc.z - p.worldZ;
        if (Math.abs(dx) <= GRID_RADIUS && Math.abs(dz) <= GRID_RADIUS) place(dx, dz, npc.inCombat ? '!' : 'n');
    }
    for (const pl of state.nearbyPlayers ?? []) {
        const dx = pl.x - p.worldX, dz = pl.z - p.worldZ;
        if (Math.abs(dx) <= GRID_RADIUS && Math.abs(dz) <= GRID_RADIUS) place(dx, dz, 'P');
    }
    place(0, 0, '@');

    const mapLines = grid.map(row => row.join(' ')).join('\n');

    const inv = state.inventory ?? [];
    const invSummary = inv.length === 0
        ? '(empty)'
        : inv.slice(0, 10).map(i => `${i.name}${i.count > 1 ? ` x${i.count}` : ''}`).join(', ')
            + (inv.length > 10 ? ` ... (+${inv.length - 10} more)` : '');
    const dialogLine = state.dialog?.isOpen
        ? `DIALOG OPEN: ${state.dialog.options?.map(o => o.text).join(' | ') || '(no options yet)'}`
        : '';
    const recentMsgs = (state.gameMessages ?? []).slice(-5).map(m => m.text).join('\n  ');

    return [
        `=== ${p.name ?? 'bot'} @ (${p.worldX}, ${p.worldZ})  tick ${state.tick}  ${new Date().toLocaleTimeString()} ===`,
        `HP: ${p.hp}/${p.maxHp}${dialogLine ? '   ' + dialogLine : ''}`,
        '',
        '@ = you   n = npc   ! = npc in combat   P = player   R = rock   T = tree   D = door/gate   o = other',
        mapLines,
        '',
        `Inventory (${inv.length}/28): ${invSummary}`,
        recentMsgs ? `Recent messages:\n  ${recentMsgs}` : '',
    ].filter(Boolean).join('\n');
}

export function writeWorldView(botName: string, state: BotWorldState): void {
    const path = viewPath(botName);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, renderCrudeView(state));
}
