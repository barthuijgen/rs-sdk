// Balanced melee training: always fight with whichever of Attack/Strength/
// Defence is currently lowest. Proven pattern from learnings/combat.md -
// "enabled balanced 60+ in all melee stats."

import type { BotSDK } from '../../sdk/index';

export const MELEE_STATS = ['Attack', 'Strength', 'Defence'] as const;
export type MeleeStat = (typeof MELEE_STATS)[number];

export function meleeLevels(sdk: BotSDK): Record<MeleeStat, number> {
    return {
        Attack: sdk.getSkill('Attack')?.baseLevel ?? 1,
        Strength: sdk.getSkill('Strength')?.baseLevel ?? 1,
        Defence: sdk.getSkill('Defence')?.baseLevel ?? 1,
    };
}

export function getLowestMeleeStat(sdk: BotSDK): MeleeStat {
    const levels = meleeLevels(sdk);
    let lowest: MeleeStat = 'Attack';
    for (const stat of MELEE_STATS) {
        if (levels[stat] < levels[lowest]) lowest = stat;
    }
    return lowest;
}

/** Combat-style indices depend on the equipped weapon, so resolve from
 * current state rather than hardcoding an index (see learnings/combat.md). */
export async function setStyleFor(sdk: BotSDK, stat: MeleeStat): Promise<void> {
    const state = sdk.getState();
    if (!state) return;
    const style = state.combatStyle?.styles.find(s => s.trainsSkills.includes(stat));
    if (style && state.combatStyle?.currentStyle !== style.index) {
        await sdk.sendSetCombatStyle(style.index);
    }
}
