import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/** Polls `fetcher` every `intervalMs`, matching the project's existing
 * "cheap poll of a small file" philosophy (tasks/checkup.ts) instead of a
 * push channel. Re-fetches immediately when `deps` change.
 *
 * `loading` is true only until the *first* request settles (success or
 * failure) - a later poll failure keeps whatever `data` is already on
 * screen and just surfaces `error` alongside it, so a flaky poll doesn't
 * blank out a working view. `offline` mirrors `ApiError.offline` so callers
 * can show the "start the daemon" hint instead of a raw message. */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [offline, setOffline] = useState(false);
    const [loading, setLoading] = useState(true);
    const fetcherRef = useRef(fetcher);
    fetcherRef.current = fetcher;

    const refresh = useCallback(async () => {
        try {
            const result = await fetcherRef.current();
            setData(result);
            setError(null);
            setOffline(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setOffline(err instanceof ApiError && err.offline);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        const tick = async () => {
            if (cancelled) return;
            await refresh();
        };
        tick();
        const id = setInterval(tick, intervalMs);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);

    return { data, error, offline, loading, refresh };
}
