import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import {
  createProcessesAnswer,
  PROCESSES_FIXTURE_BYTES,
} from '@/components/machines/processes/testkit/processesAnswerFixture';

import { ItemList } from '@/components/ui/lists/ItemList';

import { MachineUsingTheMost } from './MachineUsingTheMost';

const { MB, GB } = PROCESSES_FIXTURE_BYTES;
afterEach(() => standardCleanup());

function answerWithFiveOwners() {
  const base = createProcessesAnswer();
  const small = (id: string, memoryBytes: number) => ({
    ...base.owners[2]!,
    rowId: `service:${id}`,
    owner: { kind: 'service' as const, serviceId: id },
    totals: { processCount: 1, memoryBytes, cpuPercent: 0.1 },
  });
  return {
    ...base,
    owners: [
      ...base.owners.map((owner) => ({ ...owner, members: [] })),
      small('tiny', 2 * MB),
      small('small', 40 * MB),
    ],
  };
}

const sample: MachineVitalsSampleV1 = {
  v: 1,
  sampledAt: 1_000,
  intervalMs: 2_000,
  cpu: { reported: true, busyPct: 30 },
  memory: {
    reported: true,
    totalBytes: 64 * GB,
    availableBytes: 40 * GB,
    usedBytes: 24 * GB,
    pressure: { level: 'calm', source: 'psi' },
  },
  disk: { reported: true, volumes: [] },
  network: { reported: false, reason: 'unavailable' },
};

it('shows the four biggest owners read-only, closes with the totals, and every way in opens Processes', async () => {
  const answer = answerWithFiveOwners();
  const open = vi.fn();
  const screen = await renderScreen(
    <ItemList><MachineUsingTheMost
      serverId="server"
      machineId="machine"
      machineName="leeroy-mbp"
      sample={sample}
      cpuCapacityCores={18}
      processes={answer}
      processesStatus="ready"
      offline={false}
      onOpenProcesses={open}
    /></ItemList>,
  );
  await measureMountedCollections(screen, { width: 1200 });

  const memoryCells = screen.findAll(
    (node) =>
      typeof node.props.testID === 'string' &&
      node.props.testID.startsWith('machine-processes-memory-') &&
      typeof node.type === 'string',
  );
  const shown = [
    ...new Set(
      memoryCells.map((node) =>
        String(node.props.testID).slice('machine-processes-memory-'.length),
      ),
    ),
  ];
  expect(shown).toHaveLength(4);
  // The smallest owner is the one left for the tab.
  expect(shown.some((key) => key.includes('tiny'))).toBe(false);
  // Read-only: the tab's row menu is not offered here.
  expect(
    screen.findAll((node) =>
      String(node.props.testID ?? '').startsWith('machine-processes-menu-'),
    ),
  ).toHaveLength(0);

  const text = screen.getTextContent();
  expect(text).toContain('Happier in total');
  expect(text).toContain(`${answer.totals.happier.processCount} in Processes`);
  expect(text).toContain('Everything else on leeroy-mbp');

  await screen.pressByTestIdAsync('machine-using-the-most-count');
  await screen.pressByTestIdAsync('machine-using-the-most-open');
  expect(open).toHaveBeenCalledTimes(2);
});

const renderWith = (
  processes: React.ComponentProps<typeof MachineUsingTheMost>['processes'],
  processesStatus: React.ComponentProps<typeof MachineUsingTheMost>['processesStatus'] = processes ? 'ready' : 'loading',
  offline = false,
) => renderScreen(
  <ItemList><MachineUsingTheMost
    serverId="server"
    machineId="machine"
    machineName="leeroy-mbp"
    sample={sample}
    cpuCapacityCores={18}
    processes={processes}
    processesStatus={processesStatus}
    offline={offline}
    onOpenProcesses={() => {}}
  /></ItemList>,
);

it('keeps its place with one quiet line when nothing Happier started is running, or while it is read, or when it cannot be', async () => {
  const none = await renderWith({ ...createProcessesAnswer(), owners: [] });
  expect(none.findByTestId('machine-using-the-most')).toBeNull();
  expect(none.findByTestId('machine-using-the-most-empty')).toBeTruthy();
  expect(none.findByTestId('machine-using-the-most-open')).toBeTruthy();

  const reading = await renderWith(null);
  expect(reading.findByTestId('machine-using-the-most-reading')).toBeTruthy();

  const failed = await renderWith({ ...createProcessesAnswer(), state: 'unavailable' as const });
  expect(failed.findByTestId('machine-using-the-most-unavailable')).toBeTruthy();
});

it('does not keep reading after the Processes read failed, and does not call a failed read empty', async () => {
  for (const status of ['error', 'unavailable', 'not_supported'] as const) {
    const failed = await renderWith(null, status);
    expect(failed.findByTestId('machine-using-the-most-reading')).toBeNull();
    expect(failed.findByTestId('machine-using-the-most-empty')).toBeNull();
    expect(failed.findByTestId('machine-using-the-most-unavailable')).toBeTruthy();
  }
});

it('says an offline machine has no census to read, instead of calling it a failed read or still reading', async () => {
  const offline = await renderWith(null, 'unavailable', true);
  expect(offline.findByTestId('machine-using-the-most-offline')).toBeTruthy();
  expect(offline.findByTestId('machine-using-the-most-unavailable')).toBeNull();
  expect(offline.findByTestId('machine-using-the-most-reading')).toBeNull();
});
