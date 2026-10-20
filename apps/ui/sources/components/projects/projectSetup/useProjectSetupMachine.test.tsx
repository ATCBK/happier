import { afterEach, describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { useProjectSetupMachine } from './useProjectSetupMachine';

const serverId = 'home';

function seedMachines(...machines: ReturnType<typeof createMachineFixture>[]) {
  storage.setState({
    machines: Object.fromEntries(machines.map((machine) => [machine.id, machine])),
    machineListByServerId: { [serverId]: machines },
    machineListStatusByServerId: { [serverId]: 'idle' },
  });
}

describe('useProjectSetupMachine', () => {
  afterEach(() => seedMachines());

  it('names a readable machine for the Project setup sentences', async () => {
    seedMachines(createMachineFixture({ id: 'devbox', metadata: { displayName: 'Dev box', host: 'devbox.local' } as never }));
    const hook = await renderHook(() => useProjectSetupMachine(serverId, 'devbox'));
    expect(hook.getCurrent().machineName).toBe('Dev box');
    await hook.unmount();
  });

  it('says "this machine" for a machine this device cannot read, never the locked placeholder', async () => {
    seedMachines(createMachineFixture({
      id: 'devbox', metadata: null, availability: { kind: 'locked', reason: 'encryption_material_unavailable' },
    }));
    const hook = await renderHook(() => useProjectSetupMachine(serverId, 'devbox'));
    expect(hook.getCurrent().machineName).toBe(t('machine.thisMachineInSentence'));
    await hook.unmount();
  });
});
