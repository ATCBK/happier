// @vitest-environment jsdom
import * as React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen as renderScreenWithTestkit, standardCleanup } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from '@/components/sessions/new/components/newSessionComponentsTestHelpers';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const capturedChrome = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

const setChrome: NonNullable<import('@/modal/types').CustomModalInjectedProps['setChrome']> = chrome => {
    capturedChrome.value = chrome;
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock();
    return { ...base, Platform: { ...base.Platform, OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default } };
});

installNewSessionComponentsCommonModuleMocks({ text: () => createTextModuleMock({
    translate: key => key === 'tools.names.search' ? 'Search'
        : key === 'externalSessions.browseHeaderTitle' ? 'External sessions' : key,
}) });
vi.unmock('@/sync/domains/state/storage');
// React Test Renderer cannot commit DOM portals. Substitute only the DOM
// renderer and Radix SDK adapters; keep the modal, frame and Browse body real.
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
const network = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { CustomModal } = await import('@/modal/components/CustomModal');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const AppProviders = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider>;
function renderScreen(element: React.ReactElement) { return renderScreenWithTestkit(element, { wrapper: AppProviders }); }
afterAll(() => network.dispose());

afterEach(() => {
    capturedChrome.value = null;
    standardCleanup();
});

// Browse is a command surface like Search / ⌘K: the same card (width, height cap, radius, shadow),
// placed at the top on web, with the search band as the top of the card.
describe('ExternalSessionsBrowseModal', () => {
    it('presents Browse in the same card as Search / ⌘K', async () => {
        const { ExternalSessionsBrowseModal } = await import('./ExternalSessionsBrowseModal');
        const { UniversalSearchModal } = await import('@/components/appShell/search/UniversalSearchModal');

        await renderScreen(<UniversalSearchModal commands={[]} onClose={vi.fn()} setChrome={setChrome} />);
        const searchChrome = capturedChrome.value;
        await renderScreen(<ExternalSessionsBrowseModal onClose={vi.fn()} setChrome={setChrome} />);
        const browseChrome = capturedChrome.value;

        expect(browseChrome).toMatchObject({
            kind: 'card',
            header: 'none',
            scrollHost: 'body',
            bodyScroll: 'none',
        });
        // The same frame family; Browse opens in the wide form, as Search does for a detail column.
        expect(browseChrome?.dimensions).toEqual({ ...(searchChrome?.dimensions as object), width: 960 });
        expect(browseChrome?.title).toBe('External sessions');
    });

    it('opens the web route inside the command-surface modal, placed at the top like Search', async () => {
        const { ExternalSessionsBrowseSurface } = await import('./ExternalSessionsBrowseModal');
        const onRequestClose = vi.fn();

        const screen = await renderScreen(<ExternalSessionsBrowseSurface lockScope={null} onRequestClose={onRequestClose} />);
        const modal = screen.findByType(CustomModal);

        expect(modal.props.visible).toBe(true);
        expect(modal.props.config.webPlacement).toBe('top');
        modal.props.onClose();
        expect(onRequestClose).toHaveBeenCalledOnce();
    });
});
