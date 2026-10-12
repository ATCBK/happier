import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const capturedChrome = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
const capturedModal = vi.hoisted(() => ({ value: null as Record<string, any> | null }));
const capturedScreenProps = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

vi.mock('@/modal/components/card/useModalCardChrome', () => ({
    useModalCardChrome: (_setChrome: unknown, chrome: Record<string, unknown>) => {
        capturedChrome.value = chrome;
    },
}));

// The modal shell is a platform boundary here (portal, focus scope, Escape layer): capture what the
// browse surface asks it to present.
vi.mock('@/modal/components/CustomModal', () => ({
    CustomModal: (props: Record<string, any>) => {
        capturedModal.value = props;
        return null;
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock();
    return { ...base, Platform: { ...base.Platform, OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default } };
});

vi.mock('@/components/appShell/search/UniversalSearchController', () => ({
    UniversalSearchController: () => null,
}));

vi.mock('./ExternalSessionsBrowseScreen', () => ({
    ExternalSessionsBrowseScreen: (props: Record<string, unknown>) => {
        capturedScreenProps.value = props;
        return React.createElement('ExternalSessionsBrowseScreen', props);
    },
}));

afterEach(() => {
    capturedChrome.value = null;
    capturedModal.value = null;
    capturedScreenProps.value = null;
    standardCleanup();
});

// Browse is a command surface like Search / ⌘K: the same card (width, height cap, radius, shadow),
// placed at the top on web, with the search band as the top of the card.
describe('ExternalSessionsBrowseModal', () => {
    it('presents Browse in the same card as Search / ⌘K', async () => {
        const { ExternalSessionsBrowseModal } = await import('./ExternalSessionsBrowseModal');
        const { UniversalSearchModal } = await import('@/components/appShell/search/UniversalSearchModal');

        await renderScreen(<UniversalSearchModal commands={[]} onClose={vi.fn()} setChrome={vi.fn()} />);
        const searchChrome = capturedChrome.value;
        await renderScreen(<ExternalSessionsBrowseModal onClose={vi.fn()} setChrome={vi.fn()} />);
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

        await renderScreen(<ExternalSessionsBrowseSurface lockScope={null} onRequestClose={onRequestClose} />);

        expect(capturedModal.value?.visible).toBe(true);
        expect(capturedModal.value?.config.webPlacement).toBe('top');
        capturedModal.value?.onClose();
        expect(onRequestClose).toHaveBeenCalledOnce();
    });
});
