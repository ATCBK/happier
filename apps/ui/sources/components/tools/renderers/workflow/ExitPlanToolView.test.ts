import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { collectHostText, makeToolCall, makeToolViewProps, standardCleanup } from '@/dev/testkit';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit';


const sessionAllow = vi.fn();
const sessionAllowWithPermissionUpdates = vi.fn();
const sessionDeny = vi.fn();
const sendMessage = vi.fn();
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// Radix is the DOM boundary; alert registration, display and dismissal stay real.
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key) => key,
}));
// Only the vendor browser reveal adapter is replaced; the markdown view and tool catalog stay real.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));
const { ModalProvider } = await import('@/modal/ModalProvider');
const { WebAlertModal } = await import('@/modal/components/WebAlertModal');

function expectNoAlert(tree: renderer.ReactTestRenderer) {
    expect(tree.root.findAllByType(WebAlertModal)).toHaveLength(0);
}

function expectAlert(tree: renderer.ReactTestRenderer, message: string) {
    expect(tree.root.findAllByType(WebAlertModal).map(node => node.props.config))
        .toEqual([expect.objectContaining({ type: 'alert', title: 'common.error', message })]);
    expect(collectHostText(tree)).toContain(message);
}

async function pressAlertChoice(tree: renderer.ReactTestRenderer, label: string) {
    const choice = tree.root.findAll(node => typeof node.type === 'string'
        && node.props.testID?.startsWith('web-modal-button-')
        && node.props.accessibilityLabel?.includes(label));
    expect(choice).toHaveLength(1);
    await act(async () => choice[0].props.onPress());
    // The real provider retains the dismissed dialog through its exit motion.
    await vi.waitFor(async () => {
        await act(async () => {});
        expectNoAlert(tree);
    });
}

describe('ExitPlanToolView', () => {
    let ExitPlanToolView: React.ComponentType<any>;

    function makeRunningTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'ExitPlanMode',
            state: 'running',
            input: { plan: 'plan' },
            completedAt: null,
            permission: { id: 'perm1', status: 'pending' },
            ...overrides,
        });
    }

    async function renderView(tool: ToolCall, overrides: Record<string, unknown> = {}) {
        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderWithSessionTranscriptSource(React.createElement(ModalProvider, null, React.createElement(
                    ExitPlanToolView,
                    makeToolViewProps(tool, { sessionId: 's1', ...overrides }),
                )), createTestSessionTranscriptSource({
                    sessionId: 's1', serverId: typeof overrides.serverId === 'string' ? overrides.serverId : null,
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                    actions: {
                        respondToPermission: (params) => params.approved
                            ? params.updatedPermissions !== undefined ? sessionAllowWithPermissionUpdates(params) : sessionAllow(params)
                            : sessionDeny(params),
                        answerUserAction: async () => {}, abort: async () => {}, submitMessage: (params) => sendMessage(params),
                    },
                }))).tree;
        return tree!;
    }

    beforeAll(async () => {
        ({ ExitPlanToolView } = await import('./ExitPlanToolView'));
    });

    beforeEach(() => {
        sessionAllow.mockReset();
        sessionAllowWithPermissionUpdates.mockReset();
        sessionDeny.mockReset();
        sendMessage.mockReset();
    });
    afterEach(async () => { await standardCleanup(); });

    it('approves via permission RPC and does not send a follow-up user message', async () => {
        sessionAllow.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve');
        });

        expect(sessionAllow).toHaveBeenCalledTimes(1);
        expect(sessionAllow).toHaveBeenCalledWith({ id: 'perm1', approved: true });
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expect(collectHostText(tree)).toContain('tools.exitPlanMode.responded');
    });

    it('approves with acceptEdits via approve options menu', async () => {
        sessionAllowWithPermissionUpdates.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve-menu');
        });

        await pressAlertChoice(tree, 'agentInput.permissionMode.acceptEdits');

        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(expect.objectContaining({ id: 'perm1', approved: true, ...{
                mode: 'acceptEdits',
                updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
            } })
        );
    });

    it('approves with bypassPermissions via approve options menu', async () => {
        sessionAllowWithPermissionUpdates.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve-menu');
        });

        await pressAlertChoice(tree, 'agentInput.permissionMode.badgeBypassAllPermissions');

        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(expect.objectContaining({ id: 'perm1', approved: true, ...{
                mode: 'bypassPermissions',
                updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
            } })
        );
    });

    it('surfaces provider setMode suggestions as additional approve options', async () => {
        sessionAllowWithPermissionUpdates.mockResolvedValueOnce(undefined);
        const providerSuggestion = { type: 'setMode', mode: 'customMode', destination: 'session' };
        const tree = await renderView(
            makeRunningTool({
                permission: { id: 'perm1', status: 'pending', suggestions: [providerSuggestion] } as any,
            }),
        );

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve-menu');
        });

        await pressAlertChoice(tree, 'customMode');

        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithPermissionUpdates).toHaveBeenCalledWith(expect.objectContaining({ id: 'perm1', approved: true, ...{
                updatedPermissions: [providerSuggestion],
            } })
        );
    });

    it('rejects via permission RPC and does not send a follow-up user message', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-reject');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledWith({ id: 'perm1', approved: false });
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('requests changes via permission RPC with a reason', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool());

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes');
        });

        await act(async () => {
            tree.changeTextByTestId('exit-plan-request-changes-input', 'Please change step 2');
        });

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes-send');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledWith({ id: 'perm1', approved: false, reason: 'Please change step 2' });
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('falls back to tool.id when approve is pressed before permission metadata is reattached', async () => {
        sessionAllow.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool({ id: 'toolu_reconnect', permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve');
        });

        expect(sessionAllow).toHaveBeenCalledTimes(1);
        expect(sessionAllow).toHaveBeenCalledWith({ id: 'toolu_reconnect', approved: true });
        expectNoAlert(tree);
    });

    it('falls back to tool.id when reject is pressed before permission metadata is reattached', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool({ id: 'toolu_reconnect', permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-reject');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledWith({ id: 'toolu_reconnect', approved: false });
        expectNoAlert(tree);
    });

    it('falls back to tool.id when requesting changes before permission metadata is reattached', async () => {
        sessionDeny.mockResolvedValueOnce(undefined);
        const tree = await renderView(makeRunningTool({ id: 'toolu_reconnect', permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes');
        });

        await act(async () => {
            tree.changeTextByTestId('exit-plan-request-changes-input', 'Please change step 2');
        });

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes-send');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledWith({ id: 'toolu_reconnect', approved: false, reason: 'Please change step 2' });
        expectNoAlert(tree);
    });

    it('shows an error when requesting plan changes fails', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        sessionDeny.mockRejectedValueOnce(new Error('network'));

        try {
            const tree = await renderView(makeRunningTool());

            await act(async () => {
                await tree.pressByTestIdAsync('exit-plan-request-changes');
            });

            await act(async () => {
                tree.changeTextByTestId('exit-plan-request-changes-input', 'Please change step 2');
            });

            await act(async () => {
                await tree.pressByTestIdAsync('exit-plan-request-changes-send');
            });

            expectAlert(tree, 'tools.exitPlanMode.requestChangesFailed');
        } finally {
            consoleErrorSpy.mockRestore();
        }
    });

    it('shows an error when requesting changes is attempted without text', async () => {
        const tree = await renderView(makeRunningTool());
        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes');
        });
        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-request-changes-send');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expectAlert(tree, 'tools.exitPlanMode.requestChangesEmpty');
    });

    it('does not mark as responded when approve is pressed without any permission request id', async () => {
        const tree = await renderView(makeRunningTool({ id: undefined, permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-approve');
        });

        expect(sessionAllow).toHaveBeenCalledTimes(0);
        expectAlert(tree, 'errors.missingPermissionId');

        const buttonsAfter = tree.findAllByType('TouchableOpacity' as any);
        expect(buttonsAfter.length).toBeGreaterThanOrEqual(2);
    });

    it('does not mark as responded when reject is pressed without any permission request id', async () => {
        const tree = await renderView(makeRunningTool({ id: undefined, permission: undefined }));

        await act(async () => {
            await tree.pressByTestIdAsync('exit-plan-reject');
        });

        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expectAlert(tree, 'errors.missingPermissionId');

        const buttonsAfter = tree.findAllByType('TouchableOpacity' as any);
        expect(buttonsAfter.length).toBeGreaterThanOrEqual(2);
    });

    it('does not allow responding when canApprovePermissions is false', async () => {
        const tree = await renderView(makeRunningTool(), {
            interaction: {
                canSendMessages: true,
                canApprovePermissions: false,
                permissionDisabledReason: 'notGranted',
            },
        });

        expect(tree.findAllByTestId('exit-plan-approve')).toHaveLength(0);
        expect(tree.findAllByTestId('exit-plan-reject')).toHaveLength(0);

        expect(sessionAllow).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);

        expect(collectHostText(tree)).toContain('session.sharing.permissionApprovalsDisabledNotGranted');
    });

    it('withdraws all plan decisions from a read-only source', async () => {
        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ExitPlanToolView, makeToolViewProps(makeRunningTool(), { sessionId: 's1' })),
            createTestSessionTranscriptSource(),
        );
        expect(screen.findAllByTestId('exit-plan-approve')).toHaveLength(0);
        expect(screen.findAllByTestId('exit-plan-reject')).toHaveLength(0);
        expect(sessionAllow).not.toHaveBeenCalled();
        expect(sessionDeny).not.toHaveBeenCalled();
    });

    it('shows a placeholder when no plan text is provided', async () => {
        const tree = await renderView(makeRunningTool({ input: {} }));
        const { MarkdownView } = await import('@/components/markdown/MarkdownView');
        expect(tree.findByType(MarkdownView).props.markdown).toBe('tools.exitPlanMode.planMissing');
    });

    it('shows a placeholder when plan input schema parse fails', async () => {
        const tree = await renderView(makeRunningTool({ input: { plan: 42 } }));
        const { MarkdownView } = await import('@/components/markdown/MarkdownView');
        expect(tree.findByType(MarkdownView).props.markdown).toBe('tools.exitPlanMode.planMissing');
    });
});
