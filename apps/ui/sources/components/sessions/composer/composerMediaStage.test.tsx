import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

describe('Composer draft media stage', () => {
    it.each([
        { mimeType: 'image/png', boards: 1 },
        { mimeType: 'image/jpeg', boards: 0 },
    ])('keeps $mimeType presentation from draft intake through the real row and stage', async ({ mimeType, boards }) => {
        const { useAttachmentDraftManager } = await import('@/components/sessions/attachments/useAttachmentDraftManager');
        const { projectAgentInputAttachmentRowItems } = await import('@/components/sessions/agentInput/agentInputContracts');
        const { AgentInputAttachmentsRow } = await import('@/components/sessions/agentInput/components/AgentInputAttachmentsRow');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { ModalProvider } = await import('@/modal');
        // The draft owns this pre-materialized URI. A filename or URI extension cannot supply its MIME.
        function DraftRow() {
            const manager = useAttachmentDraftManager({ enabled: true, maxFileBytes: 24, initialDrafts: [{
                id: 'capture', status: 'pending', source: {
                    kind: 'memory', name: 'Capture', bytes: new Uint8Array([1, 2, 3]), mimeType, previewUri: 'blob:composer-capture',
                },
            }] });
            return <AgentInputAttachmentsRow items={projectAgentInputAttachmentRowItems({ transferAttachments: manager.agentInputAttachments })} />;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><DraftRow /></ModalProvider></InjectedAuthProvider>);
        try {
            await screen.pressByTestIdAsync('agent-input-attachment-image:capture');
            expect(screen.findByTestId('media-stage-image')!.props.source).toEqual({ uri: 'blob:composer-capture' });
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 100, height: 60 } }));
            expect(screen.findAllHostsByTestId('media-stage-image-checkerboard')).toHaveLength(boards);
        } finally {
            await screen.unmount();
        }
    });
});
