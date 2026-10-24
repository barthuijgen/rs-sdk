// Describes every `tasks/*.ts` script runnable from the dashboard/MCP tools,
// so the UI can render a form instead of a raw CLI-flags textbox. Field
// names/flags are taken directly from each script's own `import.meta.main`
// argv parsing (all of them use the same `argVal('--flag=')` convention), and
// site/recipe choices are read from the existing tables in tasks/lib/sites.ts
// and tasks/smithing.ts instead of duplicating the names here, so this file
// never drifts from what those scripts actually know about.

import { COMBAT_SITES, WOODCUTTING_SITES, THIEVING_SITES, FISHING_SITES, BAR_RECIPES, ITEM_RECIPES, ORE_LEVEL_REQ } from '../tasks/lib/sites';

export type TaskFieldType = 'number' | 'string' | 'select' | 'coords' | 'boolean';

export interface TaskFieldOption {
    value: string;
    label: string;
}

export interface TaskField {
    /** Key the caller (UI/MCP) sets in the `args` object. */
    name: string;
    /** CLI flag this field maps to, e.g. "--target". */
    flag: string;
    label: string;
    type: TaskFieldType;
    default?: string | number | boolean;
    options?: TaskFieldOption[];
}

export interface TaskDef {
    key: string;
    label: string;
    description: string;
    /** Path to the script, relative to the repo root. */
    scriptPath: string;
    fields: TaskField[];
}

const siteOptions = (sites: { name: string }[]): TaskFieldOption[] => sites.map(s => ({ value: s.name, label: s.name }));
const keyOptions = (record: Record<string, unknown>): TaskFieldOption[] => Object.keys(record).map(k => ({ value: k, label: k }));
const oreOptions = (): TaskFieldOption[] => Object.keys(ORE_LEVEL_REQ).map(ore => ({ value: ore, label: ore }));

const EMBEDDED_FIELD: TaskField = {
    name: 'embedded',
    flag: '--embedded',
    label: 'Run embedded (bypass gateway, no visible browser)',
    type: 'boolean',
};

export const TASKS: TaskDef[] = [
    {
        key: 'onboard',
        label: 'Onboard (skip tutorial)',
        description: 'Accept character design and skip the tutorial by talking to the RuneScape Guide. Safe to queue even if already past the tutorial.',
        scriptPath: 'tasks/onboard.ts',
        fields: [EMBEDDED_FIELD],
    },
    {
        key: 'combat',
        label: 'Combat',
        description: 'Train combat against safe NPC targets until a Combat level target is hit.',
        scriptPath: 'tasks/combat.ts',
        fields: [
            { name: 'target', flag: '--target', label: 'Target level (optional - omit to fight unbounded until the deadline)', type: 'number' },
            { name: 'site', flag: '--site', label: 'Site', type: 'select', options: siteOptions(COMBAT_SITES) },
            { name: 'targets', flag: '--targets', label: 'Target NPC regex (overrides site default)', type: 'string' },
            { name: 'spot', flag: '--spot', label: 'Fallback spot (x,z)', type: 'coords' },
            { name: 'bankSpot', flag: '--bankSpot', label: 'Bank spot (x,z)', type: 'coords' },
            { name: 'maxMs', flag: '--maxMs', label: 'Safety deadline (ms)', type: 'number' },
            { name: 'buryBones', flag: '--buryBones', label: 'Bury bones for Prayer xp', type: 'boolean' },
        ],
    },
    {
        key: 'woodcut',
        label: 'Woodcutting',
        description: 'Chop trees until a Woodcutting level target is hit.',
        scriptPath: 'tasks/woodcut.ts',
        fields: [
            { name: 'target', flag: '--target', label: 'Target level', type: 'number', default: 30 },
            { name: 'site', flag: '--site', label: 'Site', type: 'select', options: siteOptions(WOODCUTTING_SITES) },
            { name: 'tree', flag: '--tree', label: 'Tree regex (overrides site default)', type: 'string' },
            { name: 'spot', flag: '--spot', label: 'Fallback spot (x,z)', type: 'coords' },
            { name: 'bankSpot', flag: '--bankSpot', label: 'Bank spot (x,z)', type: 'coords' },
        ],
    },
    {
        key: 'thieving',
        label: 'Thieving',
        description: 'Pickpocket NPCs until a Thieving level target is hit.',
        scriptPath: 'tasks/thieving.ts',
        fields: [
            { name: 'target', flag: '--target', label: 'Target level (optional - omit to run for gp/loot past level 99)', type: 'number' },
            { name: 'site', flag: '--site', label: 'Site', type: 'select', options: siteOptions(THIEVING_SITES) },
            { name: 'npc', flag: '--npc', label: 'NPC regex (overrides site default)', type: 'string' },
            { name: 'spot', flag: '--spot', label: 'Fallback spot (x,z)', type: 'coords' },
            { name: 'bankSpot', flag: '--bankSpot', label: 'Bank spot (x,z)', type: 'coords' },
            { name: 'maxMs', flag: '--maxMs', label: 'Safety deadline (ms)', type: 'number' },
            EMBEDDED_FIELD,
        ],
    },
    {
        key: 'mining',
        label: 'Mining',
        description: 'Mine a given ore by quantity or until a deadline.',
        scriptPath: 'tasks/mining.ts',
        fields: [
            { name: 'ore', flag: '--ore', label: 'Ore', type: 'select', options: oreOptions() },
            { name: 'targetQuantity', flag: '--targetQuantity', label: 'Target quantity', type: 'number' },
            {
                name: 'disposal',
                flag: '--disposal',
                label: 'Disposal',
                type: 'select',
                options: [{ value: 'drop', label: 'Drop' }, { value: 'bank', label: 'Bank' }],
                default: 'bank',
            },
            { name: 'bankSpot', flag: '--bankSpot', label: 'Bank spot (x,z)', type: 'coords' },
            { name: 'rockSpot', flag: '--rockSpot', label: 'Rock spot (x,z)', type: 'coords' },
            { name: 'benchmarkMs', flag: '--benchmarkMs', label: 'Benchmark duration (ms)', type: 'number' },
            { name: 'maxMs', flag: '--maxMs', label: 'Safety deadline (ms)', type: 'number' },
            EMBEDDED_FIELD,
        ],
    },
    {
        key: 'fishing',
        label: 'Fishing',
        description: 'Fish until a Fishing level target is hit.',
        scriptPath: 'tasks/fishing.ts',
        fields: [
            { name: 'target', flag: '--target', label: 'Target level', type: 'number', default: 30 },
            { name: 'site', flag: '--site', label: 'Site', type: 'select', options: siteOptions(FISHING_SITES) },
            { name: 'fish', flag: '--fish', label: 'Forced catch (e.g. "shrimp")', type: 'string' },
            { name: 'spot', flag: '--spot', label: 'Fallback spot (x,z)', type: 'coords' },
            { name: 'bankSpot', flag: '--bankSpot', label: 'Bank spot (x,z)', type: 'coords' },
            EMBEDDED_FIELD,
        ],
    },
    {
        key: 'cooking',
        label: 'Cooking',
        description: "Cook whatever's in inventory/bank and bank the result.",
        scriptPath: 'tasks/cooking.ts',
        fields: [
            { name: 'spot', flag: '--spot', label: 'Range/fire spot (x,z)', type: 'coords' },
            { name: 'bankSpot', flag: '--bankSpot', label: 'Bank spot (x,z)', type: 'coords' },
            { name: 'maxMs', flag: '--maxMs', label: 'Safety deadline (ms)', type: 'number' },
            EMBEDDED_FIELD,
        ],
    },
    {
        key: 'smithing',
        label: 'Smithing',
        description: 'Smelt bars, or smith items from bars, until a quantity target is hit (or resources run out if no target is set).',
        scriptPath: 'tasks/smithing.ts',
        fields: [
            {
                name: 'mode',
                flag: '--mode',
                label: 'Mode',
                type: 'select',
                options: [{ value: 'smelt', label: 'Smelt bars' }, { value: 'smith', label: 'Smith items' }],
                default: 'smelt',
            },
            { name: 'bar', flag: '--bar', label: 'Bar', type: 'select', options: keyOptions(BAR_RECIPES), default: 'bronze' },
            { name: 'item', flag: '--item', label: 'Item (mode=smith only)', type: 'select', options: keyOptions(ITEM_RECIPES) },
            { name: 'target', flag: '--target', label: 'Target quantity (optional - omit to run until resources run out)', type: 'number' },
            { name: 'furnaceSpot', flag: '--furnaceSpot', label: 'Furnace spot (x,z) (mode=smelt)', type: 'coords' },
            { name: 'anvilSpot', flag: '--anvilSpot', label: 'Anvil spot (x,z) (mode=smith)', type: 'coords' },
            { name: 'bankSpot', flag: '--bankSpot', label: 'Bank spot (x,z)', type: 'coords' },
            { name: 'maxMs', flag: '--maxMs', label: 'Safety deadline (ms)', type: 'number' },
            EMBEDDED_FIELD,
        ],
    },
];

export function findTask(key: string): TaskDef | undefined {
    return TASKS.find(t => t.key === key);
}

function coordsToFlagValue(raw: unknown): string | null {
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (typeof raw === 'object' && raw !== null && 'x' in raw && 'z' in raw) {
        const { x, z } = raw as { x: unknown; z: unknown };
        return `${x},${z}`;
    }
    return null;
}

/** Turns a `{fieldName: value}` object from the API/MCP into the CLI args
 * every task script's `argVal('--flag=')` parsing expects, validating field
 * names/values against the registry so a typo doesn't silently no-op. */
export function validateAndBuildArgs(
    taskKey: string,
    values: Record<string, unknown>
): { ok: true; args: string[] } | { ok: false; error: string } {
    const task = findTask(taskKey);
    if (!task) return { ok: false, error: `Unknown task "${taskKey}". Known: ${TASKS.map(t => t.key).join(', ')}` };

    const unknownKeys = Object.keys(values).filter(k => !task.fields.some(f => f.name === k));
    if (unknownKeys.length > 0) {
        return { ok: false, error: `Unknown field(s) for task "${taskKey}": ${unknownKeys.join(', ')}` };
    }

    const args: string[] = [];
    for (const field of task.fields) {
        const raw = values[field.name];
        if (raw === undefined || raw === null || raw === '') continue;

        if (field.type === 'boolean') {
            if (raw === true || raw === 'true') args.push(field.flag);
            continue;
        }
        if (field.type === 'coords') {
            const value = coordsToFlagValue(raw);
            if (!value) return { ok: false, error: `Field "${field.name}" must be "x,z" or {x, z}` };
            args.push(`${field.flag}=${value}`);
            continue;
        }
        if (field.type === 'select' && field.options && !field.options.some(o => o.value === String(raw))) {
            return { ok: false, error: `Field "${field.name}" must be one of: ${field.options.map(o => o.value).join(', ')}` };
        }
        if (field.type === 'number' && Number.isNaN(Number(raw))) {
            return { ok: false, error: `Field "${field.name}" must be a number` };
        }
        args.push(`${field.flag}=${raw}`);
    }
    return { ok: true, args };
}
