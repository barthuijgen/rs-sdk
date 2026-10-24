import { useEffect, useState } from 'react';
import { api } from './api';
import { usePolling } from './usePolling';
import { useLiveRefresh } from './LiveConnection';
import { ErrorBanner, InlineWarning } from './ErrorBanner';

function GoalPanel({ fleetId, goal, refresh }: { fleetId: string; goal: string | null; refresh: () => void }) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(goal ?? '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!editing) setValue(goal ?? '');
    }, [goal, editing]);

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            await api.setFleetGoal(fleetId, value.trim() || null);
            setEditing(false);
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    };

    if (!editing) {
        return (
            <p className="goal-display">
                <strong>Goal:</strong> {goal ?? <span className="muted">none set</span>} <button onClick={() => setEditing(true)}>Edit</button>
            </p>
        );
    }
    return (
        <div className="goal-edit">
            <input value={value} onChange={e => setValue(e.target.value)} placeholder="What is this fleet coordinating toward?" />
            <button onClick={save} disabled={saving}>
                Save
            </button>
            <button onClick={() => setEditing(false)} disabled={saving}>
                Cancel
            </button>
            {error && <ErrorBanner message={error} />}
        </div>
    );
}

function FleetClientControls({ fleetId, refresh }: { fleetId: string; refresh: () => void }) {
    const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
    const [error, setError] = useState<string | null>(null);

    const run = async (action: 'start' | 'stop') => {
        setBusy(action);
        setError(null);
        try {
            if (action === 'start') await api.startFleetClients(fleetId);
            else await api.stopFleetClients(fleetId);
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="client-panel">
            <p>
                <strong>Members' game clients:</strong>
                <button onClick={() => run('start')} disabled={busy !== null}>
                    {busy === 'start' ? 'Starting…' : 'Start all'}
                </button>
                <button onClick={() => run('stop')} disabled={busy !== null}>
                    {busy === 'stop' ? 'Stopping…' : 'Stop all'}
                </button>
            </p>
            {error && <ErrorBanner message={error} />}
        </div>
    );
}

function NotesPanel({ fleetId }: { fleetId: string }) {
    const { data: notes, error, offline, refresh } = usePolling(() => api.listFleetNotes(fleetId), 5000, [fleetId]);
    const [content, setContent] = useState('');
    const [saving, setSaving] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!content.trim()) return;
        setSaving(true);
        setSubmitError(null);
        try {
            await api.addFleetNote(fleetId, content.trim());
            setContent('');
            refresh();
        } catch (err) {
            setSubmitError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="notes-panel">
            <form onSubmit={submit} className="note-composer">
                <input value={content} onChange={e => setContent(e.target.value)} placeholder="Leave a note..." />
                <button type="submit" disabled={saving}>
                    Add
                </button>
            </form>
            {submitError && <ErrorBanner message={submitError} />}
            {error && <InlineWarning message={`Notes may be stale: ${error}`} />}
            {!notes ? (
                <p className="loading-state">Loading…</p>
            ) : notes.length === 0 ? (
                <p className="empty-state">No notes yet.</p>
            ) : (
                <ul className="notes-feed">
                    {notes.map(n => (
                        <li key={n.id}>
                            <span className="muted">
                                {new Date(n.created_at).toLocaleString()}
                                {n.author ? ` (${n.author})` : ''}
                            </span>{' '}
                            {n.content}
                        </li>
                    ))}
                </ul>
            )}
            {offline && <InlineWarning message="Can't reach the manager daemon - notes shown may be out of date." />}
        </div>
    );
}

export function FleetDetail({ id }: { id: string }) {
    const { data: fleet, error, offline, loading, refresh } = usePolling(() => api.getFleet(id), 4000, [id]);
    useLiveRefresh(msg => {
        if (msg.fleetId === id) refresh();
    });

    return (
        <div className="bot-detail">
            <a className="back-link" href="#/fleets">
                ← all fleets
            </a>
            {error && <ErrorBanner message={error} offline={offline} onRetry={refresh} />}
            {loading && !fleet ? (
                <p className="loading-state">Loading fleet…</p>
            ) : !fleet ? null : (
                <>
                    <div className="hero-panel">
                        <div className="hero-top">
                            <div className="hero-identity">
                                <h2>{fleet.name}</h2>
                            </div>
                        </div>
                        <GoalPanel fleetId={fleet.id} goal={fleet.goal} refresh={refresh} />
                        <FleetClientControls fleetId={fleet.id} refresh={refresh} />
                    </div>
                    <div className="detail-grid">
                        <section className="panel">
                            <h3>Members ({fleet.members.length})</h3>
                            {fleet.members.length === 0 ? (
                                <p className="empty-state">No bots assigned yet - set a bot's fleet from its detail page.</p>
                            ) : (
                                <ul className="fleet-list">
                                    {fleet.members.map(bot => (
                                        <li key={bot.id}>
                                            <a href={`#/bots/${encodeURIComponent(bot.id)}`}>{bot.id}</a>
                                            <span className={bot.desired_running ? 'badge badge-run' : 'badge badge-idle'}>
                                                {bot.desired_running ? 'on' : 'off'}
                                            </span>
                                            {bot.goal && <span className="muted">{bot.goal}</span>}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                        <section className="panel">
                            <h3>Notes</h3>
                            <NotesPanel fleetId={fleet.id} />
                        </section>
                    </div>
                </>
            )}
        </div>
    );
}
