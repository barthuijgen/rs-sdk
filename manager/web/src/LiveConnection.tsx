import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type LiveMessage = { type: string; botId?: string; fleetId?: string; [key: string]: unknown };
export type LiveConnectionState = 'connecting' | 'connected' | 'disconnected';

type Listener = (msg: LiveMessage) => void;

interface LiveContextValue {
    state: LiveConnectionState;
    subscribe: (fn: Listener) => () => void;
}

const LiveContext = createContext<LiveContextValue | null>(null);

/** Owns the single WebSocket connection to the daemon's refresh channel
 * (manager/liveUpdates.ts) for the whole app - every page used to open its
 * own socket via a per-component `useEffect`, which meant up to five live
 * sockets for one bot's detail page alone and no single place that knew
 * whether "live" updates were actually working. Now there's exactly one
 * socket and one connection state, fanned out to subscribers; polling
 * (usePolling) stays the robust fallback regardless. */
export function LiveConnectionProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<LiveConnectionState>('connecting');
    const listenersRef = useRef(new Set<Listener>());

    useEffect(() => {
        let ws: WebSocket | null = null;
        let closed = false;
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

        const connect = () => {
            if (closed) return;
            setState('connecting');
            ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/ws`);
            ws.onopen = () => setState('connected');
            ws.onmessage = event => {
                let msg: LiveMessage;
                try {
                    msg = JSON.parse(event.data);
                } catch {
                    return; // ignore malformed frames
                }
                for (const fn of listenersRef.current) fn(msg);
            };
            ws.onclose = () => {
                setState('disconnected');
                if (!closed) reconnectTimer = setTimeout(connect, 2000);
            };
            ws.onerror = () => ws?.close();
        };
        connect();

        return () => {
            closed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            ws?.close();
        };
    }, []);

    const subscribe = (fn: Listener) => {
        listenersRef.current.add(fn);
        return () => listenersRef.current.delete(fn);
    };

    return <LiveContext.Provider value={{ state, subscribe }}>{children}</LiveContext.Provider>;
}

/** Subscribes `onMessage` to the shared live-update socket for the
 * lifetime of the calling component. Drop-in replacement for the old
 * per-component-socket hook of the same name. */
export function useLiveRefresh(onMessage: Listener) {
    const ctx = useContext(LiveContext);
    const handlerRef = useRef(onMessage);
    handlerRef.current = onMessage;

    useEffect(() => {
        if (!ctx) return;
        return ctx.subscribe(msg => handlerRef.current(msg));
    }, [ctx]);
}

/** The shared socket's connection state, for a small "live"/"polling only"
 * indicator - not meant to gate any data fetch, since polling always keeps
 * working regardless of this value. */
export function useConnectionState(): LiveConnectionState {
    const ctx = useContext(LiveContext);
    return ctx?.state ?? 'connecting';
}
