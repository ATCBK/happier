import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { SelectionListProps } from '@/components/ui/selectionList';
import type { SessionRoute } from '@/providers/session/resolveSessionRoutePresentation';
import { renderScreen } from '@/dev/testkit';

import { createTeamResourceServiceOptionId } from './buildNewSessionConnectedServicesSelectionListModel';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capturedSelectionLists = vi.hoisted(() => [] as SelectionListProps[]);
const NO_QUOTA_BADGES = vi.hoisted(() => ({}));

installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
    icons: () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/selectionList', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/selectionList')>();
    return {
        ...actual,
        SelectionList: (props: SelectionListProps) => {
            capturedSelectionLists.push(props);
            return React.createElement('SelectionList', { testID: props.testID });
        },
    };
});

vi.mock('@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName', () => ({
    resolveConnectedServiceDisplayName: (id: string) => id,
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => NO_QUOTA_BADGES,
}));

const SERVICE = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
const SERVICE_ID = 'happier.agent.codex/openai-codex';
const SELECTION = { source: 'team_resource' as const, resourceId: 'resource-1', deliveryMode: 'brokered' as const };

describe('NewSessionConnectedServicesSelectionContent on a Team route', () => {
    async function renderRoute(appliedRoute: SessionRoute, bound: boolean) {
        const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');
        capturedSelectionLists.length = 0;
        await renderScreen(
            <NewSessionConnectedServicesSelectionContent
                supportedServiceIds={[SERVICE_ID]}
                profileOptionsByServiceId={{}}
                groupOptionsByServiceId={{}}
                bindingsByServiceId={bound ? { [SERVICE_ID]: SELECTION } : {}}
                nativeAgentTargetKey="agent:happier.agent.codex/codex"
                appliedRoute={appliedRoute}
                teamCredentialResources={[{
                    id: 'resource-1', teamId: 'team-1', displayName: 'QA43 Leeroy brokered', resourceRevision: 1,
                    readiness: { kind: 'available' }, recoveryAction: null, deliveryMode: 'brokered',
                    mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
                    sessionUsePolicy: 'personal_allowed', providerModels: [],
                    sourcePresentation: { kind: 'connected_service', service: SERVICE },
                    connectedServiceSelections: [SELECTION],
                }]}
                setBindingForService={() => {}}
                onOpenSettings={() => {}}
                maxHeight={420}
            />,
        );
        return capturedSelectionLists[capturedSelectionLists.length - 1]!;
    }

    it('checks the Team row the session is bound to, and not its own sign-in', async () => {
        const list = await renderRoute({
            kind: 'team', teamId: 'team-1', resourceId: 'resource-1', deliveryMode: 'brokered',
            sourceLabel: 'QA43 Leeroy brokered', modelId: 'gpt-5.6-luna',
        }, true);
        expect(list.selectedOptionId).toBe(createTeamResourceServiceOptionId(SELECTION));
    });

    it('checks nothing rather than its own sign-in when no Team binding backs the route', async () => {
        const list = await renderRoute({
            kind: 'team', teamId: 'team-1', resourceId: 'resource-1', deliveryMode: 'brokered',
            sourceLabel: 'QA43 Leeroy brokered', modelId: 'gpt-5.6-luna',
        }, false);
        expect(list.selectedOptionId).toBeNull();
    });
});
