import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { transferMachine } from '@/components/sessions/files/sessionFileTransferTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';

// Native runtime selection must be hoisted before Account/runtime imports; a late helper override
// otherwise leaves this iOS fixture bound to the web transport and decoder environment.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-image', () => ({ Image: 'ExpoImage' }));
const fileSystem = vi.hoisted(() => ({ files: new Map<string, number[]>() }));
vi.mock('expo-file-system', async () => {
    const boundary = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
    fileSystem.files = boundary.files;
    return boundary.module;
});
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
beforeAll(prepareSessionFilesViewTestkit);
beforeEach(async () => {
    fileSystem.files.clear();
    const transfer = createSessionFileNativeTransferBoundary();
    const serverIdentityId = 'srv_attachment_image_aspect';
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test', serverIdentityId,
        accountId: 'alice', machineId: 'm1', actionId: 'daemon.filesystem.download', tokenEpoch: 0,
        execute: (input, { target }) => {
            if (target.kind !== 'machine') throw new Error('Expected a preview Machine');
            return transfer.rpc({ targetId: target.machineId,
                method: getActionSpec('daemon.filesystem.download').bindings!.rpcMethod!, payload: input });
        },
    });
    const machine = transferMachine({ id: 'm1', storageMode: 'plain', installationId: boundary.machine.installationId,
        installationPublicKey: boundary.machine.installationPublicKey, replacedByMachineId: null, access: boundary.machine.access });
    const row = { ...boundary.machine, operationProtocolCapabilities: machine.operationProtocolCapabilities,
        operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision,
        daemonState: encodePlainMachineStoredContent(machine.daemonState) };
    fixture = await createSessionFilesViewFixture({ sessionId: 's1', rootPath: '/repo', machine, serverIdentityId,
        credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'alice', provenance: { v: 1, kind: 'account', authority: 'present_user' }, tokenEpoch: 0 })).toString('base64url')}.signature` },
        machineCarrierOrigin: transfer.origin, rpc: transfer.rpc, request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines') return Response.json([row]);
            if (parsed.pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                id => id === row.id ? row : null);
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: row });
            if (parsed.pathname.startsWith('/v1/actions/')) {
                const response = await boundary.handle(parsed, init);
                if (response) return response;
            }
            return transfer.request(url, init);
        } });
    fixture.storage.getState().applySettingsLocal({ filesImagePreviewCacheMaxEntries: 0, filesImagePreviewMaxBytes: 1_000_000 });
});
afterEach(async () => { standardCleanup(); await fixture.dispose(); });

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('AttachmentsInlineImages aspect ratios', () => {
    it('preserves transcript attachment image aspect ratios after loaded previews report dimensions', async () => {
        const { AttachmentsInlineImages } = await import('./AttachmentsInlineImages');

        const attachment = {
            name: 'wide.png',
            path: '.happier/uploads/messages/message-1/wide.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            sha256: 'hash',
        };

        const screen = await renderScreen(
            <AttachmentsInlineImages
                sessionId="s1"
                attachments={[attachment]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        const tileTestID = `message-attachments-inline-image:${attachment.path}`;
        const previewTestID = `message-attachments-inline-image-preview:${attachment.path}`;

        await vi.waitFor(() => expect(screen.findByTestId(previewTestID)).not.toBeNull());
        expect(fileSystem.files.get(screen.findByTestId(previewTestID)?.props.source.uri)).toEqual([97, 98, 99]);

        expect(flattenStyle(screen.findByTestId(tileTestID)?.props.style)).toMatchObject({
            width: 84,
            height: 84,
        });

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId(previewTestID), 'onLoad', {
                cacheType: 'none',
                source: {
                    url: 'blob:preview',
                    width: 1600,
                    height: 900,
                    mediaType: 'image/png',
                },
            });
        });

        expect(flattenStyle(screen.findByTestId(tileTestID)?.props.style)).toMatchObject({
            width: 220,
            height: 124,
        });
        expect(screen.findByTestId(previewTestID)?.props.contentFit).toBe('contain');
    });
});
