import * as React from 'react';
import type { ExecutionRunChildChoiceV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ExecutionRunChildSelection } from './executionRunChildChoice';

type PendingChoice = Readonly<{
    choice: ExecutionRunChildChoiceV1;
    retry: (selection: ExecutionRunChildSelection) => Promise<unknown>;
}>;

/**
 * The child chooser's state. A refused start offers a choice only with host proof that no Run was
 * created (`readExecutionRunChildChoice`); every new attempt consumes the previous choice first, so
 * an unknown-effect or lost start never keeps a replay chooser. The launcher's own start path
 * performs each attempt.
 */
export function useExecutionRunChildChoice() {
    const [pending, setPending] = React.useState<PendingChoice | null>(null);
    const begin = React.useCallback(() => setPending(null), []);
    const offer = React.useCallback((choice: ExecutionRunChildChoiceV1 | null, retry: PendingChoice['retry']) => {
        setPending(choice ? { choice, retry } : null);
        return choice !== null;
    }, []);
    const choose = React.useCallback((selection: ExecutionRunChildSelection) => {
        if (!pending) return Promise.resolve(null);
        setPending(null);
        return pending.retry(selection);
    }, [pending]);
    const cancel = React.useCallback(() => setPending(null), []);
    return { choice: pending?.choice ?? null, begin, offer, choose, cancel };
}
