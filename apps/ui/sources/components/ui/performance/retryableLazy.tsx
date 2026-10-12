import * as React from 'react';

export function retryableLazy<Props extends object>(
    load: () => Promise<{ default: React.ComponentType<Props> }>,
): React.ComponentType<Props> {
    let rejected = false;
    const loadNext = () => load().catch((error: unknown) => {
        rejected = true;
        throw error;
    });
    let Content = React.lazy(loadNext);
    class DemandBoundary extends React.Component<{ contentProps: Props }, { failed: boolean }> {
        state = { failed: false };

        static getDerivedStateFromError() {
            return { failed: true };
        }

        componentDidCatch(error: unknown) {
            // Retire only a committed rejection. Resetting during rendering or
            // promise settlement would silently retry during Suspense recovery.
            if (rejected) {
                rejected = false;
                Content = React.lazy(loadNext);
            }
            throw error;
        }

        render() {
            // Forward to the existing boundary and its retry UI. This host adds
            // no fallback and keeps successful component identities unchanged.
            if (this.state.failed) return null;
            return React.createElement(Content, this.props.contentProps);
        }
    }
    // Keep refs in the forwarded props rather than attaching them to the boundary.
    return function RetryableLazy(props: Props) {
        return React.createElement(DemandBoundary, { contentProps: props });
    };
}
