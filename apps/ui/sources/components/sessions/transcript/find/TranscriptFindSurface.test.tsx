import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { KeyboardShortcutContextBridge, type KeyboardShortcutContextSnapshot } from '@/keyboard/KeyboardShortcutProvider';
import { executeFindAction, registerFindActionRuntime } from '@/keyboard/findActionRuntime';
import { createFindSurfaceRegistry } from '@/keyboard/findSurfaceRegistry';
import { NO_KEYBOARD_SHORTCUT_LABELS } from '@/keyboard/shortcutLabels';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createReadOnlySessionTranscriptSource } from '../source/readOnlySessionTranscriptSource';
import type { TranscriptJumpResult, TranscriptJumpTarget } from '../viewport/jump/transcriptJumpTargetTypes';
import { TranscriptFindSurface } from './TranscriptFindSurface';
import { revealTranscriptFindMatch } from './revealTranscriptFindMatch';
import { createTranscriptFindModel, type TranscriptFindCorpus } from './useTranscriptFind';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
afterEach(standardCleanup);

describe('transcript Find surface registration', () => {
    it('withdraws addressed Find while retained ineligible and resumes its real controller when eligible again', async () => {
        const message = (id: string, seq: number): Message => ({
            kind: 'user-text', id, localId: null, createdAt: seq, seq, text: 'needle',
        });
        let corpus: TranscriptFindCorpus = {
            messages: [message('loaded', 2)],
            history: { isLoaded: true, hasOlder: true, isLoadingOlder: false },
        };
        // Paging and viewport scrolling are the external boundaries; source,
        // display projection, matching, reveal and registration remain real.
        const loadOlder = vi.fn(async () => {
            corpus = { messages: [message('older', 1), ...corpus.messages],
                history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } };
            source.update({ messages: corpus.messages, historyState: corpus.history,
                reducerState: null, metadata: null, agentState: null });
            return { loaded: 1, hasMore: false, status: 'loaded' as const };
        });
        const source = createReadOnlySessionTranscriptSource({
            sessionId: 'session', serverId: 'home', messages: corpus.messages,
            reducerState: null, metadata: null, agentState: null,
            historyState: corpus.history, loadOlder,
        });
        const jump = vi.fn(async (target: TranscriptJumpTarget): Promise<TranscriptJumpResult> => ({ status: 'scrolled', target }));
        const model = createTranscriptFindModel({
            readCorpus: () => corpus,
            loadPage: () => source.history.loadOlder!(),
            jumpToTarget: jump,
            reveal: (match, context) => revealTranscriptFindMatch(match, {
                items: [], setToolCallsGroupExpanded() {}, setThinkingExpanded() {},
                waitForVisualUpdate: async () => {}, jumpToTarget: jump, readClearancePx: () => 0,
            }, context),
        });
        const registry = createFindSurfaceRegistry();
        const release = registerFindActionRuntime(registry);
        const keyboard: KeyboardShortcutContextSnapshot = {
            registration: {
                find: registry, refreshFindAvailability() {}, registerHandlers: () => () => {},
                executeCommand: () => false, submitFindInput: () => false,
            },
            labels: NO_KEYBOARD_SHORTCUT_LABELS,
        };
        const viewportRef = React.createRef<React.ElementRef<typeof View>>();
        const publishCorpus = (next: TranscriptFindCorpus) => { corpus = next; };
        const measureMessage = () => null;
        const render = (eligible: boolean, focused = true) => <KeyboardShortcutContextBridge snapshot={keyboard}>
            <PluginSurfaceFocusEligibilityProvider active={eligible}>
                <TranscriptFindSurface model={model} source={source} sessionId="session" serverId="home"
                    focused={focused} viewportRef={viewportRef} loadedMessages={[]}
                    publishCorpus={publishCorpus} measureMessage={measureMessage} contentHeight={0}>
                    <View testID="retained-transcript" />
                </TranscriptFindSurface>
            </PluginSurfaceFocusEligibilityProvider>
        </KeyboardShortcutContextBridge>;
        const execute = (input: unknown) => executeFindAction({
            actionId: 'ui.find', input, context: { surface: 'agent' },
        });
        const unavailable = { ok: true, result: { status: 'noMountedSurface' } };
        const hiddenOperations = [
            { op: 'read', target: 'transcript:home:session' },
            { op: 'set', target: 'transcript:home:session', query: 'hidden query' },
            { op: 'step', target: 'transcript:home:session', direction: -1 },
        ];
        try {
            const screen = await renderScreen(render(true));
            await screen.update(render(false));
            for (const operation of hiddenOperations) {
                await expect(execute(operation)).resolves.toEqual(unavailable);
            }
            expect(model.getSnapshot()).toMatchObject({ open: false, query: '' });
            expect(loadOlder).not.toHaveBeenCalled();
            expect(jump).not.toHaveBeenCalled();

            await screen.update(render(true));
            await act(async () => {
                expect(await execute({ op: 'set', target: 'transcript:home:session', query: 'needle' }))
                    .toMatchObject({ result: { status: 'results', total: 1 } });
                await model.settled();
            });
            expect(model.getSnapshot()).toMatchObject({ open: true, query: 'needle' });
            expect(jump).toHaveBeenCalledWith(expect.objectContaining({ routeMessageId: 'loaded' }), expect.anything());

            // A retained open model must not page or reveal through addressed Actions.
            // The transcript's own focused fact is an independent eligibility fence.
            await screen.update(render(true, false));
            jump.mockClear();
            const retained = model.getSnapshot();
            for (const operation of hiddenOperations) {
                await expect(execute(operation)).resolves.toEqual(unavailable);
            }
            await model.settled();
            expect(model.getSnapshot()).toBe(retained);
            expect(loadOlder).not.toHaveBeenCalled();
            expect(jump).not.toHaveBeenCalled();

            await screen.update(render(true));
            await act(async () => {
                await execute({ op: 'step', target: 'transcript:home:session', direction: -1 });
                await model.settled();
            });
            expect(await execute({ op: 'read', target: 'transcript:home:session' })).toMatchObject({
                result: { status: 'results', current: 1, total: 2, coverage: 'complete' },
            });
            expect(loadOlder).toHaveBeenCalled();
            expect(jump).toHaveBeenCalledWith(expect.objectContaining({ routeMessageId: 'older' }), expect.anything());
        } finally {
            release();
            model.dispose();
        }
    });
});
