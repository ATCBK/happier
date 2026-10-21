import { useEntityDragDropRuntime, useEntityDragSource, useEntityDropTarget } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import type { EntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import { createArtifactBrowserDragSource, createArtifactBrowserDropTarget, type ArtifactBrowserDropTargetInput } from './artifactBrowserDragDrop';

/** Registration reads live callbacks; pointer feedback subscriptions belong in visual leaves. */
export function useArtifactBrowserDragSource(input: Parameters<typeof createArtifactBrowserDragSource>[0]): { runtime: EntityDragDropRuntime; sourceId: string } {
    const runtime = useEntityDragDropRuntime();
    const source = createArtifactBrowserDragSource(input);
    useEntityDragSource(runtime, source);
    return { runtime, sourceId: source.id };
}

export function useArtifactBrowserDropTarget(input: ArtifactBrowserDropTargetInput): { runtime: EntityDragDropRuntime; targetId: string } {
    const runtime = useEntityDragDropRuntime();
    const target = createArtifactBrowserDropTarget(input);
    useEntityDropTarget(runtime, target);
    return { runtime, targetId: target.id };
}
