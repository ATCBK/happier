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

type AccountExecution = ReturnType<typeof useMountedActionExecution>;

/**
 * The owner's applied edition through `account.public_profile.get`. A refresh keeps the last read
 * on screen; a failed refresh keeps it too, because the page it describes did not change.
 */
export function usePublicProfileOwnerRead(
  execution: AccountExecution,
): Readonly<{
  state: PublicProfileOwnerReadState;
  reload: () => Promise<void>;
  apply: (read: PublicProfileOwnerReadV1) => void;
}> {
  const [state, setState] = React.useState<PublicProfileOwnerReadState>({
    kind: 'loading',
  });
  const { executeValue, ready } = execution;
  const reload = React.useCallback(async () => {
    setState((current) =>
      current.kind === 'ready'
        ? { ...current, refreshing: true }
        : { kind: 'loading' },
    );
    try {
      const read = PublicProfileOwnerReadV1Schema.parse(
        await executeValue('account.public_profile.get', {}),
      );
      setState({ kind: 'ready', read, refreshing: false });
    } catch {
      setState((current) =>
        current.kind === 'ready'
          ? { ...current, refreshing: false }
          : { kind: 'failed' },
      );
    }
  }, [executeValue]);
  const apply = React.useCallback(
    (read: PublicProfileOwnerReadV1) =>
      setState({ kind: 'ready', read, refreshing: false }),
    [],
  );
  React.useEffect(() => {
    if (ready) void reload();
  }, [ready, reload]);
  return { state, reload, apply };
}
