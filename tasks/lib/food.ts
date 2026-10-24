// Shared food-item knowledge - every task that eats for HP (health.ts,
// combat.ts) or decides what to keep vs. bank (every task's `keep` list)
// used to hardcode its own `/shrimp|bread|lobster|cake|cooked/i` copy. That
// pattern also had a real bug: a bare "lobster"/"shrimp" substring matches
// both "Raw lobster" (not cooked, doesn't heal) and "Burnt lobster" (Type:
// Other, heals nothing) just as happily as "Lobster" itself. Centralized
// here, fixed, and extended to every fish on the cooking table
// (wiki/skills/cooking.md) now that tasks/cooking.ts exists to produce them.

const FISH_NAMES = [
    'shrimps', 'sardine', 'herring', 'anchovies', 'trout', 'pike', 'salmon',
    'tuna', 'lobster', 'bass', 'swordfish', 'shark', 'mackerel', 'cod',
];

/** Raw meat drops from combat (chicken/cow/rat/bear corpses) - confirmed
 * against server/content/scripts/skill_cooking/configs/cooking_source/
 * cooking_generic.dbrow: all level-1, all cooked on the same range/fire a
 * fish would be. Unlike fish, the cooked item keeps a "Cooked " prefix
 * instead of dropping the raw/cooked distinction into the bare name -
 * chicken cooks into "Cooked chicken", the other three all cook into the
 * single generic "Cooked meat" (same for burnt).  Keyed by the exact
 * fragment after "Raw " -> the word(s) after "Cooked "/"Burnt ".
 */
const MEAT_NAMES: Record<string, string> = {
    chicken: 'chicken',
    beef: 'meat',
    'rat meat': 'meat',
    'bear meat': 'meat',
};

/** Cooked food that actually heals HP - excludes "Raw " (not cooked yet,
 * see RAW_FOOD_PATTERN) and "Burnt " (ruined, 0 heal) via negative
 * lookahead, since both would otherwise substring-match the same fish
 * names. Meat's cooked form carries a "Cooked " prefix instead (see
 * MEAT_NAMES), so it's matched as its own alternative rather than through
 * that lookahead/bare-name scheme. */
export const COOKED_FOOD_PATTERN = new RegExp(
    `^(?!raw\\b|burnt\\b)(${FISH_NAMES.join('|')}|bread|cake|kebab)|^cooked\\s+(${Array.from(new Set(Object.values(MEAT_NAMES))).join('|')})\\b`,
    'i'
);

/** Uncooked catch/drop that needs tasks/cooking.ts before
 * ensureHealthy/combat.ts will treat it as food - raw fish from a fishing
 * spot, or raw meat dropped by a killed NPC (see tasks/combat.ts's
 * pickupDrops). */
export const RAW_FOOD_PATTERN = new RegExp(`^raw\\s+(${[...FISH_NAMES, ...Object.keys(MEAT_NAMES)].join('|')})`, 'i');

/** Cooking level needed before a fish/meat is reliably cookable -
 * wiki/skills/cooking.md. Keyed by the exact fragment after "Raw " in the
 * item's name. */
export const COOKING_LEVEL_REQ: Record<string, number> = {
    shrimps: 1,
    sardine: 1,
    herring: 5,
    mackerel: 10,
    trout: 15,
    anchovies: 15,
    cod: 18,
    pike: 20,
    salmon: 25,
    tuna: 30,
    lobster: 40,
    bass: 43,
    swordfish: 45,
    shark: 80,
    chicken: 1,
    beef: 1,
    'rat meat': 1,
    'bear meat': 1,
};

export function cookingLevelReqFor(itemName: string): number {
    const m = /^raw\s+(.+)$/i.exec(itemName.trim());
    const key = (m ? m[1] : itemName).toLowerCase();
    return COOKING_LEVEL_REQ[key] ?? 1;
}
