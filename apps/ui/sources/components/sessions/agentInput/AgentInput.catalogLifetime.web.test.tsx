/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import type { ActiveSuggestionsHandler } from '@/components/autocomplete/useActiveSuggestions';
import { SessionSkillCatalogListResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The DOM editor and suggestion pipeline stay real; only native rendering adapters are replaced.
vi.mock('@/components/ui/forms/MultiTextInput', async () => import('@/components/ui/forms/MultiTextInput.web'));
installAgentInputCommonModuleMocks({ reactNative: async () => vi.importActual('react-native-web') });
vi.doMock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock();
    const rn = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    const hosts = { View: rn.View, ScrollView: rn.ScrollView, Text: rn.Text };
    return { ...mock, ...hosts, default: { ...mock.default, ...hosts } };
});
const catalog = createDeferred<unknown>();
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness({ rpc: async method => {
    if (method === 'session.skillCatalog.list') return catalog.promise;
    return {};
} });
const { AgentInput } = await import('./AgentInput');
const { getSuggestions } = await import('@/components/autocomplete/suggestions');
const { storage } = await import('@/sync/domains/state/storage');
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    container?.remove(); container = null;
    vi.restoreAllMocks();
});

describe('AgentInput native catalog lifetime', () => {
    it('keeps a skill query alive when only recent-reference inputs acquire fresh identities', async () => {
        const session = storage.getState().sessions.s1;
        if (!session) throw new Error('Expected scoped Session');
        storage.getState().applySessions([{ ...session, active: true }]);
        Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
        vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
        const signals: AbortSignal[] = [];
        // Observe cancellation at the caller contract while executing the real suggestion/RPC path.
        const resolve: ActiveSuggestionsHandler = (query, signal, onUpdate) => {
            signals.push(signal);
            return getSuggestions('s1', query, { kinds: ['skill'], signal, onUpdate });
        };
        function Host() {
            const [value, setValue] = React.useState('');
            return <AgentInput value={value} onChangeText={setValue} sessionId="s1" placeholder="Message"
                onSend={() => {}} autocompleteKinds={['skill']} autocompleteSuggestions={resolve}
                composerFileScope={{ serverId: runtime.serverId, machineId: 'machine-a', rootPath: '/repo' }}
                attachmentRowItems={[]} />;
        }
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
        await act(async () => { root!.render(<runtime.Wrapper><Host /></runtime.Wrapper>); });
        const editor = container.querySelector<HTMLElement>('[data-happier-text-input]')!;
        expect(editor).toBeTruthy();
        await act(async () => {
            editor.focus();
            // jsdom does not perform the browser's default text insertion.
            const selection = window.getSelection()!;
            const text = document.createTextNode('$project');
            selection.getRangeAt(0).insertNode(text);
            selection.collapse(text, text.length);
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '$project' }));
        });
        await flushHookEffects();
        expect(signals[0]).toBeDefined();
        await act(async () => { root!.render(<runtime.Wrapper><Host /></runtime.Wrapper>); });
        await flushHookEffects();
        expect(signals[0]!.aborted).toBe(false);
        catalog.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [{
            v: 1, id: 'vendor:codex:project-native', origin: 'vendor', backendId: 'codex', name: 'project-native',
        }] }));
        await flushHookEffects();
        await vi.waitFor(() => expect(document.body.textContent).toContain('project-native'));
    });
});
