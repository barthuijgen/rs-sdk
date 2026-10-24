/** Consistent error presentation used everywhere instead of ad-hoc
 * `<p className="error">`. `offline` (set when the fetch never reached the
 * daemon - see api.ts's ApiError) gets the one-line fix from the README
 * instead of a raw network error message, since that's almost always what
 * actually happened in dev. */
export function ErrorBanner({ message, offline, onRetry }: { message: string; offline?: boolean; onRetry?: () => void }) {
    return (
        <div className={`error-banner${offline ? ' error-banner-offline' : ''}`} role="alert">
            <span className="error-banner-icon" aria-hidden="true">
                {offline ? '⚡' : '⚠'}
            </span>
            <span className="error-banner-message">{message}</span>
            {onRetry && (
                <button type="button" className="error-banner-retry" onClick={onRetry}>
                    Retry
                </button>
            )}
        </div>
    );
}

/** Same message, styled to sit inline above/below a panel's content rather
 * than replacing it - for the "poll failed but we still have stale data to
 * show" case. */
export function InlineWarning({ message }: { message: string }) {
    return (
        <p className="inline-warning" role="alert">
            <span aria-hidden="true">{'⚠'}</span> {message}
        </p>
    );
}
