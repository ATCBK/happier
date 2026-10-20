import { describe, expect, it } from 'vitest';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { createArtifactBrowserDragSource, createArtifactBrowserDropTarget } from './artifactBrowserDragDrop';

const scope = { serverId: 'home', accountId: 'account' };
const bounds = { x: 0, y: 0, width: 300, height: 400 };
const folders = { v: 1 as const, folders: [{ id: 'parent', name: 'Parent', parentId: null },
    { id: 'child', name: 'Child', parentId: 'parent' }] };

describe('Artifact browser entity drag and drop', () => {
    it('keys the admitted folder independently of revision and preview text', () => {
        let revision = 1;
        const target = createArtifactBrowserDropTarget({ id: 'library', scope,
            getCatalog: () => ({ folders, revision, canWrite: true }), getBounds: () => bounds,
            getRows: () => [], getDropZones: () => [], describeFolder: folder => `${revision}:${folder?.name ?? 'Library'}`,
            describeMove: name => name, describeRefusal: code => code, execute: async () => ({ status: 'applied' }) });
        const key = (folderId: string | null, item = createArtifactBrowserDragSource({ scope,
            entity: { kind: 'artifact', artifactId: 'doc' }, isCurrent: () => true }).getItem()!) => {
            const context = { item, pointer: null, destination: { folderId }, input: 'keyboard' as const };
            const admission = target.resolve(context);
            expect(admission.status).toBe('allowed');
            if (admission.status !== 'allowed') throw new Error('Expected an admitted folder');
            return target.getDestinationKey?.(context, admission);
        };
        const child = key('child');
        expect(child).toEqual(expect.any(String));
        revision++;
        expect(key('child')).toBe(child);
        expect(key(null)).not.toBe(child);
        expect(key(null, createArtifactBrowserDragSource({ scope, entity: { kind: 'artifact-folder', folderId: 'child' }, isCurrent: () => true }).getItem()!))
            .toBe(key(null));
    });
    it('uses the shared chooser runtime for personal artifact moves and prevents folder cycles', () => {
        const runtime = createEntityDragDropRuntime();
        runtime.registerSource(createArtifactBrowserDragSource({ scope, entity: { kind: 'artifact', artifactId: 'shared' },
            isCurrent: () => true }));
        runtime.registerSource(createArtifactBrowserDragSource({ scope, entity: { kind: 'artifact-folder', folderId: 'parent' },
            isCurrent: () => true }));
        runtime.registerTarget(createArtifactBrowserDropTarget({ id: 'library', scope,
            getCatalog: () => ({ folders, revision: 7, canWrite: true }), getBounds: () => bounds,
            getRows: () => [], getDropZones: () => [],
            describeFolder: folder => folder?.name ?? 'Library', describeMove: () => 'Move to folder',
            describeRefusal: code => code,
            execute: async () => ({ status: 'applied' }),
        }));
        const destinations = runtime.getDestinations('artifact:shared');
        const child = destinations.find(destination => destination.label === 'Child');
        expect(child?.admission).toMatchObject({ status: 'allowed', effect: { actionId: 'artifact.folder.set',
            input: { artifactId: 'shared', folderId: 'child', expectedRevision: 7 } } });
        expect(runtime.getDestinations('folder:parent').find(destination => destination.label === 'Child')?.admission)
            .toMatchObject({ status: 'refused' });
    });

    it('resolves pointer nesting through the shared tree instruction and refuses stale catalog writes', () => {
        let canWrite = true;
        const runtime = createEntityDragDropRuntime();
        runtime.registerSource(createArtifactBrowserDragSource({ scope, entity: { kind: 'artifact', artifactId: 'doc' },
            isCurrent: () => true }));
        runtime.registerTarget(createArtifactBrowserDropTarget({ id: 'library', scope,
            getCatalog: () => ({ folders, revision: 3, canWrite }), getBounds: () => bounds,
            getRows: () => [{ id: 'folder:child', parentId: 'folder:parent', containerId: 'folder:parent', depth: 1,
                kind: 'container', bounds: { x: 0, y: 40, width: 300, height: 40 } }], getDropZones: () => [],
            describeFolder: folder => folder?.name ?? 'Library', describeMove: () => 'Move to folder',
            describeRefusal: code => code,
            execute: async () => ({ status: 'applied' }),
        }));
        const carry = runtime.begin('artifact:doc');
        carry?.move({ x: 100, y: 60 });
        expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { actionId: 'artifact.folder.set',
            input: { artifactId: 'doc', folderId: 'child', expectedRevision: 3 } } });
        canWrite = false;
        runtime.refresh();
        expect(runtime.getSnapshot().admission).toMatchObject({ status: 'refused', reason: { code: 'catalog-unavailable' } });
    });
});
