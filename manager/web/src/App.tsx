import { useEffect, useState } from 'react';
import { BotList } from './BotList';
import { BotDetail } from './BotDetail';
import { FleetList } from './FleetList';
import { FleetDetail } from './FleetDetail';
import { NotificationBell } from './NotificationBell';
import { ErrorBoundary } from './ErrorBoundary';
import { LiveConnectionProvider, useConnectionState } from './LiveConnection';

type Route = { page: 'list' } | { page: 'bot'; name: string } | { page: 'fleets' } | { page: 'fleet'; id: string };

function parseRoute(hash: string): Route {
    const bot = hash.match(/^#\/bots\/(.+)$/);
    if (bot) return { page: 'bot', name: decodeURIComponent(bot[1]!) };
    const fleet = hash.match(/^#\/fleets\/(.+)$/);
    if (fleet) return { page: 'fleet', id: decodeURIComponent(fleet[1]!) };
    if (hash === '#/fleets') return { page: 'fleets' };
    return { page: 'list' };
}

const routeKey = (r: Route) => `${r.page}:${'name' in r ? r.name : 'id' in r ? r.id : ''}`;

/** Honest "is the live-update channel actually working" indicator - it
 * never gates data, since polling (usePolling) keeps the dashboard working
 * either way, but a silently-dead socket otherwise looks identical to one
 * that's fine. */
function ConnectionIndicator() {
    const state = useConnectionState();
    const label = state === 'connected' ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Polling only';
    return (
        <span className="connection-indicator" title={state === 'disconnected' ? "Live-update socket is down; falling back to periodic polling." : undefined}>
            <span className={`connection-dot ${state === 'connected' ? 'live' : state === 'disconnected' ? 'down' : ''}`} />
            {label}
        </span>
    );
}

function Nav({ route }: { route: Route }) {
    const onFleets = route.page === 'fleets' || route.page === 'fleet';
    return (
        <nav>
            <a href="#/" className={route.page === 'list' || route.page === 'bot' ? 'active' : undefined}>
                Bots
            </a>
            <a href="#/fleets" className={onFleets ? 'active' : undefined}>
                Fleets
            </a>
        </nav>
    );
}

function AppShell() {
    const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

    useEffect(() => {
        const onHashChange = () => setRoute(parseRoute(window.location.hash));
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    return (
        <div className="app">
            <header className="app-header">
                <a href="#/" className="app-title">
                    <span className="logo-dot" />
                    Bot Manager
                </a>
                <Nav route={route} />
                <div className="app-header-right">
                    <ConnectionIndicator />
                    <NotificationBell />
                </div>
            </header>
            <main>
                <ErrorBoundary resetKey={routeKey(route)}>
                    {route.page === 'bot' && <BotDetail name={route.name} />}
                    {route.page === 'fleets' && <FleetList />}
                    {route.page === 'fleet' && <FleetDetail id={route.id} />}
                    {route.page === 'list' && <BotList />}
                </ErrorBoundary>
            </main>
        </div>
    );
}

export default function App() {
    return (
        <LiveConnectionProvider>
            <AppShell />
        </LiveConnectionProvider>
    );
}
