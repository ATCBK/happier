import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync } from '@/dev/testkit';
import { lightTheme } from '@/theme';
import { installPermissionShellCommonModuleMocks, createPermissionShellRenderer } from './permissionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ops = vi.hoisted(() => ({
    approve: vi.fn(async () => {}),
    approveWithUpdates: vi.fn(async () => {}),
    deny: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
}));
const renderScreen = createPermissionShellRenderer(ops);


const sessionStore = vi.hoisted(() => ({
    updateSessionPermissionMode: vi.fn((..._args: unknown[]) => {}),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));



vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: vi.fn(async () => {}),
    },
}));

installPermissionShellCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: { getState: () => sessionStore },
        });
    },
});

vi.mock('@/agents/catalog/resolve', () => ({
    resolveAgentIdForPermissionUi: () => 'claude',
}));

vi.mock('@/agents/catalog/permissionUiCopy', () => ({
    getPermissionFooterCopy: () => ({
        protocol: 'claude',
        yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
        yesForToolKey: 'claude.permissions.yesForTool',
        stopKey: 'claude.permissions.stop',
    }),
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        getAgentBehavior: () => ({
            permissions: {
                footer: {
                    usePermissionUpdates: true,
                },
            },
        }),
    };
});

function findPermissionFooterButton(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    label: string,
) {
    const button = findTestInstanceByTypeContainingText(screen.tree, 'TouchableOpacity', label);
    expect(button).toBeTruthy();
    return button!;
}

function getTextStyleFragments(button: ReturnType<typeof findPermissionFooterButton>) {
    const textNode = button.findByType('Text' as any);
    return flattenStyleFragments(textNode.props.style);
}

// The app Text adapter composes [defaultTypography, scaledCallerStyle] arrays; resolve
// nested arrays the way React Native flattens composed styles.
function flattenStyleFragments(style: unknown): Array<Record<string, unknown>> {
    if (!style) return [];
    if (Array.isArray(style)) return style.flatMap(flattenStyleFragments);
    return [style as Record<string, unknown>];
}

describe('PermissionFooter (Claude permission updates)', () => {
    beforeEach(() => {
        ops.approve.mockClear();
        ops.approveWithUpdates.mockClear();
        ops.deny.mockClear();
        ops.abort.mockClear();
        sessionStore.updateSessionPermissionMode.mockClear();
    });

    it('approves allow-all-edits using updatedPermissions setMode', async () => {
        const { PermissionFooter } = await import('../permissions/PermissionFooter');
        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'Edit',
            toolInput: { file_path: 'a.ts' },
            metadata: { flavor: 'opencode' },
        }));
        const allowAllEditsButton = findPermissionFooterButton(screen, 'claude.permissions.yesAllowAllEdits');
        await pressTestInstanceAsync(allowAllEditsButton, 'allow-all-edits button');

        expect(ops.approveWithUpdates).toHaveBeenCalledTimes(1);
        expect(ops.approveWithUpdates).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', approved: true,
                mode: 'acceptEdits',
                updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
            }));
    });

    it('approves allow-for-session using a tool-wide allowlist update for shell tools', async () => {
        const { PermissionFooter } = await import('../permissions/PermissionFooter');
        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'Bash',
            toolInput: { command: 'pwd' },
            metadata: { flavor: 'opencode' },
        }));
        const allowForToolButton = findPermissionFooterButton(screen, 'claude.permissions.yesForTool');
        await pressTestInstanceAsync(allowForToolButton, 'allow-for-session button');

        expect(ops.approveWithUpdates).toHaveBeenCalledTimes(1);
        expect(ops.approveWithUpdates).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', approved: true,
                allowedTools: ['Bash'],
                updatedPermissions: [
                    {
                        type: 'addRules',
                        behavior: 'allow',
                        destination: 'session',
                        rules: [{ toolName: 'Bash' }],
                    },
                ],
            }));
    });

    it('treats tool-wide shell allowlists as approved-for-session state', async () => {
        const { PermissionFooter } = await import('../permissions/PermissionFooter');
        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: {
                id: 'p1',
                status: 'approved',
                allowedTools: ['Bash'],
            },
            sessionId: 's1',
            toolName: 'Bash',
            toolInput: { command: 'git status' },
            metadata: { flavor: 'opencode' },
        }));
        const allowForToolButton = findPermissionFooterButton(screen, 'claude.permissions.yesForTool');
        const styleFragments = (allowForToolButton!.props.style as unknown[]).filter(Boolean) as Array<Record<string, unknown>>;
        expect(styleFragments).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ borderLeftColor: expect.any(String) }),
            ]),
        );
        expect(styleFragments.some((style) => style.borderLeftColor !== 'transparent')).toBe(true);
        expect(styleFragments.some((style) => style.opacity === 0.3)).toBe(false);
    });

    it('does not offer a broad command-name grant for a shell prelude', async () => {
        const { PermissionFooter } = await import('../permissions/PermissionFooter');
        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'Bash',
            toolInput: {
                command:
                    'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_OAUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_SETUP_TOKEN; pwd',
            },
            metadata: { flavor: 'opencode' },
        }));
        expect(
            findTestInstanceByTypeContainingText(
                screen.tree,
                'TouchableOpacity',
                'claude.permissions.yesForCommandName',
            ),
        ).toBeUndefined();
        expect(ops.approveWithUpdates).not.toHaveBeenCalled();
    });

    it('draws standing-grant labels in ink rather than decorative tints', async () => {
        const { PermissionFooter } = await import('../permissions/PermissionFooter');

        const editScreen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'Edit',
            toolInput: { file_path: 'a.ts' },
            metadata: { flavor: 'opencode' },
        }));

        const allowAllEditsButton = findPermissionFooterButton(editScreen, 'claude.permissions.yesAllowAllEdits');
        const allowAllEditsTextStyle = getTextStyleFragments(allowAllEditsButton);

        expect(allowAllEditsTextStyle.some((style) => style.color === lightTheme.colors.text.primary)).toBe(true);

        const shellScreen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p2', status: 'pending' },
            sessionId: 's2',
            toolName: 'Bash',
            toolInput: { command: 'pwd' },
            metadata: { flavor: 'opencode' },
        }));
        const allowForToolButton = findPermissionFooterButton(shellScreen, 'claude.permissions.yesForTool');
        const allowForToolTextStyle = getTextStyleFragments(allowForToolButton);

        expect(allowForToolTextStyle.some((style) => style.color === lightTheme.colors.text.primary)).toBe(true);
    });
});
