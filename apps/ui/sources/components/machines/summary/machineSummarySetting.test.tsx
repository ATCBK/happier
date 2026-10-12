import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import { MachineSummaryCaption } from './MachineSummaryCaption';
import { MachineSummaryCustomizePanel } from './MachineSummaryCustomizePanel';
import { MachineSummaryStrip } from './MachineSummaryStrip';
import { MACHINE_SUMMARY_PREVIEW } from './machineSummaryPreview';
import { useMachineSummarySettingValue } from './useMachineSummarySetting';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();

/** A surface's strip, as the popover, the machine list and All machines each draw it from the one setting. */
function SurfaceStrip(props: Readonly<{ testID: string }>) {
    const setting = useMachineSummarySettingValue();
    return <MachineSummaryStrip testID={props.testID} availability={MACHINE_SUMMARY_PREVIEW.calm} style={setting.style} metrics={setting.metrics} layout="under" />;
}

function SurfaceCaption() {
    const setting = useMachineSummarySettingValue();
    return <MachineSummaryCaption metrics={setting.metrics} style={setting.style} />;
}

describe('the Machine summary setting', () => {
    it('changes every surface at once from the popover panel and keeps none shown as names only', async () => {
        const before = storage.getState();
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] },
        } }) });
        onTestFinished(async () => { standardCleanup(); await account.dispose(); storage.setState(before, true); });
        storage.getState().applyLocalSettings({ uiMachineSummaryStyle: 'sparklines', uiMachineSummaryMetrics: ['cpu', 'memory', 'disk'] });
        const screen = await renderScreen(
            <>
                <MachineSummaryCustomizePanel onDone={() => undefined} />
                <SurfaceStrip testID="popover-strip" />
                <SurfaceStrip testID="column-strip" />
                <SurfaceCaption />
            </>,
        );
        const strips = () => screen.findAll(node => typeof node.props?.testID === 'string' && node.props.testID.endsWith('-strip') && node.props.style !== undefined && typeof node.type !== 'string');
        expect(strips().every(node => node.props.style === 'sparklines')).toBe(true);

        await act(async () => { await screen.pressByTestIdAsync('machines.summary.customize.style:bars'); });
        await vi.waitFor(() => expect(strips().map(node => node.props.style)).toEqual(['bars', 'bars']));
        expect(storage.getState().localSettings.uiMachineSummaryStyle).toBe('bars');

        for (const metric of ['cpu', 'memory', 'disk']) {
            await act(async () => { await screen.pressByTestIdAsync(`machines.summary.customize.show:${metric}`); });
            await vi.waitFor(() => expect(storage.getState().localSettings.uiMachineSummaryMetrics).not.toContain(metric));
        }
        expect(storage.getState().localSettings.uiMachineSummaryMetrics).toEqual([]);
        expect(screen.findAll(node => node.props?.testID === 'machines.summary.caption')).toHaveLength(0);
        expect(screen.findAll(node => typeof node.type === 'string' && node.props?.testID === 'popover-strip')).toHaveLength(0);
    });
});
