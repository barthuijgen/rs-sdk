import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
    children: ReactNode;
    /** Remounts the subtree (clearing the caught error) whenever this
     * changes - used to reset the boundary on route changes, so a crash on
     * one bot's page doesn't keep the whole app stuck on an error screen
     * after navigating away. */
    resetKey?: unknown;
}

interface State {
    error: Error | null;
    resetKey: unknown;
}

/** Catches render/lifecycle errors in its subtree so one bad page (e.g. a
 * shape the API never used to return) shows a message instead of a blank
 * white app with only a console error no one's watching. */
export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null, resetKey: this.props.resetKey };

    // Clears a caught error as soon as `resetKey` (the route) changes,
    // derived during render rather than via componentDidUpdate's setState
    // so this doesn't trigger an extra render pass.
    static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
        if (props.resetKey !== state.resetKey) {
            return { error: null, resetKey: props.resetKey };
        }
        return null;
    }

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('Dashboard crashed:', error, info.componentStack);
    }

    render() {
        if (this.state.error) {
            return (
                <div className="error-banner error-banner-fatal" role="alert">
                    <span className="error-banner-icon" aria-hidden="true">
                        {'⚠'}
                    </span>
                    <span className="error-banner-message">
                        Something went wrong rendering this page: {this.state.error.message}
                    </span>
                    <button type="button" className="error-banner-retry" onClick={() => this.setState({ error: null })}>
                        Try again
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
