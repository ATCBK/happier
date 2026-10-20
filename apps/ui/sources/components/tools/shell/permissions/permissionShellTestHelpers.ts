import { vi } from 'vitest';
import type * as React from 'react';
import { createTestSessionTranscriptSource, renderScreen, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import type { SessionTranscriptActions } from '@/components/sessions/transcript/source/types';

type RespondToPermission = SessionTranscriptActions['respondToPermission'];

/** Each observer receives the actual protocol payload passed to the injected action. */
export function createPermissionShellRenderer(observers: Readonly<{
    approve?: RespondToPermission;
    approveWithUpdates?: RespondToPermission;
    deny?: RespondToPermission;
    abort?: SessionTranscriptActions['abort'];
    readRequestOutcome?: NonNullable<SessionTranscriptActions['readRequestOutcome']>;
}> = {}) {
    return async (element: React.ReactElement) => {
        const props = element.props as Readonly<{ sessionId?: unknown; serverId?: unknown }>;
        const source = createTestSessionTranscriptSource({
            sessionId: typeof props.sessionId === 'string' ? props.sessionId : undefined,
            serverId: typeof props.serverId === 'string' ? props.serverId : null,
            interaction: { canSendMessages: true, canApprovePermissions: true },
            actions: {
                respondToPermission: async (params) => {
                    const observer = params.approved
                        ? params.updatedPermissions !== undefined ? observers.approveWithUpdates : observers.approve
                        : observers.deny;
                    await observer?.(params);
                },
                answerUserAction: async () => {}, abort: observers.abort ?? (async () => {}), submitMessage: async () => {},
                ...(observers.readRequestOutcome ? { readRequestOutcome: observers.readRequestOutcome } : {}),
            },
        });
        const screen = await renderScreen(wrapWithSessionTranscriptSource(element, source));
        return {
            ...screen,
            update: (next: React.ReactElement) => screen.update(wrapWithSessionTranscriptSource(next, source)),
        };
    };
}

type PermissionShellModuleFactory = () => unknown | Promise<unknown>;
type PermissionShellImportOriginal = <T = unknown>() => Promise<T>;
type PermissionShellStorageModuleFactory = (importOriginal: PermissionShellImportOriginal) => unknown | Promise<unknown>;

type InstallPermissionShellCommonModuleMocksOptions = Readonly<{
    reactNative?: PermissionShellModuleFactory;
    unistyles?: PermissionShellModuleFactory;
    text?: PermissionShellModuleFactory;
    router?: PermissionShellModuleFactory;
    storage?: PermissionShellStorageModuleFactory;
    log?: PermissionShellModuleFactory;
}>;

const permissionShellModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as PermissionShellModuleFactory | undefined,
        unistyles: undefined as PermissionShellModuleFactory | undefined,
        text: undefined as PermissionShellModuleFactory | undefined,
        router: undefined as PermissionShellModuleFactory | undefined,
        storage: undefined as PermissionShellStorageModuleFactory | undefined,
        log: undefined as PermissionShellModuleFactory | undefined,
    },
}));

export function installPermissionShellCommonModuleMocks(
    options: InstallPermissionShellCommonModuleMocksOptions = {},
) {
    permissionShellModuleState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        text: options.text,
        router: options.router,
        storage: options.storage,
        log: options.log,
    };

    vi.mock('react-native', async () => {
        const activeOptions = permissionShellModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            TouchableOpacity: 'TouchableOpacity',
            ActivityIndicator: 'ActivityIndicator',
            Alert: {
                alert: vi.fn(),
            },
            Platform: {
                OS: 'ios',
                select: <T,>(value: { ios?: T; default?: T }) => value.ios ?? value.default,
            },
            StyleSheet: {
                create: <T,>(styles: T) => styles,
            },
        });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = permissionShellModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = permissionShellModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('expo-router', async () => {
        const activeOptions = permissionShellModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = permissionShellModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('@/log', async () => {
        const activeOptions = permissionShellModuleState.options;
        if (activeOptions.log) {
            return await activeOptions.log();
        }

        return {
            log: {
                log: vi.fn(),
            },
        };
    });
}
