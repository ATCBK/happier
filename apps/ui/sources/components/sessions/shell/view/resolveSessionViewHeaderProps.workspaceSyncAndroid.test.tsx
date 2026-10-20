import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { t } from '@/text';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});

describe('resolveSessionViewHeaderProps workspace sync on Android', () => {
    it('gives the conflict badge a 48dp Android target', async () => {
        const { resolveSessionViewHeaderProps } = await import('./resolveSessionViewHeaderProps');
        const session = createSessionFixture({ id: 'workspace-conflict-header-android' });
        const result = resolveSessionViewHeaderProps({
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/workspace-conflict-header-android/info',
            sessionRunsHref: '/session/workspace-conflict-header-android/runs',
            sessionAutomationsHref: '/session/workspace-conflict-header-android/automations',
            paneScopeId: 'pane-1',
            windowWidth: 390,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
            workspaceSyncAttention: { conflictedLinkCount: 2, unknownLinkCount: 0 },
            onOpenWorkspaceSyncConflicts: () => {},
        });
        const conflictButton = React.Children.toArray(
            (result.rightElement as React.ReactElement<{ children?: React.ReactNode }>).props.children,
        ).find((child) => React.isValidElement<{ accessibilityLabel?: string }>(child)
            && child.props.accessibilityLabel === t('workspaceSync.attention.conflictedLinks', { count: 2 }));

        expect(conflictButton).toBeDefined();
        const props = (conflictButton as React.ReactElement<{
            hitSlop: number;
            style: (input: { pressed: boolean }) => { width: number; height: number };
        }>).props;
        expect(props.style({ pressed: false })).toMatchObject({ width: 44, height: 44 });
        expect(props.hitSlop).toBe(2);
    });

    it('announces unavailable and mixed link facts without counting them as conflicts', async () => {
        const { resolveSessionViewHeaderProps } = await import('./resolveSessionViewHeaderProps');
        const session = createSessionFixture({ id: 'workspace-attention-header-android' });
        const base = {
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/workspace-attention-header-android/info',
            sessionRunsHref: '/session/workspace-attention-header-android/runs',
            sessionAutomationsHref: '/session/workspace-attention-header-android/automations',
            paneScopeId: 'pane-1',
            windowWidth: 390,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
            onOpenWorkspaceSyncConflicts: () => {},
        } satisfies Parameters<typeof resolveSessionViewHeaderProps>[0];
        const labels = (attention: Readonly<{ conflictedLinkCount: number; unknownLinkCount: number }>) => {
            const result = resolveSessionViewHeaderProps({ ...base, workspaceSyncAttention: attention });
            return React.Children.toArray(
                (result.rightElement as React.ReactElement<{ children?: React.ReactNode }>).props.children,
            ).filter((child) => React.isValidElement<{ accessibilityLabel?: string }>(child))
                .map((child) => child.props.accessibilityLabel)
                .filter((label): label is string => typeof label === 'string');
        };
        expect(labels({ conflictedLinkCount: 0, unknownLinkCount: 1 })).toContain(
            t('workspaceSync.attention.unavailableLinks', { count: 1 }),
        );
        expect(labels({ conflictedLinkCount: 1, unknownLinkCount: 1 })).toContain(
            `${t('workspaceSync.attention.conflictedLinks', { count: 1 })} · ${t('workspaceSync.attention.unavailableLinks', { count: 1 })}`,
        );
    });
});
