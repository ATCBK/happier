import * as React from 'react';
import { HappierLink } from '@happier-dev/plugin-ui/presentation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

function findProviderLink(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAllByType(HappierLink).find((node) => (
        node.props.label === 'settingsProviders.links.providerWebsite'
        && typeof node.props.onPress === 'function'
    ));
}

describe('ProviderExternalLinkItem', () => {
    afterEach(standardCleanup);

    it('renders the external link through HappierLink', async () => {
        const { ProviderExternalLinkItem } = await import('./ProviderExternalLinkItem');
        const screen = await renderScreen(
            <ProviderExternalLinkItem kind="providerWebsite" url="https://provider.example.test" />,
        );
        const link = findProviderLink(screen);

        expect(link?.props.label).toBe('settingsProviders.links.providerWebsite');
    });
});
