import { useState } from 'react';
import { api } from './api';
import { usePolling } from './usePolling';
import { useLiveRefresh } from './LiveConnection';

export function NotificationBell() {
    const { data: notifications, error, refresh } = usePolling(api.listNotifications, 10000);
    const [open, setOpen] = useState(false);
    const [ackError, setAckError] = useState<string | null>(null);
    useLiveRefresh(msg => {
        if (msg.type === 'event') refresh();
    });

    const count = notifications?.length ?? 0;

    const ack = async (id: number) => {
        setAckError(null);
        try {
            await api.ackNotification(id);
            refresh();
        } catch (err) {
            setAckError(err instanceof Error ? err.message : String(err));
        }
    };

    return (
        <div className="notification-bell">
            <button onClick={() => setOpen(o => !o)} aria-expanded={open}>
                Notifications{count > 0 ? ` (${count})` : ''}
            </button>
            {open && (
                <div className="notification-dropdown">
                    {ackError && <p className="error">{ackError}</p>}
                    {error ? (
                        <p className="error">Couldn't load notifications: {error}</p>
                    ) : !notifications ? (
                        <p className="loading-state">Loading…</p>
                    ) : notifications.length === 0 ? (
                        <p className="empty-state">Nothing pending.</p>
                    ) : (
                        <ul>
                            {notifications.map(n => (
                                <li key={n.id}>
                                    <span className="muted">{new Date(n.created_at).toLocaleTimeString()}</span> {n.event_type}
                                    {n.bot_id && <> on {n.bot_id}</>}
                                    <button onClick={() => ack(n.id)}>Ack</button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
