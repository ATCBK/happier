import { describe, expect, it } from 'vitest';
import * as React from 'react';

import { getAgentIconSvgXml } from '@/agents/catalog/catalog';
import { Icon } from '@/components/ui/icons/Icon';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';

describe('useSessionAgentCatalogIdentity', () => {
    it.each([
        ['claude', 'claude'],
        ['unknown-agent', null],
    ] as const)('renders the catalog identity for a %s Session', async (flavor, expectedMark) => {
        const session = createSessionFixture({ metadata: {
            path: '/repo', host: 'test', machineId: 'machine-a', flavor,
        } });
        const screen = await renderScreen(React.createElement(SessionAgentCatalogIdentityIcon, {
            agentId: readSessionPresentationAgentId(session) ?? '',
            machineId: session.metadata?.machineId ?? null,
            serverId: null,
            testID: 'session-agent-identity',
        }));
        try {
            const host = screen.findHostByTestId('session-agent-identity');
            expect(host).not.toBeNull();
            if (expectedMark) {
                const expectedXml = getAgentIconSvgXml(expectedMark, createThemeFixture());
                expect(expectedXml).toEqual(expect.any(String));
                expect(host?.props.xml).toBe(expectedXml);
                expect(screen.tree.root.findAllByType(Icon)).toHaveLength(0);
            } else {
                expect(host?.props.xml).toBeUndefined();
                expect(screen.tree.root.findByType(Icon).props.name).toBe('stack-simple');
            }
        } finally {
            await screen.unmount();
        }
    });
});
