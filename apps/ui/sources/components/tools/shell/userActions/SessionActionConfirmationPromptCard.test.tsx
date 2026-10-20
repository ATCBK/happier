import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionAllowSpy = vi.fn(async (..._args: unknown[]) => {});
const sessionDenySpy = vi.fn(async (..._args: unknown[]) => {});
const modalAlertSpy = vi.fn();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: (...args: unknown[]) => modalAlertSpy(...args) },
}));

// Collect the real component graph before the interaction-test deadline starts.
await import('./SessionActionConfirmationPromptCard');

function actionRequest(overrides: Partial<PendingPermissionRequest> = {}): PendingPermissionRequest {
    return {
        id: 'action:request-1',
        tool: 'Happier Action confirmation',
        kind: 'user_action',
        source: 'happier_action',
        arguments: {
            actionId: 'session.title.set',
            preview: { summary: 'Rename this session to Release checks' },
            sessionId: 'session-1',
            turnId: 'turn-1',
        },
        createdAt: 1,
        turnId: 'turn-1',
        ...overrides,
    };
}

function renderScreen(element: React.ReactElement) {
    return renderWithSessionTranscriptSource(element, createTestSessionTranscriptSource({
        sessionId: 'session-1', serverId: 'home-1',
        interaction: { canSendMessages: true, canApprovePermissions: true },
        actions: {
            respondToPermission: (params) => params.approved ? sessionAllowSpy(params) : sessionDenySpy(params),
            answerUserAction: async () => {}, abort: async () => {}, submitMessage: async () => {},
        },
    }));
}

describe('SessionActionConfirmationPromptCard', () => {
    beforeEach(() => {
        sessionAllowSpy.mockClear();
        sessionDenySpy.mockClear();
        modalAlertSpy.mockClear();
    });

    it('shows a secret-free one-shot Action request distinct from native permissions', async () => {
        const { SessionActionConfirmationPromptCard } = await import('./SessionActionConfirmationPromptCard');
        const request = actionRequest({
            arguments: {
                actionId: 'session.title.set',
                preview: { summary: 'Rename this session', secret: 'must-not-render' },
                sessionId: 'session-1',
                turnId: 'turn-1',
            },
        });

        const screen = await renderScreen(
            <SessionActionConfirmationPromptCard
                request={request}
                sessionId="session-1"
                serverId="home-1"
                canApprovePermissions={true}
            />,
        );

        expect(screen.findByTestId('action-confirmation-prompt-card')).toBeTruthy();
        expect(screen.getTextContent()).toContain('session.title.set');
        expect(screen.getTextContent()).toContain('actionConfirmations.homeTarget');
        expect(screen.getTextContent()).toContain('Rename this session');
        expect(screen.getTextContent()).toContain('actionConfirmations.oneShotConsequence');
        expect(screen.getTextContent()).not.toContain('must-not-render');
        expect(screen.findByTestId('action-confirmation-approve')).toBeTruthy();
        expect(screen.findByTestId('action-confirmation-reject')).toBeTruthy();
        expect(screen.findByTestId('permission-allow-session')).toBeNull();
    });

    it('routes one-shot approve and reject decisions through the exact Session/Home request', async () => {
        const { SessionActionConfirmationPromptCard } = await import('./SessionActionConfirmationPromptCard');
        const screen = await renderScreen(
            <SessionActionConfirmationPromptCard
                request={actionRequest()}
                sessionId="session-1"
                serverId="home-1"
                canApprovePermissions={true}
            />,
        );

        await act(async () => {
            await screen.pressByTestIdAsync('action-confirmation-approve');
        });
        expect(sessionAllowSpy).toHaveBeenCalledWith({ id: 'action:request-1', approved: true, decision: 'approved', turnId: 'turn-1' }
        );

        await act(async () => {
            await screen.pressByTestIdAsync('action-confirmation-reject');
        });
        expect(sessionDenySpy).toHaveBeenCalledWith({ id: 'action:request-1', approved: false, decision: 'denied', turnId: 'turn-1' }
        );
    });

    it('fails closed for a request targeting another Session while retaining rejection', async () => {
        const { SessionActionConfirmationPromptCard } = await import('./SessionActionConfirmationPromptCard');
        const screen = await renderScreen(
            <SessionActionConfirmationPromptCard
                request={actionRequest({
                    arguments: {
                        actionId: 'session.title.set',
                        preview: { summary: 'Rename another session' },
                        sessionId: 'session-other',
                        turnId: 'turn-1',
                    },
                })}
                sessionId="session-1"
                canApprovePermissions={true}
            />,
        );

        expect(screen.findByTestId('action-confirmation-approve')?.props.disabled).toBe(true);
        expect(screen.findByTestId('action-confirmation-reject')?.props.disabled).toBe(false);
    });

    it('admits at most one same-frame approval decision', async () => {
        const { SessionActionConfirmationPromptCard } = await import('./SessionActionConfirmationPromptCard');
        const screen = await renderScreen(
            <SessionActionConfirmationPromptCard
                request={actionRequest()}
                sessionId="session-1"
                canApprovePermissions={true}
            />,
        );
        const approve = screen.findByTestId('action-confirmation-approve');

        await act(async () => {
            approve?.props.onPress();
            approve?.props.onPress();
            await Promise.resolve();
        });

        expect(sessionAllowSpy).toHaveBeenCalledTimes(1);
    });

    it('does not offer decisions to a viewer without approval authority', async () => {
        const { SessionActionConfirmationPromptCard } = await import('./SessionActionConfirmationPromptCard');
        const screen = await renderScreen(
            <SessionActionConfirmationPromptCard
                request={actionRequest()}
                sessionId="session-1"
                canApprovePermissions={false}
                disabledReason="notGranted"
            />,
        );

        expect(screen.findByTestId('action-confirmation-approve')).toBeNull();
        expect(screen.findByTestId('action-confirmation-reject')).toBeNull();
        expect(screen.getTextContent()).toContain('session.sharing.permissionApprovalsDisabledNotGranted');
    });

    it('does not render after the owning Session becomes inactive', async () => {
        const { SessionActionConfirmationPromptCard } = await import('./SessionActionConfirmationPromptCard');
        const screen = await renderScreen(
            <SessionActionConfirmationPromptCard
                request={actionRequest()}
                sessionId="session-1"
                canApprovePermissions={false}
                disabledReason="inactive"
            />,
        );

        expect(screen.findByTestId('action-confirmation-prompt-card')).toBeNull();
    });
});
