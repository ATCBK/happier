import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks();

const { BotsListEntryRow } = await import('./BotsListEntryRow');
const { BotsRosterRuntimeProvider, useOptionalBotsRosterRuntime } =
  await import('./BotsRosterRuntime');

/** Stands in for the rail's Bots button: the anchored opener the runtime prefers when one is mounted. */
function AnchoredOpener(props: Readonly<{ open: () => void }>) {
  const runtime = useOptionalBotsRosterRuntime();
  React.useEffect(
    () => runtime?.registerAnchoredOpener(props.open),
    [props.open, runtime],
  );
  return null;
}

describe('BotsListEntryRow (lab b-rail Ap)', () => {
  it('opens the one Bots roster through the roster runtime', async () => {
    const open = vi.fn();
    const screen = await renderScreen(
      <BotsRosterRuntimeProvider>
        <AnchoredOpener open={open} />
        <BotsListEntryRow />
      </BotsRosterRuntimeProvider>,
    );
    await screen.pressByTestIdAsync('bots-list-entry');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('is absent where no roster runtime exists', async () => {
    const screen = await renderScreen(<BotsListEntryRow />);
    expect(screen.findAllByTestId('bots-list-entry')).toHaveLength(0);
  });
});
