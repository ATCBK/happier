import * as React from 'react';
import { afterEach, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ItemList } from '@/components/ui/lists/ItemList';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';

import { MachineOfflineAlertRow } from './MachineAlertsPage';

const before = storage.getState();
afterEach(() => {
  standardCleanup();
  storage.setState(before);
});

async function renderRow(isShared: boolean | undefined) {
  storage.setState({
    settingsScope: { serverId: 'home-a', accountId: 'owner' },
    profileScope: { serverId: 'home-a', accountId: 'owner' },
    settings: settingsParse({ machineOfflineAlertsV1: { machineIds: [] } }),
    machines: {},
    machineListByServerId: {},
  });
  return renderScreen(
    <ItemList>
      <MachineOfflineAlertRow
        serverId="home-a"
        machine={{
          id: 'machine',
          ...(isShared === undefined ? {} : { isShared }),
        }}
        machineName="edge-1"
      />
    </ItemList>,
  );
}

it.each([
  ['unknown', undefined],
  ['not shared', false],
] as const)('offers the offline switch on a machine whose shared projection is %s', async (_label, isShared) => {
  const screen = await renderRow(isShared);
  expect(screen.findByTestId('machine-alerts-offline-switch')).not.toBeNull();
  expect(screen.getTextContent()).toContain('Tell me when edge-1 goes offline');
});

it('on a machine shared with this viewer, says the owner gets offline alerts and offers no switch', async () => {
  const screen = await renderRow(true);
  expect(screen.findByTestId('machine-alerts-offline-switch')).toBeNull();
  expect(screen.getTextContent()).toContain(
    'Offline alerts for edge-1 go to its owner.',
  );
});
