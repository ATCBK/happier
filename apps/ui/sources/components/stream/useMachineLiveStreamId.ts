import * as React from 'react';

/** A remounted subscriber must not inherit the previous subscriber's in-flight Stop. */
export function useMachineLiveStreamId(sourceViewerId: string): string {
    const subscriptionId = React.useId();
    return sourceViewerId ? `${sourceViewerId}:${subscriptionId}` : '';
}
