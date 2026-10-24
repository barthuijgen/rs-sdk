import { useEffect, useState } from 'react';
import { api } from './api';
import type { TaskDef, TaskField } from './types';

type FieldValue = string | number | boolean | { x: string; z: string };

function defaultValueFor(field: TaskField): FieldValue {
    if (field.type === 'coords') return { x: '', z: '' };
    if (field.type === 'boolean') return Boolean(field.default);
    return field.default !== undefined ? field.default : '';
}

function FieldInput({ field, value, onChange }: { field: TaskField; value: FieldValue; onChange: (v: FieldValue) => void }) {
    if (field.type === 'boolean') {
        return <input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} />;
    }
    if (field.type === 'select') {
        return (
            <select value={String(value)} onChange={e => onChange(e.target.value)}>
                <option value="">(default)</option>
                {field.options?.map(o => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        );
    }
    if (field.type === 'coords') {
        const coords = typeof value === 'object' ? value : { x: '', z: '' };
        return (
            <span className="coords-input">
                <input placeholder="x" value={coords.x} onChange={e => onChange({ ...coords, x: e.target.value })} />
                <input placeholder="z" value={coords.z} onChange={e => onChange({ ...coords, z: e.target.value })} />
            </span>
        );
    }
    return (
        <input
            type={field.type === 'number' ? 'number' : 'text'}
            value={String(value)}
            onChange={e => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)}
        />
    );
}

/** Turns the form's per-field state into the plain `{fieldName: value}`
 * object manager/taskRegistry.ts's validateAndBuildArgs expects - coords
 * become "x,z" strings, empty/default values are dropped. */
function buildArgs(task: TaskDef, values: Record<string, FieldValue>): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const field of task.fields) {
        const value = values[field.name];
        if (field.type === 'coords') {
            const coords = value as { x: string; z: string };
            if (coords?.x !== '' && coords?.z !== '') args[field.name] = `${coords.x},${coords.z}`;
            continue;
        }
        if (field.type === 'boolean') {
            if (value) args[field.name] = true;
            continue;
        }
        if (value !== '' && value !== undefined) args[field.name] = value;
    }
    return args;
}

export function TaskForm({ botName, onQueued }: { botName: string; onQueued: () => void }) {
    const [tasks, setTasks] = useState<TaskDef[] | null>(null);
    const [taskKey, setTaskKey] = useState<string>('');
    const [values, setValues] = useState<Record<string, FieldValue>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        api.listTasks().then(list => {
            setTasks(list);
            if (list[0]) setTaskKey(list[0].key);
        });
    }, []);

    const task = tasks?.find(t => t.key === taskKey);

    useEffect(() => {
        if (!task) return;
        setValues(Object.fromEntries(task.fields.map(f => [f.name, defaultValueFor(f)])));
    }, [task]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!task) return;
        setBusy(true);
        setError(null);
        try {
            await api.enqueueTask(botName, task.key, buildArgs(task, values));
            onQueued();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    if (!tasks) return <p>Loading tasks…</p>;

    return (
        <form className="task-form" onSubmit={submit}>
            {error && <p className="error">{error}</p>}
            <label>
                Task
                <select value={taskKey} onChange={e => setTaskKey(e.target.value)}>
                    {tasks.map(t => (
                        <option key={t.key} value={t.key}>
                            {t.label}
                        </option>
                    ))}
                </select>
            </label>
            {task && <p className="task-description">{task.description}</p>}
            {task?.fields.map(field => (
                <label key={field.name} className={field.type === 'boolean' ? 'checkbox' : undefined}>
                    {field.label}
                    <FieldInput field={field} value={values[field.name] ?? defaultValueFor(field)} onChange={v => setValues(prev => ({ ...prev, [field.name]: v }))} />
                </label>
            ))}
            <button type="submit" disabled={busy || !task}>
                {busy ? 'Queuing…' : 'Queue task'}
            </button>
        </form>
    );
}
