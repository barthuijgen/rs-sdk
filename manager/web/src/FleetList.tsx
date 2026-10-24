import { useState } from 'react';
import { api } from './api';
import { usePolling } from './usePolling';
import { useLiveRefresh } from './LiveConnection';
import { ErrorBanner } from './ErrorBanner';
import type { FleetRow } from './types';

function NewFleetForm({ onCreated }: { onCreated: () => void }) {
    const [name, setName] = useState('');
    const [goal, setGoal] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        setError(null);
        try {
            const fleet = await api.createFleet(name.trim(), goal.trim() || undefined);
            setName('');
            setGoal('');
            onCreated();
            window.location.hash = `#/fleets/${encodeURIComponent(fleet.id)}`;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form className="panel new-fleet-form" onSubmit={submit}>
            <h3>New fleet</h3>
            {error && <ErrorBanner message={error} />}
            <label>
                Name
                <input value={name} onChange={e => setName(e.target.value)} placeholder="miners" />
            </label>
            <label>
                Goal (optional)
                <input value={goal} onChange={e => setGoal(e.target.value)} placeholder="stockpile 1000 iron ore" />
            </label>
            <button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create fleet'}
            </button>
        </form>
    );
}

function FleetCard({ fleet }: { fleet: FleetRow }) {
    return (
        <div className="entity-card">
            <a className="entity-card-link" href={`#/fleets/${encodeURIComponent(fleet.id)}`} aria-label={`View ${fleet.name}`} />
            <div className="entity-card-top">
                <span className="entity-card-name">{fleet.name}</span>
            </div>
            {fleet.goal ? <p className="entity-card-goal">{fleet.goal}</p> : <p className="entity-card-goal muted">No goal set.</p>}
        </div>
    );
}

export function FleetList() {
    const { data: fleets, error, offline, loading, refresh } = usePolling(api.listFleets, 5000);
    useLiveRefresh(msg => {
        if (msg.fleetId) refresh();
    });

    return (
        <div className="bot-list">
            <div className="page-header">
                <h2>Fleets</h2>
            </div>
            {error && <ErrorBanner message={error} offline={offline} onRetry={refresh} />}
            <NewFleetForm onCreated={refresh} />
            {loading && !fleets ? (
                <p className="loading-state">Loading fleets…</p>
            ) : fleets && fleets.length === 0 ? (
                <p className="empty-state">No fleets yet - create one above.</p>
            ) : fleets ? (
                <div className="card-grid">
                    {fleets.map(fleet => (
                        <FleetCard key={fleet.id} fleet={fleet} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}
