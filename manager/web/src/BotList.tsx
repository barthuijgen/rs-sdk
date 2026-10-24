import { useState } from 'react';
import { api } from './api';
import { usePolling } from './usePolling';
import { useLiveRefresh } from './LiveConnection';
import { ErrorBanner } from './ErrorBanner';
import type { BotSummary } from './types';

function StatusBadge({ bot }: { bot: BotSummary }) {
    if (bot.status?.needsAttention) return <span className="badge badge-warn">needs attention</span>;
    if (bot.queue.runningTask) return <span className="badge badge-run">running: {bot.queue.runningTask}</span>;
    if (bot.status?.currentTask) return <span className="badge badge-run">{bot.status.currentTask}</span>;
    return <span className="badge badge-idle">idle</span>;
}

// Deliberately cheap: only `bot.desiredRunning` (a DB column already in the
// polled bot-summary list, see manager/botRegistry.ts), not a per-row
// gateway check - that would mean one extra HTTP round trip per bot per
// poll. The full picture (whether it's actually attached yet, via what kind
// of client, and why not if it's stuck) is one click away on the bot's
// detail page (BotDetail.tsx's ClientPanel), which does pay for that check
// since it's only ever showing one bot at a time.
function ClientToggle({ bot, refresh }: { bot: BotSummary; refresh: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const toggle = async (e: React.MouseEvent) => {
        e.stopPropagation();
        setBusy(true);
        setError(null);
        try {
            if (bot.desiredRunning) await api.stopClient(bot.name);
            else await api.startClient(bot.name);
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <span className="client-toggle" title="Whether this bot is set to have a game client running - see its page for the live gateway status">
            <span className={bot.desiredRunning ? 'badge badge-ok' : 'badge badge-idle'}>{bot.desiredRunning ? 'on' : 'off'}</span>
            <button onClick={toggle} disabled={busy}>
                {busy ? 'Working…' : bot.desiredRunning ? 'Stop' : 'Start'}
            </button>
            {error && <span className="error">{error}</span>}
        </span>
    );
}

function NewBotForm({ onCreated }: { onCreated: () => void }) {
    const [username, setUsername] = useState('');
    const [local, setLocal] = useState(false);
    const [server, setServer] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const { name } = await api.createBot({ username: username || undefined, server: server || undefined, local });
            setUsername('');
            setServer('');
            onCreated();
            window.location.hash = `#/bots/${encodeURIComponent(name)}`;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form className="panel new-bot-form" onSubmit={submit}>
            <h3>New bot</h3>
            {error && <ErrorBanner message={error} />}
            <label>
                Username (optional, max 12 chars)
                <input value={username} onChange={e => setUsername(e.target.value)} maxLength={12} placeholder="auto-generated if blank" />
            </label>
            <label className="checkbox">
                <input type="checkbox" checked={local} onChange={e => setLocal(e.target.checked)} />
                Local dev stack (localhost)
            </label>
            {!local && (
                <label>
                    Server (optional)
                    <input value={server} onChange={e => setServer(e.target.value)} placeholder="rs-sdk-demo.fly.dev" />
                </label>
            )}
            <button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create bot'}
            </button>
        </form>
    );
}

function BotCard({ bot, refresh }: { bot: BotSummary; refresh: () => void }) {
    return (
        <div className="entity-card">
            <a className="entity-card-link" href={`#/bots/${encodeURIComponent(bot.name)}`} aria-label={`View ${bot.name}`} />
            <div className="entity-card-top">
                <span className="entity-card-name">{bot.name}</span>
                <StatusBadge bot={bot} />
            </div>
            <div className="entity-card-meta">
                <span>{bot.server ?? 'default server'}</span>
                {bot.fleetId && (
                    <a href={`#/fleets/${encodeURIComponent(bot.fleetId)}`} className="muted">
                        fleet →
                    </a>
                )}
            </div>
            {bot.goal && <p className="entity-card-goal">{bot.goal}</p>}
            <div className="entity-card-footer">
                <span className="muted">{bot.queue.queuedCount > 0 ? `${bot.queue.queuedCount} queued` : 'queue empty'}</span>
                <ClientToggle bot={bot} refresh={refresh} />
            </div>
        </div>
    );
}

export function BotList() {
    const { data: bots, error, offline, loading, refresh } = usePolling(api.listBots, 4000);
    useLiveRefresh(msg => {
        if (msg.type === 'refresh' || msg.type === 'event') refresh();
    });

    return (
        <div className="bot-list">
            <div className="page-header">
                <h2>Bots</h2>
            </div>
            {error && <ErrorBanner message={error} offline={offline} onRetry={refresh} />}
            <NewBotForm onCreated={refresh} />
            {loading && !bots ? (
                <p className="loading-state">Loading bots…</p>
            ) : bots && bots.length === 0 ? (
                <p className="empty-state">No bots yet - create one above.</p>
            ) : bots ? (
                <div className="card-grid">
                    {bots.map(bot => (
                        <BotCard key={bot.name} bot={bot} refresh={refresh} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}
