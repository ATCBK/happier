import * as React from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { nativeDocumentPickerBoundary } from '@/components/workspaces/files/repositoryTree/repositoryUploadBrowserTestFixture';

installSessionFilesViewBoundaries({ confirmResult: true });
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: key => key }));
const { ProjectBrowseFilesSurface } = await import('./ProjectBrowseFilesSurface');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
beforeAll(prepareSessionFilesViewTestkit);
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

it('keeps the Files companion browsing while promoting a literal file to existing Details', async () => {
    const rootPath = '/files-companion-promotion';
    fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
        if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
            const path = (request.payload as { path: string }).path;
            return { ok: true, path, truncated: false, entries: [{ name: 'name ', path: `${path}/name `, type: 'file' }] };
        }
        if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
        if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: null,
            entries: (request.payload as { paths: string[] }).paths.map(path => ({ path, kind: 'none' })) };
        return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
    } });
    const { useRepositoryTreeBrowserState } = await import('@/hooks/workspaces/files/repositoryTreeBrowserState');
    const { tryBuildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
    const scopeKey = tryBuildWorkspaceCacheKey(fixture.scope)!;
    function ExistingCodeLocation() {
        const { setLocation } = useRepositoryTreeBrowserState(scopeKey);
        React.useEffect(() => setLocation({ path: 'nested/existing', kind: 'file' }), [setLocation]);
        return null;
    }
    const onOpenFile = vi.fn<(path: string) => void>();
    const screen = await fixture.render(<><ExistingCodeLocation /><ProjectBrowseFilesSurface scopeId="companion-test" scope={fixture.scope}
        workspaceRef={{ id: 'companion-project', ...fixture.scope, createdAtMs: 1 }}
        onOpenFile={onOpenFile} onOpenFilePinned={() => {}} /></>);
    const rowId = `repository-tree-row-${toTestIdSafeValue('nested/name ')}`;
    await vi.waitFor(() => expect(screen.findByTestId(rowId)).toBeTruthy());
    await screen.pressByTestIdAsync(rowId);
    expect(onOpenFile).toHaveBeenCalledWith('nested/name ');
    expect(screen.findByTestId('workspace-code-table')).toBeTruthy();
    expect(screen.findByTestId('workspace-code-file')).toBeNull();
    const onNavigate = vi.fn();
    await screen.update(fixture.wrap(<ProjectBrowseFilesSurface scopeId="companion-test" scope={fixture.scope}
        workspaceRef={{ id: 'companion-project', ...fixture.scope, createdAtMs: 1 }}
        location={{ path: 'nested', kind: 'folder' }} onNavigate={onNavigate}
        onOpenFile={onOpenFile} onOpenFilePinned={() => {}} />));
    await screen.pressByTestIdAsync(rowId);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onOpenFile).toHaveBeenCalledTimes(2);
});

it('keeps the shared visibility choice reachable on a Code folder page', async () => {
    const rootPath = '/code-folder-visibility';
    fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
        if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
            const path = (request.payload as { path: string }).path;
            return { ok: true, path, truncated: false, gitIgnoreAvailable: true, entries: [
                { name: 'source.ts', path: `${path}/source.ts`, type: 'file', gitIgnored: false },
                { name: 'generated.txt', path: `${path}/generated.txt`, type: 'file', gitIgnored: true },
            ] };
        }
        if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
        if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: null,
            entries: (request.payload as { paths: string[] }).paths.map(path => ({ path, kind: 'none' })) };
        return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
    } });
    const screen = await fixture.render(<ProjectBrowseFilesSurface scopeId="code-visibility" scope={fixture.scope}
        workspaceRef={{ id: 'visibility-project', ...fixture.scope, createdAtMs: 1 }}
        location={{ path: '', kind: 'folder' }} onNavigate={() => {}}
        onOpenFile={() => {}} onOpenFilePinned={() => {}} />);
    await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-source.ts')).toBeTruthy());
    expect(screen.findByTestId('repository-tree-row-generated.txt')).toBeNull();
    // The Code page keeps one line of controls: ignored files are a View choice, not a second row.
    expect(screen.findByTestId('repository-tree-visibility:all')).toBeNull();
    await screen.pressByTestIdAsync('workspace-repository-tree-view');
    await vi.waitFor(() => expect(screen.findByTestId('workspace-repository-tree-all-files')).toBeTruthy());
    await screen.pressByTestIdAsync('workspace-repository-tree-all-files');
    await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-generated.txt')).toBeTruthy());
    await screen.pressByTestIdAsync('workspace-repository-tree-view');
    // Project view | All files are the two choices of one group (lab FB1v); Project view hides them again.
    await vi.waitFor(() => expect(screen.findByTestId('workspace-repository-tree-project-files')).toBeTruthy());
    await screen.pressByTestIdAsync('workspace-repository-tree-project-files');
    await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-generated.txt')).toBeNull());
});

it('keeps root creation, upload and View controls usable without a second search field', async () => {
    const rootPath = '/code-root-controls';
    let created = false;
    fixture = await createSessionFilesViewFixture({ rootPath, serverIdentityId: 'srv_code_root_controls', rpc: request => {
        if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
            const path = (request.payload as { path: string }).path;
            return { ok: true, path, truncated: false, entries: [
                { name: 'source.ts', path: `${path}/source.ts`, type: 'file' },
                ...(created ? [{ name: 'created.ts', path: `${path}/created.ts`, type: 'file' }] : []),
            ] };
        }
        if (request.method === 'daemon.filesystem.writeFile') {
            expect(request.payload).toMatchObject({ rootPath, path: `${rootPath}/created.ts`, content: '' });
            created = true;
            return { success: true, hash: 'created-hash' };
        }
        if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
        if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: null,
            entries: (request.payload as { paths: string[] }).paths.map(path => ({ path, kind: 'none' })) };
        return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
    } });
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.prompt).mockResolvedValueOnce('created.ts');
    const onOpenFilePinned = vi.fn<(path: string) => void>();
    const screen = await fixture.render(<ProjectBrowseFilesSurface scopeId="code-root-controls" scope={fixture.scope}
        workspaceRef={{ id: 'root-controls-project', ...fixture.scope, createdAtMs: 1 }}
        location={{ path: '', kind: 'folder' }} onNavigate={() => {}}
        onOpenFile={() => {}} onOpenFilePinned={onOpenFilePinned} />);
    await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-source.ts')).toBeTruthy());
    expect(screen.findByTestId('workspace-repository-tree-search')).toBeNull();
    await screen.pressByTestIdAsync('repository-tree-create-button');
    await vi.waitFor(() => expect(screen.findByTestId('repository-tree-create-file')).toBeTruthy());
    await screen.pressByTestIdAsync('repository-tree-create-file');
    await vi.waitFor(() => expect(created, JSON.stringify(vi.mocked(Modal.alert).mock.calls)).toBe(true));
    await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-created.ts')).toBeTruthy());
    expect(onOpenFilePinned).toHaveBeenCalledWith('created.ts');
    await screen.pressByTestIdAsync('repository-tree-create-button');
    await vi.waitFor(() => expect(screen.findByTestId('repository-tree-upload-files')).toBeTruthy());
    nativeDocumentPickerBoundary.mockResolvedValueOnce({ canceled: true, assets: [] });
    await screen.pressByTestIdAsync('repository-tree-upload-files');
    await vi.waitFor(() => expect(nativeDocumentPickerBoundary).toHaveBeenCalledWith({ multiple: true, type: '*/*' }));
    expect(fixture.requests.filter(request => request.method === 'daemon.filesystem.writeFile')).toHaveLength(1);
    const listedBeforeRefresh = fixture.requests.filter(request => request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY).length;
    await screen.pressByTestIdAsync('workspace-repository-tree-view');
    await vi.waitFor(() => expect(screen.findByTestId('workspace-repository-tree-refresh')).toBeTruthy());
    await screen.pressByTestIdAsync('workspace-repository-tree-refresh');
    await vi.waitFor(() => expect(fixture!.requests.filter(request => request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY).length).toBeGreaterThan(listedBeforeRefresh));
});
