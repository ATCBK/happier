import { describe, expect, it } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

import { getMachineDropdownMenuItems } from './machineDropdownItems';

const machine = (id: string, metadata: Partial<NonNullable<Machine['metadata']>> | null): Machine => createMachineFixture({
  id, metadata: metadata === null ? null : { ...createMachineFixture().metadata!, ...metadata },
});

describe('getMachineDropdownMenuItems', () => {
  it('names a machine by its display name or host, and never by its raw id while its details are still loading', () => {
    const items = getMachineDropdownMenuItems({
      machines: [
        machine('3e2668a5-c519-4849-bf83-9e792bab5af9', { displayName: 'Studio Mac' }),
        machine('c09a805a-9f49-4295-90fc-1404ca8c7561', { host: 'devbox' }),
        machine('58f6e63a-cd69-4302-83f1-325d10da7ec3', null),
      ],
      iconColor: '#000',
    });
    expect(items.map((item) => item.title)).toEqual(['Studio Mac', 'devbox', getMachineDisplayName(machine('58f6e63a-cd69-4302-83f1-325d10da7ec3', null))]);
  });

  it('uses the shared picker identity for duplicate names and excludes retired machines while retaining offline choices', () => {
    const machines = [
      createMachineFixture({ id: 'aaaa-1111', metadata: { ...createMachineFixture().metadata!, displayName: 'Studio', host: 'studio-a' } }),
      createMachineFixture({ id: 'bbbb-2222', active: false, metadata: { ...createMachineFixture().metadata!, displayName: 'Studio', host: 'studio-b' } }),
      createMachineFixture({ id: 'retired-3333', revokedAt: 10 }),
      createMachineFixture({ id: 'replaced-4444', replacedByMachineId: 'aaaa-1111', replacedAt: 10 }),
      createMachineFixture({ id: 'temporary-5555', kind: 'ephemeral_session_runner' }),
    ];
    const items = getMachineDropdownMenuItems({ machines, iconColor: '#000' });
    const names = resolveMachineDisplayNames(machines.slice(0, 2));
    expect(items.map(item => item.id)).toEqual(['aaaa-1111', 'bbbb-2222']);
    expect(items.map(item => item.title)).toEqual([...names.values()]);
    for (const item of items) expect(item.subtitle).not.toContain(item.id);
    expect(items[1]!.subtitle).toContain('Offline');
  });
});
