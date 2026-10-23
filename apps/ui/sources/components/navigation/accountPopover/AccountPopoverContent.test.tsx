import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installAccountCommonModuleMocks } from '@/components/account/accountTestHelpers';
import { resolveHomeConnectionSummary } from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import { AccountPopoverContent } from './AccountPopoverContent';

installAccountCommonModuleMocks();

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

describe('AccountPopoverContent pairing entry', () => {
    beforeEach(() => {
        standardCleanup();
        vi.clearAllMocks();
        // Account-service discovery is an HTTP boundary; the real entry policy still runs.
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    });

    afterEach(() => vi.restoreAllMocks());

    it('closes the popover and opens the shared pairing modal for the displayed Home', async () => {
        const { Modal } = await import('@/modal');
        const onClose = vi.fn();
        const screen = await renderScreen(<AccountPopoverContent
            step="root" onStepChange={() => {}}
            servers={[]} targets={[]} activeTargetKey="server:home-a"
            activeServerId="home-a" displayServerId="home-b" displayServerProfile={null}
            displayHomeLabel="Home B" pendingServerId={null}
            homeSummary={resolveHomeConnectionSummary({ healthKind: 'healthy' })}
            machineSummary={{ kind: 'unknown' }} showsMachineGuidance={false}
            runtimeOrigin={null} homeCarrier={null}
            switchServer={async () => 'switched'} onRetry={async () => {}} retryBusy={false}
            onRestore={() => {}} onAddHome={() => {}} onManageHomes={() => {}}
            onClose={onClose} renderDetails={() => null}
        />);

        const row = screen.findByTestId('connection-popover-add-device');
        expect(row).not.toBeNull();
        await row?.props.onPress();

        expect(onClose).toHaveBeenCalled();
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            props: { purpose: 'phone', targetProfileId: 'home-b' },
        }));
        expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(Modal.show).mock.invocationCallOrder[0]);
    });
});
