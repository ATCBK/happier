import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createTestSessionTranscriptSource, wrapWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptEstimatedItemSizePx: 120,
            transcriptBackwardPrefetchThresholdPx: 800,
        }),
    },
}));

vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const original = await importOriginal<typeof import('@legendapp/list/react-native')>();
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original }).module;
});


const { ChainTranscriptList: ChainContent } = await import('./ChainTranscriptList');

function createChainTestRoot(Content: typeof import('./ChainTranscriptList')['ChainTranscriptList']) {
    return function ChainTestRoot(props: React.ComponentProps<typeof Content>) {
        const [source] = React.useState(() => createTestSessionTranscriptSource({
            sessionId: props.sessionId, serverId: props.serverId, messages: props.messages,
            metadata: props.metadata, interaction: props.interaction,
            loadSidechain: async () => 'not_ready',
            history: { loadOlder: props.loadOlder ?? (async () => ({ loaded: 0, hasMore: false, status: 'not_ready' })) },
        }));
        return wrapWithSessionTranscriptSource(React.createElement(Content, props), source);
    };
}

describe('ChainTranscriptList empty-state footer spinner', () => {
    type ChainTranscriptListTestProps =
        Omit<React.ComponentProps<typeof import('./ChainTranscriptList')['ChainTranscriptList']>, 'datasetKey'>
        & { datasetKey?: string };

    async function renderChainTranscriptList(props: ChainTranscriptListTestProps) {
        const ChainTranscriptList = createChainTestRoot(ChainContent);
        return renderScreen(React.createElement(ChainTranscriptList, {
            ...props,
            datasetKey: props.datasetKey ?? JSON.stringify([props.sessionId, 'test-sidechain']),
        }));
    }

    afterEach(() => {
        standardCleanup();
    });

    it('keeps the initial-load footer spinner while an empty list is still loading', async () => {
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true },
            isInitialLoadInFlight: true,
        });

        expect(screen.findByTestId('chain-transcript-loading-footer')).toBeTruthy();
    });

    it('does not show a perpetual footer spinner for a loaded-but-empty list', async () => {
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true },
            isInitialLoadInFlight: false,
        });

        expect(screen.findByTestId('chain-transcript-loading-footer')).toBeNull();
    });

    it('keeps the initial-load footer spinner when no explicit load state is provided (legacy callers)', async () => {
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true },
        });

        expect(screen.findByTestId('chain-transcript-loading-footer')).toBeTruthy();
    });
});
