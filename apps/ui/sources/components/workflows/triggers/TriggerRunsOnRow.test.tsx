import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { SelectionList } from '@/components/ui/selectionList';
import { storage } from '@/sync/domains/state/storage';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installNewSessionComponentsCommonModuleMocks } from '@/components/sessions/new/components/newSessionComponentsTestHelpers';

installNewSessionComponentsCommonModuleMocks();
// Only the portal/window measurement is replaced; Machine inventory, selection and path policy stay real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

const { TriggerRunsOnRow } = await import('./TriggerRunsOnRow');
let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
const machines = ['studio', 'linux'].map((id) => createMachineFixture({ id, activeAt: Date.now() }));

beforeEach(async () => {
    home = await createPlainArtifactHomeFixture('https://triggers.test');
    storage.setState({
        machines: Object.fromEntries(machines.map((machine) => [machine.id, machine])),
        machineListByServerId: { [home.home.id]: machines },
        machineListStatusByServerId: { [home.home.id]: 'idle' },
        authoringMemory: { ...authoringMemoryDefaults, recentMachinePaths: [{ machineId: 'linux', path: '/repo/service' }] },
    });
});
afterEach(async () => {
    await standardCleanup();
    await home?.dispose();
    home = undefined;
});

describe('trigger Runs on', () => {
    it('offers the Home Machine choices on opening Where and chooses their canonical starting project', async () => {
        const onChange = vi.fn();
        const screen = await renderScreen(<TriggerRunsOnRow testID="trigger-runs-on" target={null}
            onChange={onChange} description="Where this trigger runs" />);
        expect(screen.findAllByType(SelectionList)).toHaveLength(0);
        await screen.pressByTestIdAsync('trigger-runs-on-machine-row');
        const lists = screen.findAllByType(SelectionList);
        expect(lists).toHaveLength(1);
        const options = lists[0].props.rootStep.sections.flatMap((section: import('@/components/ui/selectionList').SelectionListSection) =>
            section.options);
        expect(options.map((option: import('@/components/ui/selectionList').SelectionListOption) => option.id).sort()).toEqual(['linux', 'studio']);
        const linux = options.find((option: import('@/components/ui/selectionList').SelectionListOption) => option.id === 'linux');
        expect(linux?.disabled).not.toBe(true);
        await act(async () => linux?.onSelect?.());
        expect(onChange).toHaveBeenCalledWith({ machineId: 'linux', directory: '/repo/service' });
    });
});
