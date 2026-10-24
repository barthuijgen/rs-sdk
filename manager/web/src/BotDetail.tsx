import { useEffect, useState } from 'react';
import { api } from './api';
import { usePolling } from './usePolling';
import { useLiveRefresh } from './LiveConnection';
import { TaskForm } from './TaskForm';
import { ErrorBanner, InlineWarning } from './ErrorBanner';
import type { ActionRow, BotDetail as BotDetailType, FleetRow, RunRow, RunStatus } from './types';

function timeAgo(ts: number): string {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
}

function hpTone(fraction: number): 'ok' | 'caution' | 'warn' {
    if (fraction <= 0.25) return 'warn';
    if (fraction <= 0.5) return 'caution';
    return 'ok';
}

/** The bot's name, HP bar, position and combat level up top where they're
 * impossible to miss - this is the "see important information quickly"
 * part of the page; everything else is a panel below for when you need to
 * dig in. */
function HeroStats({ bot }: { bot: BotDetailType }) {
    if ('error' in bot.live) {
        return <p className="live-error">No live client attached: {bot.live.error}</p>;
    }
    const { state, stateAge } = bot.live;
    const player = state.player;
    if (!player) return <p className="muted">Connected, no player data yet.</p>;
    const fraction = player.maxHp > 0 ? player.hp / player.maxHp : 1;
    return (
        <div className="hero-stats">
            <div className="stat">
                <div className="stat-label">HP</div>
                <div className="hp-bar-wrap">
                    <span className="stat-value">
                        {player.hp}/{player.maxHp}
                    </span>
                    <div className="hp-bar">
                        <div className={`hp-bar-fill ${hpTone(fraction)}`} style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} />
                    </div>
                </div>
            </div>
            <div className="stat">
                <div className="stat-label">Combat level</div>
                <div className="stat-value">{player.combatLevel}</div>
            </div>
            <div className="stat">
                <div className="stat-label">Position</div>
                <div className="stat-value">
                    {player.x}, {player.z}
                </div>
            </div>
            {stateAge > 5000 && <span className="stale">Stale: {Math.round(stateAge / 1000)}s old</span>}
        </div>
    );
}

type ClientStatusLike = {
    desiredRunning: boolean;
    managed: boolean;
    gateway: 'active' | 'stale' | 'dead' | 'unknown';
    attachedKind: 'web' | 'lite' | null;
    gatewayError: string | null;
    lastExitCode: number | null;
    lastExitAt: number | null;
    spawnError: string | null;
    logPath: string;
};

/** One human-readable line + a tone for the badge/message, covering every
 * combination `manager/clientRegistry.ts`'s getClientStatus can report - see
 * its comments for what each field means and why. Kept as one function (not
 * scattered ternaries in the JSX) so BotList's compact view and BotDetail's
 * full view can't drift into describing the same status differently. */
function describeClientStatus(s: ClientStatusLike): { text: string; tone: 'idle' | 'ok' | 'caution' | 'error' } {
    if (s.spawnError) return { text: `Off - couldn't start the client process: ${s.spawnError}`, tone: 'error' };
    if (!s.desiredRunning) return { text: 'Off', tone: 'idle' };

    if (s.attachedKind === 'web') return { text: 'On - attached via a web client', tone: 'ok' };
    if (s.attachedKind === 'lite') {
        return s.managed
            ? { text: 'On - attached via the managed lite client', tone: 'ok' }
            : { text: "On - a lite client is attached, but not one this dashboard started (manual run, or left over from a daemon restart). Stop will mark it off but can't kill it.", tone: 'caution' };
    }

    if (s.gateway === 'unknown') {
        return { text: `On - couldn't check the gateway yet (${s.gatewayError ?? 'unreachable'}), will retry`, tone: 'caution' };
    }

    const recentExit = s.lastExitAt !== null && Date.now() - s.lastExitAt < 15000;
    if (recentExit && s.lastExitCode !== 0) {
        return { text: `On - last attempt exited with code ${s.lastExitCode}, retrying shortly. See ${s.logPath}`, tone: 'error' };
    }
    if (recentExit) {
        return { text: 'On - client stopped unexpectedly, retrying shortly', tone: 'caution' };
    }
    return { text: 'On - starting…', tone: 'ok' };
}

function ClientPanel({ botName }: { botName: string }) {
    const [fastPoll, setFastPoll] = useState(false);
    const { data: status, error, refresh } = usePolling(() => api.getClientStatus(botName), fastPoll ? 1200 : 5000, [botName, fastPoll]);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    useLiveRefresh(msg => {
        if ((msg.type === 'refresh' || msg.type === 'event') && msg.botId === botName) refresh();
    });

    useEffect(() => {
        if (!fastPoll) return;
        const t = setTimeout(() => setFastPoll(false), 15000);
        return () => clearTimeout(t);
    }, [fastPoll]);

    const toggle = async () => {
        if (!status) return;
        setBusy(true);
        setActionError(null);
        try {
            if (status.desiredRunning) await api.stopClient(botName);
            else await api.startClient(botName);
            setFastPoll(true); // watch closely while it spawns/connects (or fails)
            await refresh();
        } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    if (error && !status) return <ErrorBanner message={`Couldn't load client status: ${error}`} onRetry={refresh} />;
    if (!status) return <p className="loading-state">Loading client status…</p>;
    const described = describeClientStatus(status);
    return (
        <div className="client-panel">
            <p>
                <strong>Game client:</strong>
                <span className={`badge badge-${described.tone}`}>{status.desiredRunning ? 'on' : 'off'}</span>
                <span className={described.tone === 'error' ? 'error' : described.tone === 'caution' ? 'warn' : 'muted'}>{described.text}</span>
                <button onClick={toggle} disabled={busy}>
                    {busy ? 'Working…' : status.desiredRunning ? 'Stop' : 'Start'}
                </button>
            </p>
            {actionError && <ErrorBanner message={`Request failed: ${actionError}`} />}
            {error && <InlineWarning message={`Status may be stale: ${error}`} />}
        </div>
    );
}

function OpenWebclientButton({ botName }: { botName: string }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const open = async () => {
        setBusy(true);
        setError(null);
        try {
            const { url } = await api.getWebclientUrl(botName);
            window.open(url, '_blank');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <span className="webclient-open">
            <button onClick={open} disabled={busy}>
                {busy ? 'Opening…' : 'Open webclient'}
            </button>
            {error && <span className="error"> {error}</span>}
        </span>
    );
}

function GoalPanel({ bot, refresh }: { bot: BotDetailType; refresh: () => void }) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(bot.goal ?? '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!editing) setValue(bot.goal ?? '');
    }, [bot.goal, editing]);

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            await api.setGoal(bot.name, value.trim() || null);
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
                <strong>Goal:</strong> {bot.goal ?? <span className="muted">none set</span>}{' '}
                <button onClick={() => setEditing(true)}>Edit</button>
            </p>
        );
    }
    return (
        <div className="goal-edit">
            <input value={value} onChange={e => setValue(e.target.value)} placeholder="What should this bot be working toward?" />
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

function FleetPanel({ bot, refresh }: { bot: BotDetailType; refresh: () => void }) {
    const [fleets, setFleets] = useState<FleetRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        api.listFleets()
            .then(setFleets)
            .catch(err => setError(err instanceof Error ? err.message : String(err)));
    }, []);

    const onChange = async (fleetId: string) => {
        setError(null);
        try {
            await api.setFleet(bot.name, fleetId || null);
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    if (error) return <ErrorBanner message={`Couldn't load fleets: ${error}`} />;
    if (!fleets) return <p className="muted">Loading fleets…</p>;
    return (
        <p className="fleet-assign">
            <strong>Fleet:</strong>{' '}
            <select value={bot.fleetId ?? ''} onChange={e => onChange(e.target.value)}>
                <option value="">(none)</option>
                {fleets.map(f => (
                    <option key={f.id} value={f.id}>
                        {f.name}
                    </option>
                ))}
            </select>
            {bot.fleetId && (
                <>
                    {' '}
                    <a href={`#/fleets/${encodeURIComponent(bot.fleetId)}`}>view →</a>
                </>
            )}
        </p>
    );
}

function SkillsTable({ bot }: { bot: BotDetailType }) {
    const liveSkills = 'state' in bot.live ? bot.live.state.skills : null;
    if (liveSkills && liveSkills.length > 0) {
        return (
            <div className="table-wrap">
                <table className="skills-table">
                    <tbody>
                        {liveSkills.map(s => (
                            <tr key={s.name}>
                                <td>{s.name}</td>
                                <td>
                                    {s.baseLevel}
                                    {s.level !== s.baseLevel && <span className="muted"> ({s.level} boosted)</span>}
                                </td>
                                <td className="muted">{s.experience} xp</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    }
    const statusSkills = bot.status?.skills ?? {};
    const names = Object.keys(statusSkills);
    if (names.length === 0) return <p className="empty-state">No skill data yet.</p>;
    return (
        <div className="table-wrap">
            <table className="skills-table">
                <tbody>
                    {names.map(name => (
                        <tr key={name}>
                            <td>{name}</td>
                            <td>{statusSkills[name]!.level}</td>
                            <td className="muted">{statusSkills[name]!.xp} xp (last task's snapshot)</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function InventoryGrid({ bot }: { bot: BotDetailType }) {
    const inventory = 'state' in bot.live ? bot.live.state.inventory : null;
    if (!inventory) return <p className="empty-state">No live inventory (no client attached).</p>;
    if (inventory.length === 0) return <p className="empty-state">Empty.</p>;
    return (
        <ul className="item-grid">
            {inventory.map(item => (
                <li key={item.slot}>
                    {item.name} <span className="muted">×{item.count}</span>
                </li>
            ))}
        </ul>
    );
}

function BankGrid({ bot }: { bot: BotDetailType }) {
    const live = 'state' in bot.live ? bot.live.state.bank : null;
    if (live?.isOpen) {
        return (
            <ul className="item-grid">
                {live.items.map(item => (
                    <li key={item.slot}>
                        {item.name} <span className="muted">×{item.count}</span>
                    </li>
                ))}
            </ul>
        );
    }
    if (!bot.bankCache) return <p className="empty-state">No bank snapshot yet (bank has never been opened by a task).</p>;
    const entries = Object.entries(bot.bankCache.items);
    return (
        <>
            <p className="muted">Last known, {timeAgo(bot.bankCache.updatedAt)} (bank isn't currently open)</p>
            <ul className="item-grid">
                {entries.map(([name, count]) => (
                    <li key={name}>
                        {name} <span className="muted">×{count}</span>
                    </li>
                ))}
            </ul>
        </>
    );
}

function runBadgeClass(status: RunStatus): string {
    switch (status) {
        case 'running':
            return 'badge-run';
        case 'done':
            return 'badge-ok';
        case 'error':
            return 'badge-error';
        case 'cancelled':
            return 'badge-caution';
        case 'queued':
        default:
            return 'badge-idle';
    }
}

function RunRowItem({ run, onCancel, onRemove }: { run: RunRow; onCancel?: () => void; onRemove?: () => void }) {
    return (
        <li className="queue-entry">
            <span className="queue-task">{run.task}</span>
            <span className="queue-args muted">{run.args.join(' ')}</span>
            {run.error && (
                <span className="error" title={run.error}>
                    failed: {run.error}
                </span>
            )}
            <span className={`badge ${runBadgeClass(run.status)} queue-status`}>{run.status}</span>
            {onCancel && (
                <button className="btn-danger" onClick={onCancel}>
                    Cancel
                </button>
            )}
            {onRemove && (
                <button className="btn-danger" onClick={onRemove}>
                    Remove
                </button>
            )}
        </li>
    );
}

/** What the bot is doing *right now* - its own card next to the hero panel
 * (not merged into it) so it reads as a distinct, glanceable column in the
 * page's top row. Mirrors BotList.tsx's StatusBadge priority (needs
 * attention > running run > status's self-reported current task > idle)
 * so the two pages never describe the same bot differently. */
function CurrentActionPanel({ bot, refresh }: { bot: BotDetailType; refresh: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const running = bot.queue.running;
    const needsAttention = bot.status?.needsAttention ?? false;
    const taskName = running?.task ?? bot.status?.currentTask ?? null;
    const startedAt = running?.started_at ?? bot.status?.taskStartedAt ?? null;

    const cancel = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.cancelRunning(bot.name);
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="panel current-action-panel">
            <h3>Current action</h3>
            {error && <ErrorBanner message={error} />}
            <div className="current-action-row">
                {needsAttention ? (
                    <span className="badge badge-warn">needs attention</span>
                ) : taskName ? (
                    <span className="badge badge-run">{taskName}</span>
                ) : (
                    <span className="badge badge-idle">idle</span>
                )}
                {running && <span className="queue-args muted">{running.args.join(' ')}</span>}
                {startedAt && <span className="muted">started {timeAgo(startedAt)}</span>}
                {running && (
                    <button className="btn-danger" onClick={cancel} disabled={busy}>
                        {busy ? 'Cancelling…' : 'Cancel'}
                    </button>
                )}
            </div>
            {bot.status?.lastAction && <p className="current-action-detail">{bot.status.lastAction}</p>}
            {bot.status?.lastError && <p className="error current-action-detail">{bot.status.lastError}</p>}
        </section>
    );
}

function QueuePanel({ bot, refresh }: { bot: BotDetailType; refresh: () => void }) {
    const [actionError, setActionError] = useState<string | null>(null);

    const act = async (fn: () => Promise<unknown>) => {
        setActionError(null);
        try {
            await fn();
            refresh();
        } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err));
        }
    };
    return (
        <div className="queue-panel">
            {actionError && <ErrorBanner message={actionError} />}
            {bot.queue.queued.length > 0 ? (
                <ul className="queue-list">
                    {bot.queue.queued.map(run => (
                        <RunRowItem key={run.id} run={run} onRemove={() => act(() => api.removeQueued(bot.name, run.id))} />
                    ))}
                </ul>
            ) : (
                <p className="empty-state">Nothing queued.</p>
            )}

            <h4>History</h4>
            {bot.queue.history.length === 0 ? (
                <p className="empty-state">No runs yet.</p>
            ) : (
                <ul className="queue-list">
                    {bot.queue.history.map(run => (
                        <RunRowItem key={run.id} run={run} />
                    ))}
                </ul>
            )}

            <h4>Queue a task</h4>
            <TaskForm botName={bot.name} onQueued={refresh} />
        </div>
    );
}

/** `Date.now()`'s day for "is this timestamp from today" - events can span
 * days, so the formatted time needs a date whenever it isn't. */
function isToday(ts: number): boolean {
    const d = new Date(ts);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function formatEventTime(ts: number): string {
    return new Intl.DateTimeFormat(undefined, {
        ...(isToday(ts) ? {} : { month: 'short', day: 'numeric' }),
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(new Date(ts));
}

const EVENT_KNOWN_KEYS = new Set(['ts', 'task', 'level', 'msg', 'event']);

function formatExtraValue(v: unknown): string {
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
}

/** `logEvent()` (tasks/lib/status.ts) writes free-form objects - always a
 * `ts`, usually a `task` label, then either `{level, msg}` or `{event,
 * ...fields}`. Pulls those apart instead of dumping the raw JSON so the
 * timestamp, task, severity and message each get their own styled slot,
 * with anything left over shown as compact "key: value" chips. */
function LogEntryItem({ entry }: { entry: Record<string, unknown> }) {
    const ts = typeof entry.ts === 'number' ? entry.ts : null;
    const task = typeof entry.task === 'string' ? entry.task : null;
    const level = typeof entry.level === 'string' ? entry.level : null;
    const event = typeof entry.event === 'string' ? entry.event : null;
    const msg = typeof entry.msg === 'string' ? entry.msg : null;
    const title = msg ?? (event ? event.replace(/_/g, ' ') : 'event');
    const extras = Object.entries(entry).filter(([k, v]) => !EVENT_KNOWN_KEYS.has(k) && v !== undefined);

    return (
        <li className="log-entry">
            <span className="log-time muted">{ts !== null ? formatEventTime(ts) : '-'}</span>
            {task && <span className="badge badge-outline">{task}</span>}
            {level && <span className={`badge badge-${level === 'error' ? 'error' : 'caution'}`}>{level}</span>}
            <span className={level === 'error' ? 'error' : 'log-title'}>{title}</span>
            {extras.length > 0 && (
                <span className="log-extras muted">{extras.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${formatExtraValue(v)}`).join(' · ')}</span>
            )}
        </li>
    );
}

function LogFeed({ botName }: { botName: string }) {
    const { data: lines, error, loading } = usePolling(() => api.getLog(botName, 100), 5000, [botName]);
    if (error && !lines) return <ErrorBanner message={error} />;
    if (loading && !lines) return <p className="loading-state">Loading…</p>;
    if (!lines || lines.length === 0) return <p className="empty-state">No events logged yet.</p>;
    return (
        <>
            {error && <InlineWarning message={`Feed may be stale: ${error}`} />}
            <ul className="log-feed">
                {lines
                    .slice()
                    .reverse()
                    .map((line, i) => (
                        <LogEntryItem key={i} entry={line as Record<string, unknown>} />
                    ))}
            </ul>
        </>
    );
}

function ActionRowItem({ action }: { action: ActionRow }) {
    const [expanded, setExpanded] = useState(false);
    const ts = new Date(action.started_at).toLocaleTimeString();
    return (
        <li className={`action-entry ${action.success === 0 ? 'action-failed' : ''}`} onClick={() => setExpanded(e => !e)}>
            <span className="muted">{ts}</span> <span className="action-method">{action.method}</span>{' '}
            <span className="muted">{action.duration_ms}ms</span>
            {action.success === 0 && <span className="action-error"> failed</span>}
            {expanded && (
                <pre className="action-detail">
                    {`args: ${action.args ?? '-'}\n${action.error ? `error: ${action.error}` : `result: ${action.result ?? '-'}`}`}
                </pre>
            )}
        </li>
    );
}

function ActionLog({ botName }: { botName: string }) {
    const { data: actions, error, loading } = usePolling(() => api.getActions(botName, { limit: 100 }), 5000, [botName]);
    if (error && !actions) return <ErrorBanner message={error} />;
    if (loading && !actions) return <p className="loading-state">Loading…</p>;
    if (!actions || actions.length === 0) return <p className="empty-state">No actions recorded yet - run a task or use execute_code.</p>;
    return (
        <>
            {error && <InlineWarning message={`Log may be stale: ${error}`} />}
            <ul className="log-feed action-log">
                {actions.map(a => (
                    <ActionRowItem key={a.id} action={a} />
                ))}
            </ul>
        </>
    );
}

function NotesPanel({ botName, notes, refresh }: { botName: string; notes: BotDetailType['notes']; refresh: () => void }) {
    const [content, setContent] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!content.trim()) return;
        setSaving(true);
        setError(null);
        try {
            await api.addNote(botName, content.trim());
            setContent('');
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
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
            {error && <ErrorBanner message={error} />}
            {notes.length === 0 ? (
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
        </div>
    );
}

export function BotDetail({ name }: { name: string }) {
    const { data: bot, error, offline, loading, refresh } = usePolling(() => api.getBot(name), 3000, [name]);

    useLiveRefresh(msg => {
        if (msg.type === 'refresh' && msg.botId === name) refresh();
        if (msg.type === 'event' && msg.botId === name) refresh();
    });

    return (
        <div className="bot-detail">
            <a className="back-link" href="#/">
                ← all bots
            </a>
            {error && <ErrorBanner message={error} offline={offline} onRetry={refresh} />}
            {loading && !bot ? (
                <p className="loading-state">Loading {name}…</p>
            ) : !bot ? null : (
                <>
                    <div className="top-row">
                        <div className="hero-panel">
                            <div className="hero-top">
                                <div className="hero-identity">
                                    <h2>{name}</h2>
                                    <div className="hero-meta">
                                        <span>{bot.server ?? 'default server'}</span>
                                    </div>
                                </div>
                                <div className="hero-actions">
                                    <OpenWebclientButton botName={name} />
                                </div>
                            </div>
                            <HeroStats bot={bot} />
                            <ClientPanel botName={name} />
                            <GoalPanel bot={bot} refresh={refresh} />
                            <FleetPanel bot={bot} refresh={refresh} />
                        </div>
                        <CurrentActionPanel bot={bot} refresh={refresh} />
                    </div>
                    <div className="detail-grid">
                        <section className="panel full-row">
                            <h3>Queue</h3>
                            <QueuePanel bot={bot} refresh={refresh} />
                        </section>
                        <section className="panel">
                            <h3>Skills</h3>
                            <SkillsTable bot={bot} />
                        </section>
                        <section className="panel">
                            <h3>Inventory</h3>
                            <InventoryGrid bot={bot} />
                        </section>
                        <section className="panel">
                            <h3>Bank</h3>
                            <BankGrid bot={bot} />
                        </section>
                        <section className="panel">
                            <h3>Recent activity</h3>
                            <LogFeed botName={name} />
                        </section>
                        <section className="panel">
                            <h3>Action log</h3>
                            <ActionLog botName={name} />
                        </section>
                        <section className="panel">
                            <h3>Notes</h3>
                            <NotesPanel botName={name} notes={bot.notes} refresh={refresh} />
                        </section>
                    </div>
                </>
            )}
        </div>
    );
}
