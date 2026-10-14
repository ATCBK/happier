import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { buildWidgetCandidateSetup } = await import('@/components/widgets/surface/widgetSurfaceSetup');
const { WidgetSetupStep } = await import('./WidgetSetupStep');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
afterEach(() => standardCleanup());

// This no-input setup needs no daemon/plugin projection fixture. Keep its real
// binder, submit/result presentation and public controls, with only Home I/O replaced.
it('offers another copy only after an acknowledged Add and preserves that state through later pending approval', async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Setup', serverUrl: 'https://add-another.test', accountId: 'me' });
    const submit = vi.fn<() => Promise<{ ok: true; approvalPending?: true }>>()
        .mockResolvedValueOnce({ ok: true, approvalPending: true })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true, approvalPending: true });
    const setup = buildWidgetCandidateSetup({ candidate: { key: 'acme.checks/summary', title: 'Checks',
        pluginName: 'Checks', sharedPluginName: false, icon: 'check', homeDefault: 'available', target: 'app',
        definition: { kind: 'artifact', artifactId: 'checks-definition' },
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] } },
        scope: { serverId, accountId: 'me', owner: { kind: 'home' } }, audience: 'personal', context: {},
        mode: { kind: 'add', submitLabel: 'Add to Home' }, submit });
    const onDone = vi.fn();
    const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} presentation="pane" onDone={onDone} testID="added-pane" />);
    const label = () => screen.findAllByType(RoundButton).find(node => node.props.testID === 'added-pane.submit')!.props.title;
    try {
        expect(label()).toBe('Add to Home');
        await screen.pressByTestIdAsync('added-pane.submit');
        expect(label()).toBe('Add to Home');
        expect(onDone).toHaveBeenLastCalledWith({ ok: true, approvalPending: true });
        await screen.pressByTestIdAsync('added-pane.submit');
        expect(label()).toBe('widgetAdd.addAnother');
        await screen.pressByTestIdAsync('added-pane.submit');
        expect(label()).toBe('widgetAdd.addAnother');
        expect(onDone).toHaveBeenLastCalledWith({ ok: true, approvalPending: true });
        expect(submit).toHaveBeenCalledTimes(3);
    } finally { await screen.unmount(); }
});
