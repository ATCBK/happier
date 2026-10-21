import * as React from 'react';
import {
  PublicProfileOwnerReadV1Schema,
  type PublicProfileOwnerReadV1,
} from '@happier-dev/protocol/account/publicProfilePublication';

import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

export type PublicProfileOwnerReadState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{
      kind: 'ready';
      read: PublicProfileOwnerReadV1;
      refreshing: boolean;
    }>
  | Readonly<{ kind: 'failed' }>;

type AccountExecution = Pick<
  ReturnType<typeof useMountedActionExecution>,
  'executeValue' | 'ready'
>;

/**
 * The owner's applied edition through `account.public_profile.get`: read once when the Account's
 * mounted Action owner becomes ready, and again only on request. A refresh keeps the last read on
 * screen; a failed refresh keeps it too, because the page it describes did not change.
 */
export function usePublicProfileOwnerRead(
  execution: AccountExecution,
): Readonly<{
  state: PublicProfileOwnerReadState;
  reload: () => Promise<void>;
}> {
  const [state, setState] = React.useState<PublicProfileOwnerReadState>({
    kind: 'loading',
  });
  // The mounted owner hands out a new callback on every render; reads follow the latest one
  // without restarting, so a re-render never issues another request.
  const executeValue = React.useRef(execution.executeValue);
  executeValue.current = execution.executeValue;
  const reload = React.useCallback(async () => {
    setState((current) =>
      current.kind === 'ready'
        ? { ...current, refreshing: true }
        : { kind: 'loading' },
    );
    try {
      const read = PublicProfileOwnerReadV1Schema.parse(
        await executeValue.current('account.public_profile.get', {}),
      );
      setState({ kind: 'ready', read, refreshing: false });
    } catch {
      setState((current) =>
        current.kind === 'ready'
          ? { ...current, refreshing: false }
          : { kind: 'failed' },
      );
    }
  }, []);
  const { ready } = execution;
  React.useEffect(() => {
    if (ready) void reload();
  }, [ready, reload]);
  return { state, reload };
}
