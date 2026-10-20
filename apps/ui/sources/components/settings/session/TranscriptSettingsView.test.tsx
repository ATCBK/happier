import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { installSessionSettingsCommonModuleMocks } from './sessionSettingsViewTestHelpers';
import { createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setTranscriptMessageTimestampDisplayMode = vi.fn();
const setTranscriptShowToolCalls = vi.fn();
const setSessionThinkingDisplayMode = vi.fn();
const setSessionThinkingInlinePresentation = vi.fn();

installSessionSettingsCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: createUseSettingMutableMockFromReader((name) => {
                    if (name === 'transcriptShowToolCalls') {
                        return [undefined, setTranscriptShowToolCalls];
                    }
                    if (name === 'transcriptGroupingMode') {
                        return ['turns', vi.fn()];
                    }
                    if (name === 'transcriptGroupToolCalls') {
                        return [true, vi.fn()];
                    }
                    if (name === 'transcriptTurnToolCallsGroupStrategy') {
                        return ['consecutive_tools', vi.fn()];
                    }
                    if (name === 'transcriptToolCallsCollapsedPreviewCount') {
                        return [null, vi.fn()];
                    }
                    if (name === 'transcriptToolCallsGroupShowBackground') {
                        return [true, vi.fn()];
                    }
                    if (name === 'toolViewTimelineChromeMode') {
                        return ['activity_feed', vi.fn()];
                    }
                    if (name === 'sessionThinkingDisplayMode') {
                        return ['tool', setSessionThinkingDisplayMode];
                    }
                    if (name === 'sessionThinkingInlinePresentation') {
                        return ['summary', setSessionThinkingInlinePresentation];
                    }
                    if (name === 'transcriptMessageTimestampDisplayMode') {
                        return ['hover_web_hidden_mobile', setTranscriptMessageTimestampDisplayMode];
                    }
                    return [null, vi.fn()];
                }),
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));






// Prepare the real component after the shared mock options are installed, outside behavior deadlines.
const { TranscriptSettingsView } = await import('./TranscriptSettingsView');
const { Item } = await import('@/components/ui/lists/Item');
const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');

describe('TranscriptSettingsView', () => {
    it('renders the Account Show tool calls default as on until chosen and writes the explicit choice', async () => {
        const screen = await renderSettingsView(React.createElement(TranscriptSettingsView));

        const row = screen.findAllByType(Item).find(node => node.props.testID === 'settings-session-transcript-show-tool-calls');
        expect(row).toBeTruthy();
        expect(row?.props?.title).toBe('settingsSession.transcript.showToolCallsTitle');
        expect(row?.props?.rightElement?.props?.value).toBe(true);

        row?.props?.rightElement?.props?.onValueChange(false);
        expect(setTranscriptShowToolCalls).toHaveBeenLastCalledWith(false);
    });

    it('defaults the tool calls collapsed preview dropdown to three when the setting is unavailable', async () => {
        const screen = await renderSettingsView(React.createElement(TranscriptSettingsView));

        const dropdown = screen.findAll((node) =>
            node.props?.itemTrigger?.title === 'settingsSession.transcript.advanced.toolCallsCollapsedPreviewCountTitle'
        )[0];

        expect(dropdown?.props?.selectedId).toBe('3');
    });

    it('renders the message timestamp display dropdown in transcript layout settings', async () => {
        const screen = await renderSettingsView(React.createElement(TranscriptSettingsView));

        const dropdown = screen.findAll((node) =>
            node.props?.itemTrigger?.title === 'settingsSession.transcript.messageTimestampsTitle'
        )[0];
        expect(dropdown).toBeTruthy();
        expect(dropdown?.props?.selectedId).toBe('hover_web_hidden_mobile');
        expect(dropdown?.props?.items.map((item: any) => item.id)).toEqual([
            'hover_web_hidden_mobile',
            'hover_web_always_mobile',
            'always',
            'never',
        ]);

        const group = screen.findAllByType(ItemGroup).find(group =>
            group.findAll(node => node === dropdown).length > 0);
        expect(group?.props.title).toBe('settingsSession.transcript.layoutTitle');

        dropdown?.props?.onSelect?.('always');

        expect(setTranscriptMessageTimestampDisplayMode).toHaveBeenCalledWith('always');
    });

    it('shows thinking as picture choices', async () => {
        const screen = await renderSettingsView(React.createElement(TranscriptSettingsView));

        const thinkingRow = screen.findAllByType(Item).find(node => node.props.testID === 'settings-session-thinking-display');
        const tiles = (thinkingRow?.props.rightElement as React.ReactElement<any> | undefined);
        expect(tiles?.props.value).toBe('tool');
        expect(tiles?.props.options.map((option: { id: string }) => option.id)).toEqual(['inline_summary', 'inline_full', 'tool', 'hidden']);
        expect(tiles?.props.options.every((option: { preview?: unknown }) => option.preview != null)).toBe(true);

    });

    it('renders the Network for agent HTML choices in the agent visuals group', async () => {
        const screen = await renderSettingsView(React.createElement(TranscriptSettingsView));

        const row = screen.findAllByType(Item).find(node => node.props.testID === 'settings-session-transcript-agent-html-network');
        expect(row).toBeTruthy();
        expect(row?.props?.title).toBe('settingsSession.transcript.agentHtmlNetworkPolicy');
        // It governs what agent pages may do, so it is not listed among the UI-only tool call preferences.
        const group = screen.findAllByType(ItemGroup).find(group =>
            group.findAll(node => node === row).length > 0);
        expect(group?.props?.title).toBe('settingsSessionPages.transcript.agentVisualsSection');
        const control = row?.props?.rightElement as React.ReactElement<any> | undefined;
        expect(control?.props?.activeTabId).toBe('allowed');
        expect(control?.props?.tabs.map((tab: { id: string }) => tab.id)).toEqual(['allowed', 'ask', 'off']);
    });
});
