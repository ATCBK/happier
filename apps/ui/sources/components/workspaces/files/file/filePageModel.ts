import type { FileDisplayMode } from './FileActionToolbar';
import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveVisibleAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';

export type FilePageMode = 'view' | 'preview' | 'source' | 'changes';
export type FilePageModeOption = Readonly<{ id: FilePageMode; displayMode: FileDisplayMode }>;

export function resolveFilePageAttribution(input: Readonly<{
    agentName: string | null;
    requesterActor: TranscriptAccountActor | null | undefined;
    viewerScope: ServerAccountScope | null;
    hasOtherNamedCollaborator: boolean;
}>) {
    const requester = input.agentName && input.hasOtherNamedCollaborator
        ? resolveVisibleAccountActorPresentation({ actor: input.requesterActor, viewerScope: input.viewerScope,
            hasOtherNamedCollaborator: input.hasOtherNamedCollaborator })
        : null;
    return { agentName: input.agentName, requesterName: requester?.name ?? null };
}

export function resolveFilePageHeaderModel(input: Readonly<{
    kind: string;
    hasRenderableDiff: boolean;
    deleted?: boolean;
    pluginViewerSelected?: boolean;
    hasText: boolean;
    writeSupported: boolean;
    partial?: boolean;
    editorAvailable?: boolean;
}>) {
    const preview = input.kind === 'markdown' || input.kind === 'svg';
    const modes: FilePageModeOption[] = input.pluginViewerSelected ? []
        : input.deleted ? [{ id: 'changes', displayMode: 'diff' }]
        : preview ? [{ id: 'preview', displayMode: 'markdown' }, { id: 'source', displayMode: 'file' }]
        : [{ id: 'view', displayMode: 'file' }];
    if (!input.pluginViewerSelected && !input.deleted && input.hasRenderableDiff && !input.partial) {
        modes.push({ id: 'changes', displayMode: 'diff' });
    }
    const editUnavailableReason: 'partial' | 'binary' | 'unsupported' | 'unavailable' | null = input.partial ? 'partial'
        : !input.hasText ? 'binary'
        : !input.writeSupported || input.deleted ? 'unsupported'
        : input.editorAvailable === false ? 'unavailable' : null;
    return { modes, findAvailable: input.hasText && !input.pluginViewerSelected, editUnavailableReason };
}
