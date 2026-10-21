import { Platform } from 'react-native';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import { ComposerTransactionResultV1Schema } from '@happier-dev/protocol/plugins/ui/composer';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import type { WorkspaceFileOpenInput } from '@happier-dev/protocol/actions/workspaceActionFamily';

import { useWorkspaceFileTransfers, type WorkspaceFileCachedContent, type WorkspaceFileDownloadAction } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { FileSuggestionScope } from '@/sync/domains/input/suggestionFile';
import { readMountedComposerPresentationSnapshot } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { resolveComposerEntityDrop } from '@/components/sessions/composer/composerEntityDrop';
import { describeComposerEntityDropReason } from '@/components/sessions/composer/composerEntityDropReason';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { isAbsoluteLocalPath, normalizeLocalPathForComparison } from '@/utils/path/resolvePathRelativeToRoot';
import { buildWorkspaceFileLink } from '@/utils/url/sessionFileDeepLink';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { buildFileShareClipboardRequest, resolveFileShareActionScope, type FileShareClipboardIntent } from './fileShareClipboard';
import { canOpenFileInDefaultApp } from '@/sync/runtime/files/saveFileBytes';
import { Modal } from '@/modal';
import { t } from '@/text';

type FileShareCallback = () => void | Promise<void>;

export type WorkspaceFileShareActionsInput = Readonly<{
    workspaceScope: WorkspaceScopeBase | null;
    path: string;
    actionScope?: ServerAccountScope | null;
    linkInput?: WorkspaceFileOpenInput;
    homeDir?: string | null;
    machineReachable: boolean;
    unavailableReason: string;
    cachedContent?: WorkspaceFileCachedContent | null;
    composer?: Readonly<{ scope: EntityDragScopeV1; ref: ComposerRefV1; workspace: FileSuggestionScope | null }> | null;
    onSaveAsArtifact?: FileShareCallback;
}>;

/** Supplies behaviour to the canonical file menu; platform and menu presentation stay separate. */
export function useWorkspaceFileShareActions(input: WorkspaceFileShareActionsInput) {
    const transfers = useWorkspaceFileTransfers({ workspaceScope: input.workspaceScope });
    const actionScope = resolveFileShareActionScope(input.actionScope, input.composer?.scope);
    const execution = useMountedActionExecution(actionScope, { openOnRequest: true, retainInvocation: true });
    const report = async (run: () => Promise<void>) => {
        try { await run(); }
        catch (error) { Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.operationFailed')); }
    };
    const expandedRoot = input.workspaceScope ? resolveAbsolutePath(input.workspaceScope.rootPath, input.homeDir ?? undefined) : null;
    const absolutePath = expandedRoot && isAbsoluteLocalPath(normalizeLocalPathForComparison(expandedRoot) ?? '')
        ? resolveMachineAbsolutePath({ rootPath: expandedRoot, requestPath: input.path, pathKind: 'workspace_entry' })
        : null;
    const copy = (intent: FileShareClipboardIntent) => report(async () => {
        if (!execution.isCurrent()) return;
        const request = buildFileShareClipboardRequest({ relativePath: input.path, absolutePath,
            link: intent.kind === 'link' && input.linkInput ? buildWorkspaceFileLink(input.linkInput) : null,
        }, intent);
        if (!request) throw new Error(t('common.unavailable'));
        const result = await execution.execute(request.actionId, request.input);
        if (!execution.isCurrent()) return;
        if (!result.ok) throw new Error(result.error);
    });
    const download = (action?: WorkspaceFileDownloadAction) => report(async () => {
        if (action === 'open' && !input.machineReachable) throw new Error(input.unavailableReason);
        if (!input.machineReachable && !input.cachedContent) throw new Error(input.unavailableReason);
        const result = await transfers.startDownload({ path: input.path, asZip: false,
            action,
            ...(!input.machineReachable ? { cachedContent: input.cachedContent } : {}),
        });
        if (!result.ok && !result.canceled) throw new Error(result.error);
    });
    const openSupported = canOpenFileInDefaultApp();
    const openInDefaultApp = openSupported ? () => download('open') : undefined;
    const composer = input.composer;
    const attachToMessage = composer && input.workspaceScope ? () => report(async () => {
        if (!areServerAccountScopesEqual(actionScope, composer.scope)) throw new Error(describeComposerEntityDropReason('scopeMismatch'));
        if (!execution.isCurrent()) return;
        if (!input.machineReachable && !input.cachedContent) throw new Error(input.unavailableReason);
        const source = input.workspaceScope!;
        const snapshot = readMountedComposerPresentationSnapshot({ scope: composer.scope, ref: composer.ref });
        const admission = resolveComposerEntityDrop({ kind: 'repository-file', scope: {
            serverId: source.serverId, accountId: composer.scope.accountId,
        }, machineId: source.machineId, path: resolveMachineAbsolutePath({ rootPath: source.rootPath, requestPath: input.path, pathKind: 'workspace_entry' }) }, {
            ...composer, snapshot, sessions: [], reason: describeComposerEntityDropReason,
            preview: { verb: t('entityDragDrop.composer.addContext'), target: t('entityDragDrop.composer.target') },
        });
        if (admission.status !== 'allowed') throw new Error(admission.reason.message);
        const result = await execution.execute('composer.transaction.apply', admission.effect.input);
        if (!execution.isCurrent()) return;
        if (!result.ok) throw new Error(result.error);
        const output = ComposerTransactionResultV1Schema.safeParse(result.result);
        if (!output.success) throw new Error(t('common.unavailable'));
        if (output.data.status !== 'applied') throw new Error(describeComposerEntityDropReason(output.data.status));
    }) : undefined;
    return {
        attachToMessage, download, openInDefaultApp, saveAsArtifact: input.onSaveAsArtifact,
        copyPath: actionScope ? (options?: Readonly<{ absolute?: boolean }>) => copy({ kind: 'path', absolute: options?.absolute }) : undefined,
        copyAbsolutePath: actionScope && absolutePath ? () => copy({ kind: 'path', absolute: true }) : undefined,
        copyLink: actionScope && input.linkInput ? () => copy({ kind: 'link' }) : undefined,
        shareFile: Platform.OS === 'android' ? () => download('share') : undefined,
        busy: transfers.downloadState.status === 'downloading',
    };
}
