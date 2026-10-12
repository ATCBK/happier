import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderWithSessionTranscriptSource as renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

const { toolErrorSpy, detailLevelDefault, catalog } = vi.hoisted(() => ({
    toolErrorSpy: vi.fn(),
    detailLevelDefault: { value: 'summary' as 'summary' | 'title' },
    catalog: { knownTools: {} as Record<string, unknown> },
}));

installToolShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            NativeModules: {},
            Platform: {
                OS: 'ios',
                select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'toolViewDetailLevelDefault') return detailLevelDefault.value;
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewShowDebugByDefault') return false;
                    return null;
                } }),
            },
        });
    },
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    get knownTools() { return catalog.knownTools; },
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: () => 'MCP',
    formatMCPSubtitle: () => '',
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('fragment')(importOriginal);
});

vi.mock('../presentation/ToolError', () => ({
    ToolError: (props: any) => {
        toolErrorSpy(props);
        return null;
    },
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => React.createElement('PermissionFooter', null),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'opencode'],
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    resolveAgentIdFromFlavor: () => null,
}));

const { ToolView } = await import('./ToolView');

describe('ToolView (error message formatting)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('passes a JSON string to ToolError when the tool result is an object', async () => {

        const tool = makeToolCall({
            name: 'SomeUnknownTool',
            state: 'error',
            input: { anything: true },
            result: { error: 'Tool call failed', status: 'failed' },
        });

        await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );

        expect(toolErrorSpy).toHaveBeenCalledTimes(1);
        const args = toolErrorSpy.mock.calls[0][0];
        expect(typeof args.message).toBe('string');
        expect(args.message).toContain('"error"');
        expect(args.message).toContain('"status"');
        expect(args.message).toContain('Tool call failed');
    });
    // One place states a failure: the open body's error block, or, while the card is closed, the
    // header summary. Never both (the "unknown_error" twice seen live, 2026-10-12).
    const headerTexts = (screen: { root: { findAll: (p: (n: any) => boolean) => any[] } }) =>
        screen.root.findAll((node) => typeof node.type === 'string' && typeof node.props?.children === 'string' && node.props.children.includes('Tool call failed'))
            .map((node) => node.props.children as string);

    it('states the error once: in the open body, not again in the header', async () => {
        const tool = makeToolCall({
            name: 'SomeUnknownTool',
            state: 'error',
            input: { anything: true },
            result: { error: 'Tool call failed', status: 'failed' },
        });
        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );
        expect(toolErrorSpy).toHaveBeenCalled();
        expect(headerTexts(screen as never)).toEqual([]);
    });

    it('keeps the header summary while the card is closed', async () => {
        toolErrorSpy.mockClear();
        detailLevelDefault.value = 'title';
        const tool = makeToolCall({
            name: 'SomeUnknownTool',
            state: 'error',
            input: { title: 'Create demo README' },
            result: { error: 'Tool call failed', status: 'failed' },
        });
        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );
        expect(headerTexts(screen as never)).toEqual(['Tool call failed']);
        // The status glyph already marks the failure; the summary beside it adds words, not a second glyph.
        const warningGlyphs = (screen as never as { root: { findAll: (p: (n: any) => boolean) => any[] } }).root
            .findAll((node) => typeof node.type === 'string' && node.props?.name === 'warning-circle');
        expect(warningGlyphs).toHaveLength(1);
        detailLevelDefault.value = 'summary';
    });
    it('states the error once for a tool that hides its default error and has no view of its own', async () => {
        toolErrorSpy.mockClear();
        catalog.knownTools = { QuietFailTool: { hideDefaultError: true } };
        const tool = makeToolCall({
            name: 'QuietFailTool',
            state: 'error',
            input: { anything: true },
            result: { error: 'Tool call failed', status: 'failed' },
        });
        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
        );
        catalog.knownTools = {};
        expect(toolErrorSpy).toHaveBeenCalled();
        expect(headerTexts(screen as never)).toEqual([]);
    });
});
