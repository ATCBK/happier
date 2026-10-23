import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import type { UserTextMessage } from '@happier-dev/session-core/messages';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

// Platform boundaries only: the source, storage, reference projection and Markdown stay real.
installMessageViewCommonModuleMocks({ storage: (importOriginal) => importOriginal() });
const { initializeRealAppRuntimeForTests } = await import('@/dev/testkit/harness/realAppRuntimeHarness');
await initializeRealAppRuntimeForTests();
const { createSessionFixture, renderScreen, standardCleanup, flushHookEffects, renderWithSessionTranscriptSource } = await import('@/dev/testkit');
const { storage } = await import('@/sync/domains/state/storage');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { useSessionTranscriptSource } = await import('./source/SessionTranscriptSourceContext');
const { useTranscriptSessionCommon } = await import('./transcriptSessionCommon');
const { MessageView } = await import('./MessageView');
const { ChatListMessageRow } = await import('./ChatListRows');

afterEach(() => {
    standardCleanup();
    storage.setState(storage.getInitialState(), true);
});

describe('transcript inline reference arrival costs', () => {
    it('does not re-admit unchanged reference records when the message hover changes', async () => {
        const mentions = Array.from({ length: 8 }, (_, index) => {
            const ref = `session:hover-reference-${index}`;
            const label = `Reference ${index}`;
            return { kind: 'happier.session', ref, label, token: formatInlineReferenceTokenV1({ label, ref }) };
        });
        let referenceAdmissions = 0;
        const meta: NonNullable<UserTextMessage['meta']> = { get happierStructuredInputV1() {
            referenceAdmissions += 1;
            return { v: 1 as const, mentions };
        } };
        const message: UserTextMessage = {
            kind: 'user-text', id: 'hover-reference-costs', localId: null, createdAt: 1,
            text: mentions.map(mention => mention.token).join(' '), meta,
        };
        const screen = await renderWithSessionTranscriptSource(<MessageView sessionId="s1" metadata={null} message={message} />);
        await flushHookEffects({ cycles: 5, turns: 2 });
        expect(referenceAdmissions).toBeGreaterThan(0);
        referenceAdmissions = 0;
        const hoverHost = screen.tree.root.findAll(node => typeof node.type === 'string'
            && typeof node.props.onPointerEnter === 'function' && typeof node.props.onPointerLeave === 'function')[0];
        expect(hoverHost).toBeDefined();
        for (let index = 0; index < 5; index += 1) {
            await act(async () => hoverHost!.props.onPointerEnter());
            await act(async () => hoverHost!.props.onPointerLeave());
        }
        expect(referenceAdmissions).toBe(0);

        await screen.update(<MessageView sessionId="s1" metadata={null} message={{ ...message,
            text: `Updated ${mentions[0]!.token}`,
        }} />);
        expect(screen.findAllByType('EnrichedMarkdownText').some(node => String(node.props.markdown).startsWith('Updated '))).toBe(true);
        expect(referenceAdmissions).toBeGreaterThan(0);
    });

    it('keeps historical chip rows uncommitted on unrelated arrivals', async () => {
        const session = createSessionFixture({ id: 'reference-costs' });
        const historicalCount = 100;
        const mentions = Array.from({ length: 8 }, (_, index) => {
            const ref = `session:reference-${index}`;
            const label = `Reference ${index}`;
            return { kind: 'happier.session', ref, label, token: formatInlineReferenceTokenV1({ label, ref }) };
        });
        const makeMessage = (index: number, text = mentions.map(mention => mention.token).join(' ')): NormalizedMessage => ({
            id: `reference-message-${index}`, seq: index + 1, localId: null, createdAt: index + 1,
            role: 'user', isSidechain: false, content: { type: 'text', text },
            meta: { happierStructuredInputV1: { v: 1, mentions } },
        });
        storage.getState().applySessions([session]);
        storage.getState().applyMessages(session.id, Array.from({ length: historicalCount }, (_, index) => makeMessage(index)));
        storage.getState().applyMessagesLoaded(session.id);
        const historicalIds = new Set(storage.getState().sessionMessages[session.id]!.messageIdsOldestFirst);
        let historicalCommits = 0;
        const rowProps = {
            sessionId: session.id, metadata: session.metadata, activeThinkingMessageId: null,
            resolveThinkingExpanded: () => false, setThinkingExpanded: () => {},
            rollbackRanges: [], messagePins: [], onToggleMessagePin: () => {},
            getMessageRevisionById: (id: string) => storage.getState().sessionMessages[session.id]?.messageRevisionsById?.[id] ?? null,
        };
        const Row = React.memo(function Row({ id, common }: Readonly<{ id: string; common: ReturnType<typeof useTranscriptSessionCommon> }>) {
            const interaction = useSessionTranscriptSource().useInteraction();
            return <React.Profiler id={id} onRender={() => { if (historicalIds.has(id)) historicalCommits += 1; }}>
                <ChatListMessageRow {...rowProps} messageId={id} interaction={interaction}
                    forkCommon={common.fork} messageDisplayCommon={common.messageDisplay}
                    toolChromeCommon={common.toolChrome} toolRouteCommon={common.toolRoute} />
            </React.Profiler>;
        });
        function Transcript() {
            const ids = useSessionTranscriptSource().useMessageIdsOldestFirst();
            const common = useTranscriptSessionCommon();
            return <>{ids.map(id => <Row key={id} id={id} common={common} />)}</>;
        }
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={session.id}>
            <Transcript />
        </AppSessionTranscriptSourceProvider>);
        await flushHookEffects({ cycles: 5, turns: 2 });
        expect(screen.findAllByType('EnrichedMarkdownText').length).toBeGreaterThanOrEqual(historicalCount);
        historicalCommits = 0;
        for (let index = historicalCount; index < historicalCount + 5; index += 1) {
            await act(async () => {
                await storage.getState().applyMessages(session.id, [makeMessage(index, 'Unrelated arrival')]);
            });
        }
        expect(historicalCommits).toBe(0);
    });
});
