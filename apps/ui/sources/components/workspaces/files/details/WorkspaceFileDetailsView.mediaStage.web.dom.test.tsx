// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Real RNW controls and portals are necessary: renderer refs cannot establish browser focus.
vi.mock('react-native', async () => {
    const { createRequire } = (await import('@/dev/vitestNodeBuiltins')).getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    const actual = await vi.importActual<Record<string, unknown>>(createRequire(import.meta.url).resolve('react-native-web'));
    return (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(actual);
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsRealModule());
vi.mock('@/utils/web/reactDomCjs', async () => {
    const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
    return { requireReactDOM: () => actual };
});
// Vitest does not select platform extensions; retain the real browser origin adapter.
vi.mock('@/components/ui/media/stage/hideStageOrigin', async () => vi.importActual('@/components/ui/media/stage/hideStageOrigin.web'));
// Observe focus after the native animation boundary has reported its completed exit.
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated'))
    .createReanimatedModuleMock({ settleTimingCallbacks: true }));

await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { ModalProvider } = await import('@/modal');

const filePath = 'assets/focus.svg';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="black" /></svg>';
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(async () => {
    standardCleanup();
    // Blob custody is real Node I/O; jsdom provides the browser/DOM boundary.
    vi.stubGlobal('Blob', getVitestNodeBuiltin<typeof import('node:buffer')>('node:buffer').Blob);
    vi.stubGlobal('URL', getVitestNodeBuiltin<typeof import('node:url')>('node:url').URL);
    const transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode(svg), name: filePath });
    const settings = createAccountSettingsHttpBoundary({ serverUrl: 'https://session-file-views.test',
        initialAccounts: [{ accountId: 'alice', snapshot: { content: { t: 'plain', v: {} }, version: 0 } }] });
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_file_stage_focus', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: input => transfer.rpc({ targetId: 'm1',
            method: getActionSpec('daemon.filesystem.readFile').bindings!.rpcMethod!, payload: input }) });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_file_stage_focus', machineCarrierOrigin: transfer.origin,
        request: async (url, init) => {
            const settingsResponse = settings.handle(url, init);
            if (settingsResponse) return settingsResponse;
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? transfer.request(url, init);
        },
        rpc: request => request.method === 'scm.diff.file' ? { success: true, diff: '' } : transfer.rpc(request),
    });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot());
    applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [{ ...fixture.scope, id: 'project:stage-focus',
        label: null, createdAtMs: 1, lastOpenedAtMs: null }] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(fixture.wrap(<ModalProvider>
        <WorkspaceFileDetailsView scopeId="project:stage-focus" targetKind="project" workspaceRefId="project:stage-focus"
            scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={null} />
    </ModalProvider>)));
});

afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    await fixture?.dispose();
    standardCleanup();
    vi.unstubAllGlobals();
});

describe('real File-page Media stage focus', () => {
    it.each(['file-header-expand', 'file-viewer-body-open'] as const)('returns Escape to the actual %s opener', async (testId) => {
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(container!.querySelector(`[data-testid="${testId}"]`), container!.textContent).not.toBeNull();
        });
        const opener = container!.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
        await act(async () => opener.focus());
        expect(document.activeElement).toBe(opener);
        await act(async () => {
            const pointer = { bubbles: true, cancelable: true, button: 0, clientX: 4, clientY: 4 };
            opener.dispatchEvent(new MouseEvent('mousedown', { ...pointer, buttons: 1 }));
            opener.dispatchEvent(new MouseEvent('mouseup', { ...pointer, buttons: 0 }));
            opener.dispatchEvent(new MouseEvent('click', { ...pointer, buttons: 0 }));
        });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="media-stage"]')).not.toBeNull());
        expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
        await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="media-stage"]')).toBeNull());
        expect(document.activeElement).toBe(opener);
    });
});
