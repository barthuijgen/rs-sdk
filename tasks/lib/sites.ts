// Known training locations, one table per skill. A task script shouldn't
// need `--bankSpot`/`--rockSpot`-style coordinate flags for every new place
// it's run from - that info belongs here, next to the level requirement it
// always travels with, not scattered across CLI invocations. Add a new spot
// by appending a row; sourced from learnings/*.md and wiki/skills/*.md
// (cited per entry) plus anything confirmed live this session.

import { DEFAULT_BANK_SPOT } from './bank';

export interface Coords {
    x: number;
    z: number;
}

// --- Mining -----------------------------------------------------------
// Level requirements from wiki/skills/mining.md - intrinsic to the ore,
// independent of where you mine it.
export const ORE_LEVEL_REQ: Record<string, number> = {
    clay: 1,
    'tin ore': 1,
    'copper ore': 1,
    'rune essence': 1,
    'iron ore': 15,
    'silver ore': 20,
    coal: 30,
    'gold ore': 40,
    gems: 40,
    'mithril ore': 55,
    'adamantite ore': 70,
    'runite ore': 85,
};

export interface MiningSite {
    name: string;
    spot: Coords;
    bankSpot: Coords;
    ores: string[]; // keys into ORE_LEVEL_REQ
}

export const MINING_SITES: MiningSite[] = [
    {
        // Confirmed live this session (see tasks/README.md). No copper or
        // tin here despite an earlier (wrong) guess that there was - this
        // cluster only actually has clay/iron/silver.
        name: 'sw-varrock',
        spot: { x: 3181, z: 3372 },
        bankSpot: { x: 3185, z: 3436 }, // Varrock West - learnings/banking.md
        ores: ['clay', 'iron ore', 'silver ore'],
    },
    {
        // Confirmed live this session - learnings/mining.md's "SE Varrock
        // mine", and the one that actually has copper+tin together (see
        // tasks/README.md).
        name: 'se-varrock',
        spot: { x: 3287, z: 3371 },
        // Confirmed live (2 successful bank trips) but not a named/sourced
        // bank anywhere in learnings/wiki yet - likely the "East Varrock
        // bank" several quest pages reference by name with no coordinate
        // (e.g. wiki/quests/rune-mysteries.md's "southeast Varrock, behind
        // east bank"). Much closer to this site than Varrock West.
        bankSpot: { x: 3254, z: 3420 },
        ores: ['tin ore', 'copper ore', 'iron ore'],
    },
    {
        // learnings/mining.md - not yet run live; scorpions roam here
        // (combat 27+ with a defensive style survives them passively).
        name: 'al-kharid',
        spot: { x: 3295, z: 3287 },
        bankSpot: { x: 3269, z: 3167 }, // learnings/banking.md - toll or quest to enter
        ores: ['tin ore', 'iron ore', 'silver ore', 'coal', 'gold ore'],
    },
];

export function findMiningSite(ore: string): MiningSite | undefined {
    return MINING_SITES.find(s => s.ores.includes(ore.toLowerCase()));
}

// --- Thieving -----------------------------------------------------------
// Level requirements from wiki/skills/thieving.md.
export const THIEVING_NPC_LEVEL_REQ: Record<string, number> = {
    'man/woman': 1,
    farmer: 10,
    warrior: 25,
    guard: 40,
    knight: 55,
    paladin: 70,
    hero: 80,
};

export interface ThievingSite {
    name: string;
    npcPattern: RegExp;
    levelReq: number;
    spot: Coords;
    bankSpot: Coords;
}

export const THIEVING_SITES: ThievingSite[] = [
    {
        // learnings/thieving.md - proven 1 -> 43 in ~10 minutes.
        name: 'lumbridge-man-woman',
        npcPattern: /^(man|woman)$/i,
        levelReq: THIEVING_NPC_LEVEL_REQ['man/woman'],
        spot: { x: 3222, z: 3218 },
        bankSpot: DEFAULT_BANK_SPOT, // Draynor - nearest to this spot
    },
    {
        // Confirmed live this session: exact Warrior woman x2 spawn.
        name: 'varrock-warrior',
        npcPattern: /warrior/i,
        levelReq: THIEVING_NPC_LEVEL_REQ.warrior,
        spot: { x: 3209, z: 3488 },
        bankSpot: { x: 3185, z: 3436 }, // Varrock West
    },
    {
        // learnings/thieving.md - not yet run live; kebab seller at
        // (3273, 3180) can sustain HP here instead of banking for food.
        name: 'al-kharid-warrior',
        npcPattern: /^al-kharid warrior$/i,
        levelReq: THIEVING_NPC_LEVEL_REQ.warrior,
        spot: { x: 3293, z: 3170 },
        bankSpot: { x: 3269, z: 3167 },
    },
    {
        // wiki/npcs/guard.md's "Varrock" location sample - not yet run live.
        name: 'varrock-guard',
        npcPattern: /^guard$/i,
        levelReq: THIEVING_NPC_LEVEL_REQ.guard,
        spot: { x: 3205, z: 3379 },
        bankSpot: { x: 3185, z: 3436 }, // Varrock West
    },
];

export function findThievingSite(name: string): ThievingSite | undefined {
    return THIEVING_SITES.find(s => s.name === name);
}

/** Highest-level site this Thieving level actually qualifies for - picking a
 * site above your level just means constant stuns and HP loss. */
export function bestThievingSiteForLevel(level: number): ThievingSite | undefined {
    return THIEVING_SITES.filter(s => s.levelReq <= level).sort((a, b) => b.levelReq - a.levelReq)[0];
}

// --- Woodcutting ----------------------------------------------------------
// Level requirements from learnings/woodcutting.md.
export interface WoodcuttingSite {
    name: string;
    treePattern: RegExp;
    levelReq: number;
    spot: Coords;
    bankSpot: Coords;
}

export const WOODCUTTING_SITES: WoodcuttingSite[] = [
    {
        name: 'lumbridge-trees',
        treePattern: /^tree$/i,
        levelReq: 1,
        spot: { x: 3195, z: 3220 },
        bankSpot: DEFAULT_BANK_SPOT, // Draynor
    },
    {
        name: 'varrock-oaks',
        treePattern: /oak/i,
        levelReq: 15,
        spot: { x: 3190, z: 3458 },
        bankSpot: { x: 3185, z: 3436 }, // Varrock West
    },
    {
        // learnings/woodcutting.md: dark wizards spawn right in these
        // willows at (3084,3236)/(3085,3238) - avoid under combat level 20.
        name: 'draynor-willows',
        treePattern: /willow/i,
        levelReq: 30,
        spot: { x: 3087, z: 3235 },
        bankSpot: DEFAULT_BANK_SPOT, // Draynor - a short walk from here
    },
];

export function findWoodcuttingSite(name: string): WoodcuttingSite | undefined {
    return WOODCUTTING_SITES.find(s => s.name === name);
}

export function bestWoodcuttingSiteForLevel(level: number): WoodcuttingSite | undefined {
    return WOODCUTTING_SITES.filter(s => s.levelReq <= level).sort((a, b) => b.levelReq - a.levelReq)[0];
}

// --- Combat -----------------------------------------------------------
// learnings/combat.md "Safe Training Locations". No level gating here -
// goblins/cows/rats are all low-level safe targets; pick by preference.
export interface CombatSite {
    name: string;
    targets: RegExp;
    spot: Coords;
    bankSpot: Coords;
}

export const COMBAT_SITES: CombatSite[] = [
    {
        name: 'lumbridge-goblins',
        targets: /^(goblin|giant spider|spider)$/i,
        spot: { x: 3252, z: 3230 },
        bankSpot: DEFAULT_BANK_SPOT,
    },
    {
        // South gate at (3253, 3266) - see learnings/combat.md.
        name: 'lumbridge-cows',
        targets: /^cow$/i,
        spot: { x: 3253, z: 3290 },
        bankSpot: DEFAULT_BANK_SPOT,
    },
    {
        // Chicken coop NE of Lumbridge - learnings/combat.md's "Lumbridge
        // chickens" (3237, 3295). Confirmed live this session: standing at
        // (3234, 3296) inside the pen already has 7+ chickens reachable;
        // the two coop gates at (3236, 3295)/(3236, 3296) open automatically
        // via bot.walkTo's door handling, same as the cow/goblin gates.
        name: 'lumbridge-chickens',
        targets: /^chicken$/i,
        spot: { x: 3234, z: 3296 },
        bankSpot: DEFAULT_BANK_SPOT,
    },
];

export function findCombatSite(name: string): CombatSite | undefined {
    return COMBAT_SITES.find(s => s.name === name);
}

// --- Fishing ----------------------------------------------------------
// Fish table (level/XP/equipment) from wiki/skills/fishing.md; spot
// coordinates and option names from learnings/fishing.md.
//
// Gerrant's Fishy Business (Port Sarim) is the only shop in wiki/shops that
// stocks every tool/bait/feather fishing needs in one place - used as the
// shared restock point below. It's a long walk from Al Kharid/Barbarian
// Village (no closer fishing-gear shop is documented yet); fastWalkTo makes
// that tolerable, but carry gear in advance if running those sites a lot.
export const FISHING_GEAR_SHOP: Coords = { x: 3013, z: 3225 };
// Draynor - the nearest documented bank to the gear shop (learnings/banking.md
// only lists Varrock West/Draynor/Al Kharid; Draynor is ~85 tiles from Port
// Sarim, closer than the other two). Used to withdraw buying money, which is
// separate from each site's own `bankSpot` for depositing caught fish.
export const FISHING_GEAR_SHOP_BANK: Coords = DEFAULT_BANK_SPOT;

export interface FishCatch {
    fish: string;
    /** Exact spot option text to click, e.g. "Net", "Bait", "Lure". */
    option: string;
    levelReq: number;
    tool: RegExp;
    /** Consumed per catch (fishing bait / feathers); none for net/harpoon. */
    bait?: RegExp;
}

export interface FishingSite {
    name: string;
    spot: Coords;
    bankSpot: Coords;
    catches: FishCatch[];
}

export const FISHING_SITES: FishingSite[] = [
    {
        // Confirmed-safe level-1 spot - see learnings/fishing.md. Stay south
        // of z~3232; dark wizards spawn at (3084,3236)/(3085,3238).
        name: 'draynor-net-bait',
        spot: { x: 3087, z: 3230 },
        bankSpot: DEFAULT_BANK_SPOT, // Draynor - a few tiles away
        catches: [
            { fish: 'shrimp', option: 'Net', levelReq: 1, tool: /small fishing net/i },
            { fish: 'sardine', option: 'Bait', levelReq: 5, tool: /^fishing rod$/i, bait: /fishing bait/i },
            { fish: 'herring', option: 'Bait', levelReq: 10, tool: /^fishing rod$/i, bait: /fishing bait/i },
            { fish: 'anchovies', option: 'Net', levelReq: 15, tool: /small fishing net/i },
        ],
    },
    {
        // learnings/fishing.md - not yet run live; second spot nearby at
        // (3104, 3424). No bank location documented near here - Varrock
        // West is the nearest one actually sourced, but it's a real walk.
        // Listed before al-kharid-river below so it wins ties on an
        // identical catch (both offer trout/pike/salmon) - this one has no
        // toll gate in the way.
        name: 'barbarian-village-river',
        spot: { x: 3110, z: 3434 },
        bankSpot: { x: 3185, z: 3436 },
        catches: [
            { fish: 'trout', option: 'Lure', levelReq: 20, tool: /fly fishing rod/i, bait: /feather/i },
            { fish: 'pike', option: 'Bait', levelReq: 25, tool: /^fishing rod$/i, bait: /fishing bait/i },
            { fish: 'salmon', option: 'Lure', levelReq: 30, tool: /fly fishing rod/i, bait: /feather/i },
        ],
    },
    {
        // learnings/fishing.md - not yet run live. 10gp toll gate to reach
        // (learnings/dialogs.md's "Al Kharid Toll Gate Pattern" - needs a
        // manual pay-and-dialog sequence bot.walkTo/fastWalkTo don't do on
        // their own, so a route through here can genuinely get stuck); a
        // level 14 scorpion roams nearby too.
        name: 'al-kharid-river',
        spot: { x: 3267, z: 3148 },
        bankSpot: { x: 3269, z: 3167 }, // Al Kharid
        catches: [
            { fish: 'trout', option: 'Lure', levelReq: 20, tool: /fly fishing rod/i, bait: /feather/i },
            { fish: 'pike', option: 'Bait', levelReq: 25, tool: /^fishing rod$/i, bait: /fishing bait/i },
            { fish: 'salmon', option: 'Lure', levelReq: 30, tool: /fly fishing rod/i, bait: /feather/i },
        ],
    },
];

export function findFishingSite(name: string): FishingSite | undefined {
    return FISHING_SITES.find(s => s.name === name);
}

/** Best catch at this site for the given level. "Best" means a catch that
 * costs nothing *new* to use: no bait/feathers at all (net/harpoon/cage tool
 * only - see `FishCatch.bait`), OR bait the caller already has on hand
 * (`alreadyHave`, default: assume none carried) - a stock already bought is
 * a sunk cost, using it up is free. Picking a catch that would need a fresh
 * purchase is preferred over a higher-level one that would, even if the
 * fresh-purchase catch trains faster - defeats the point of fishing as a
 * zero-*new*-cost income/food source otherwise. Only among level-eligible
 * catches; that tie is broken by level (more XP/catch). */
export function bestFishCatchForLevel(
    site: FishingSite,
    level: number,
    alreadyHave: (bait: RegExp) => boolean = () => false,
): FishCatch | undefined {
    const eligible = site.catches.filter(c => c.levelReq <= level);
    if (eligible.length === 0) return undefined;
    const free = eligible.filter(c => !c.bait || alreadyHave(c.bait));
    const pool = free.length > 0 ? free : eligible;
    return pool.sort((a, b) => b.levelReq - a.levelReq)[0];
}

/** Best site+catch combo this Fishing level qualifies for, across every
 * known site - used when no --site is given on the command line. Same
 * no-new-cost-first preference as bestFishCatchForLevel, applied globally:
 * a free-right-now catch at one site beats a higher-level catch needing a
 * fresh purchase at another. */
export function bestFishingSiteForLevel(
    level: number,
    alreadyHave: (bait: RegExp) => boolean = () => false,
): { site: FishingSite; catch: FishCatch } | undefined {
    const candidates: { site: FishingSite; catch: FishCatch }[] = [];
    for (const site of FISHING_SITES) {
        const c = bestFishCatchForLevel(site, level, alreadyHave);
        if (c) candidates.push({ site, catch: c });
    }
    if (candidates.length === 0) return undefined;
    const free = candidates.filter(c => !c.catch.bait || alreadyHave(c.catch.bait));
    const pool = free.length > 0 ? free : candidates;
    return pool.sort((a, b) => b.catch.levelReq - a.catch.levelReq)[0];
}

// --- Cooking ------------------------------------------------------------
// learnings/cooking.md - a short walk from both the Draynor bank and the
// Draynor fishing spot, so the fish -> cook -> food loop stays local.
export const COOKING_SPOT: Coords = { x: 3100, z: 3256 }; // Fireplace near Draynor
export const COOKING_SOURCE_PATTERN = /^(range|fireplace|fire|cooking pot)$/i;

// --- Smithing -------------------------------------------------------------
// wiki/skills/smithing.md's smelting table. Only bronze's exact consumption
// mechanic is confirmed live (learnings/smithing.md: use copper ore on the
// furnace, it auto-consumes 1 tin ore from inventory - no separate combine
// step). The coal-tiers (steel/mithril/adamant/runite) follow the same
// "use the primary ore on the furnace, everything else auto-consumes from
// inventory" pattern by well-established 2004scape convention, but that
// hasn't been confirmed live here yet - watch for a stuck/no-op smelt on
// those and file a bug report if the mechanic turns out to differ.
export interface BarRecipe {
    bar: string; // exact item name produced
    levelReq: number;
    primaryOre: RegExp; // use this on the furnace
    secondaryOre?: RegExp; // auto-consumed alongside (bronze: tin)
    coalCount?: number; // additional coal auto-consumed (steel and up)
}

export const BAR_RECIPES: Record<string, BarRecipe> = {
    bronze: { bar: 'Bronze bar', levelReq: 1, primaryOre: /^copper ore$/i, secondaryOre: /^tin ore$/i },
    iron: { bar: 'Iron bar', levelReq: 15, primaryOre: /^iron ore$/i }, // 50% success rate - wiki/skills/smithing.md
    steel: { bar: 'Steel bar', levelReq: 30, primaryOre: /^iron ore$/i, coalCount: 2 },
    mithril: { bar: 'Mithril bar', levelReq: 50, primaryOre: /^mithril ore$/i, coalCount: 4 },
    adamant: { bar: 'Adamantite bar', levelReq: 70, primaryOre: /^adamantite ore$/i, coalCount: 6 },
    runite: { bar: 'Runite bar', levelReq: 85, primaryOre: /^runite ore$/i, coalCount: 8 },
};

export function findBarRecipe(name: string): BarRecipe | undefined {
    return BAR_RECIPES[name.toLowerCase()];
}

// learnings/smithing.md - confirmed live. Furnace loc id 2781 has the Smelt
// option; a decoy "Furnace" (id 2785) one tile over has none - always find
// by {withOption: /smelt/i}, never by bare name match.
export const FURNACE_PATTERN = /furnace/i;
export const SMELT_OPTION = /^smelt$/i;
// Falador - confirmed live this session. Much shorter furnace<->bank walk
// than the old Lumbridge furnace + Draynor bank pairing (which required a
// long cross-map trip every restock).
export const SMITHING_SPOT: Coords = { x: 2974, z: 3370 }; // Falador furnace
export const SMITHING_BANK_SPOT: Coords = { x: 2945, z: 3368 }; // Falador bank

// --- Smithing: forging (bars -> items) -------------------------------------
// Second half of smithing - bars made at a furnace get turned into weapons
// and armour at an anvil with a hammer in inventory. wiki/skills/smithing.md's
// forging table. Level requirement and bars-per-item are intrinsic to the
// item, independent of where it's forged - metal only shifts the level req,
// never the bar count.
export interface ItemRecipe {
    item: string; // name passed to bot.smithAtAnvil, e.g. 'dagger'
    barsRequired: number; // bars consumed per item (most are 1)
    levelReqByMetal: Record<string, number>; // keys match BAR_RECIPES
}

export const ITEM_RECIPES: Record<string, ItemRecipe> = {
    dagger: { item: 'dagger', barsRequired: 1, levelReqByMetal: { bronze: 1, iron: 15, steel: 30, mithril: 50, adamant: 70, runite: 85 } },
    axe: { item: 'axe', barsRequired: 1, levelReqByMetal: { bronze: 1, iron: 16, steel: 31, mithril: 51, adamant: 71, runite: 86 } },
    mace: { item: 'mace', barsRequired: 2, levelReqByMetal: { bronze: 2, iron: 17, steel: 32, mithril: 52, adamant: 72, runite: 87 } },
    'med helm': { item: 'med helm', barsRequired: 2, levelReqByMetal: { bronze: 3, iron: 18, steel: 33, mithril: 53, adamant: 73, runite: 88 } },
    sword: { item: 'sword', barsRequired: 1, levelReqByMetal: { bronze: 4, iron: 19, steel: 34, mithril: 54, adamant: 74, runite: 89 } },
    scimitar: { item: 'scimitar', barsRequired: 2, levelReqByMetal: { bronze: 5, iron: 20, steel: 35, mithril: 55, adamant: 75, runite: 90 } },
    longsword: { item: 'longsword', barsRequired: 2, levelReqByMetal: { bronze: 6, iron: 21, steel: 36, mithril: 56, adamant: 76, runite: 91 } },
    'full helm': { item: 'full helm', barsRequired: 2, levelReqByMetal: { bronze: 7, iron: 22, steel: 37, mithril: 57, adamant: 77, runite: 92 } },
    'square shield': { item: 'square shield', barsRequired: 2, levelReqByMetal: { bronze: 8, iron: 23, steel: 38, mithril: 58, adamant: 78, runite: 93 } },
    warhammer: { item: 'warhammer', barsRequired: 3, levelReqByMetal: { bronze: 9, iron: 24, steel: 39, mithril: 59, adamant: 79, runite: 94 } },
    battleaxe: { item: 'battleaxe', barsRequired: 3, levelReqByMetal: { bronze: 10, iron: 25, steel: 40, mithril: 60, adamant: 80, runite: 95 } },
    chainbody: { item: 'chainbody', barsRequired: 3, levelReqByMetal: { bronze: 11, iron: 26, steel: 41, mithril: 61, adamant: 81, runite: 96 } },
    'kite shield': { item: 'kite shield', barsRequired: 3, levelReqByMetal: { bronze: 12, iron: 27, steel: 42, mithril: 62, adamant: 82, runite: 97 } },
    '2h sword': { item: '2h sword', barsRequired: 3, levelReqByMetal: { bronze: 14, iron: 29, steel: 44, mithril: 64, adamant: 84, runite: 99 } },
    plateskirt: { item: 'plateskirt', barsRequired: 3, levelReqByMetal: { bronze: 16, iron: 31, steel: 46, mithril: 66, adamant: 86, runite: 99 } },
    platelegs: { item: 'platelegs', barsRequired: 3, levelReqByMetal: { bronze: 16, iron: 31, steel: 46, mithril: 66, adamant: 86, runite: 99 } },
    platebody: { item: 'platebody', barsRequired: 5, levelReqByMetal: { bronze: 18, iron: 33, steel: 48, mithril: 68, adamant: 88, runite: 99 } },
    // Confirmed live: "You hammer the bronze and make five throwing knives"
    // per craft - barsRequired is bars CONSUMED per craft (1), not the 5
    // knives that craft yields; those are different numbers (same mechanic
    // likely applies to dart tips/arrowheads/nails, not yet added here).
    // levelReqByMetal is not in wiki/skills/smithing.md - these are an
    // unverified placeholder (copied from platebody's row) until confirmed
    // live at a low enough Smithing level to actually hit the gate.
    'throwing knives': { item: 'throwing knives', barsRequired: 1, levelReqByMetal: { bronze: 18, iron: 33, steel: 48, mithril: 68, adamant: 88, runite: 99 } },
};

export function findItemRecipe(name: string): ItemRecipe | undefined {
    return ITEM_RECIPES[name.toLowerCase()];
}

export const ANVIL_PATTERN = /anvil/i;
export const HAMMER_PATTERN = /hammer/i;
// Confirmed live this session - same Varrock West smithy/bank pairing as
// learnings/smithing.md's anvil (3188, 3421) and sw-varrock's bank above,
// just the exact tiles used this run.
export const ANVIL_SPOT: Coords = { x: 3187, z: 3426 }; // Varrock West anvil
export const FORGING_BANK_SPOT: Coords = { x: 3185, z: 3436 }; // Varrock West bank
