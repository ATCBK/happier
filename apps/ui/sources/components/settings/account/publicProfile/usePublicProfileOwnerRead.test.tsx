import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { usePublicProfileOwnerRead } from './usePublicProfileOwnerRead';

const context = { handle: 'leeroy', identity: {}, service: null, urls: null };

function Probe(props: Readonly<{ read: (actionId: string, input: unknown) => Promise<unknown> }>) {
  const [, rerender] = React.useState(0);
  // The mounted Action owner hands out a fresh callback on each render; the read must not follow it.
  const execution = { ready: true, executeValue: (actionId: string, input: unknown) => props.read(actionId, input) } as never;
  const { state } = usePublicProfileOwnerRead(execution);
  React.useEffect(() => { if (state.kind === 'ready') rerender(value => value + 1); }, [state]);
  return null;
}

describe('usePublicProfileOwnerRead', () => {
  it('reads the owner record once per mounted Account, even while its host re-renders', async () => {
    const read = vi.fn(async () => ({ kind: 'absent', context }));
    await renderScreen(<Probe read={read} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('account.public_profile.get', {});
  });
});
