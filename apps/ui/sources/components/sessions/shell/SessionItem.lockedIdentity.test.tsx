import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionItemRowViewModel } from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: Record<string, unknown>) => React.createElement('Swipeable', props),
    GestureDetector: (props: React.PropsWithChildren) => React.createElement('GestureDetector', props, props.children),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/ui/forms/dropdown/ContextMenu', () => ({
    ContextMenu: (props: Record<string, unknown>) => React.createElement('ContextMenu', props),
}));
vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/agents/registry/AgentIcon', () => ({ AgentIcon: 'AgentIcon' }));
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => vi.fn() }));
vi.mock('@/utils/platform/responsive', () => ({ useIsTablet: () => false }));
vi.mock('@/hooks/ui/useHappyAction', () => ({ useHappyAction: (fn: unknown) => [false, fn] }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'web' } });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useHasUnreadMessages: () => false,
                useSession: () => null,
                useLocalSetting: ((_key: string) => null) as never,
            },
        });
    },
});

describe('SessionItem locked-session identity', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('keeps the safe cached name the detail header keeps when content is unreadable', async () => {
        const { SessionItem } = await import('./SessionItem');
        const session = createSessionFixture({
            id: 'session-locked-row',
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_access_pending',
        });
        const baseRowViewModel = createSessionItemRowViewModel({ session });
        const sessionStatus = baseRowViewModel.sessionStatus;
        if (!sessionStatus) throw new Error('locked Session row fixture requires projected status');
        const rowViewModel = {
            ...baseRowViewModel,
            sessionStatus: {
                ...sessionStatus,
                awareness: { ...sessionStatus.awareness, encryption: 'locked' as const },
            },
        };

        const screen = await renderScreen(<SessionItem session={session} rowViewModel={rowViewModel} />);

        // Encryption pending is not a reason to forget a name this device already holds:
        // the list row and the detail header must call the same Session the same thing.
        const row = screen.findByTestId('session-list-item-session-locked-row');
        expect(row?.props.accessibilityLabel).toContain('project');
        expect(row?.props.accessibilityLabel).not.toContain('session.access.lockedTitleFallback');
    });

    it('falls back to the locked name only when no safe cached name exists', async () => {
        const { SessionItem } = await import('./SessionItem');
        const session = createSessionFixture({
            id: 'session-nameless-row',
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_access_pending',
            metadata: null,
        });
        const baseRowViewModel = createSessionItemRowViewModel({ session });
        const sessionStatus = baseRowViewModel.sessionStatus;
        if (!sessionStatus) throw new Error('locked Session row fixture requires projected status');
        const rowViewModel = {
            ...baseRowViewModel,
            sessionStatus: {
                ...sessionStatus,
                awareness: { ...sessionStatus.awareness, encryption: 'locked' as const },
            },
        };

        const screen = await renderScreen(<SessionItem session={session} rowViewModel={rowViewModel} />);

        expect(screen.findByTestId('session-list-item-session-nameless-row')?.props.accessibilityLabel)
            .toContain('session.access.lockedTitleFallback');
    });
});
