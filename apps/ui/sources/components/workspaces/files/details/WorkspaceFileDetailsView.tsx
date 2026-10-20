import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { FilePageHeader, FilePageToolbar } from '@/components/workspaces/files/file/FilePageHeader';
import { FilePagePluginViewerHeader } from '@/components/workspaces/files/file/FilePagePluginViewerHeader';
import { resolveFilePageEditControl } from '@/components/workspaces/files/file/filePageModel';
import { FileCodeSkeleton, FilePartialFooter, FileReadingLine, FileTooLargeState, formatFilePageBytes } from '@/components/workspaces/files/file/FilePageStates';
import type { FileDisplayMode } from '@/components/workspaces/files/file/filePageModel';
import { resolveFileMenuItems, type FileMenuContext } from '@/components/workspaces/files/file/fileMenus';
import { useFilePageCodeIntelligence } from '@/components/workspaces/files/intelligence/useFilePageCodeIntelligence';
import { useWorkspaceFileShareActions } from '@/components/workspaces/files/file/useWorkspaceFileShareActions';
import { reconstructWorkspaceFileTextBytes } from '@/sync/ops/workspaceFileSystem/workspaceFileTextDecoding';
import { SaveFileAsArtifactDialog } from '@/components/workspaces/files/file/SaveFileAsArtifactDialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { retryMachineReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useWorkspaceFileLiveMoment } from './workspaceFileDetails/useWorkspaceFileLiveMoment';
import { FileErrorState, FileLoadingState } from '@/components/workspaces/files/file/FileScreenState';
import { FileViewerBody } from '@/components/workspaces/files/file/FileViewerBody';
import { CheckoutUnreachableState, useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { FileContentPanel, resolveFileCodeGeometry } from '@/components/workspaces/files/file/FileContentPanel';
import { FileChangesSection, type FileChangesDiffSurface } from '@/components/workspaces/files/file/changes/FileChangesRegions';
import { useFileChangesReview } from '@/components/workspaces/files/file/changes/useFileChangesReview';
import type { FileChangesScope } from '@happier-dev/protocol/scm';
import { FileViewerFindSurface } from './FileViewerFindSurface';
import { useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { FileEditorPanel } from '@/components/workspaces/files/file/editor/FileEditorPanel';
import { FileEditorAskControls } from '@/components/workspaces/files/file/editor/FileEditorAskControls';
import { FileReadAskControls } from '@/components/workspaces/files/file/FileReadAskControls';
import { FileEditorNoticeLine } from '@/components/workspaces/files/file/editor/FileEditorNoticeLine';
import { buildEditorChangeMarkers } from '@/components/ui/code/editor/editorChangeMarkers';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { FileEditorCompareBody } from '@/components/workspaces/files/file/editor/FileEditorCompareBody';
import { useFilePageAttribution } from '@/components/workspaces/files/file/useFilePageAttribution';
import { FileBlameNote, useFileBlameRegion } from '@/components/workspaces/files/file/blame/FileBlameRegion';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';

import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useDetailsTabChrome } from '@/components/appShell/panes/details/workspace/detailsTabChrome';
import type { ScmEntryKind } from '@happier-dev/protocol';
import { getPreferredLanguage, t } from '@/text';

import { buildFileLineSelectionFingerprint, canStartLineSelection, canUseLineSelection } from '@/scm/scmLineSelection';
import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { allowsLiveStaging, isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';
import { useFileDetailsDiffMode } from '@/scm/diff/useFileDetailsDiffMode';
import { buildScmDiffSnapshotSignature } from '@/scm/diffCache/scmDiffCacheKey';
import type { ScmDiffArea } from '@happier-dev/protocol';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Modal } from '@/modal';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import {
    DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1,
    WorkspaceFileViewerPreferencesV1Schema,
    applyWorkspaceFileViewerPreferenceMutationV1,
} from '@happier-dev/protocol/account/settings/workspaceFileViewerPreferencesV1';
import type { OpenableContentStatResultV1 } from '@happier-dev/protocol';

import { useWorkspaceFileDetailsLoading } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileDetailsLoading';
import { recordRecentWorkspaceFile } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceFileEditorState } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState';
import { readWorkspaceFileEditorDraft, type WorkspaceFileEditorDraft } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraft';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { useWorkspaceFileEditorCommands } from './workspaceFileDetails/useWorkspaceFileEditorCommands';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import {
    storage,
    useActiveServerAccountScope,
    useProjectForSession,
    useSessionListPreferredMetadata,
    useSetting,
    useSettingsSelector,
    useSettingsVersion,
    useWorkspaceReviewCommentsDrafts,
    useWorkspaceScmCommitSelectionPatches,
    useWorkspaceScmCommitSelectionPaths,
    useWorkspaceScmInFlightOperation,
    useWorkspaceScmSnapshot,
} from '@/sync/domains/state/storage';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useFileScmStageActions } from '@/hooks/session/files/useFileScmStageActions';
import { useWorkspaceFileScmStageActions } from '@/hooks/workspaces/scm/useWorkspaceFileScmStageActions';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveFileDetailsDisplayMode } from './workspaceFileDetails/resolveFileDetailsDisplayMode';
import { resolveFileDetailsRenderableDiff } from './workspaceFileDetails/resolveFileDetailsRenderableDiff';
import { useWorkspaceFileView } from './workspaceFileDetails/useWorkspaceFileView';
import { resolveFilePageHeaderModel } from '../file/filePageModel';
import { registerFileViewActionOwner, type FileViewActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import type { WorkspaceFileLinkView } from '@/utils/url/sessionFileDeepLink';
import type { UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { buildWorkspacePreviewIdentity } from '@/components/ui/media/buildWorkspacePreviewIdentity';
import { buildWorkspaceFileReferenceAnchorKey } from '@/utils/workspaceFileReferences/resolveWorkspaceFileReference';
import { extractSelectedDiffLineKeysFromPatch } from '@/scm/scmPatchSelection';
import type { DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces';
import type { DetailsTab, DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import {
    PluginDetailsViewerChoiceChrome,
    createPluginDetailsDestinationTab,
    usePluginDetailsDestinationLaunchStaging,
    type PluginDetailsViewerChoiceModel,
} from '@/components/appShell/panes/details/surfaces/pluginDetailsDestination';
import { createWorkspaceFileOpenableContentBinding, type PluginSurfaceOpenableContentBinding } from '@/components/plugins/surfaces/pluginSurfaceOpenableContent';
import { resolvePluginSurfaceDestinationLabel } from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    createPluginLocalizedTextResolver,
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { useDeviceType } from '@/utils/platform/responsive';
import {
    resolveWorkspaceFileViewerCandidates,
    resolveWorkspaceFileViewerChoiceModel,
    isWorkspaceFileOpenableContentViewerEligible,
    type WorkspaceFileViewerChoice,
    type WorkspaceFileViewerChoiceModel,
    type WorkspaceFileViewerMatch,
} from './workspaceFileDetails/resolveWorkspaceFileViewer';

export type WorkspaceFileDeepLinkAnchor = Readonly<{
    source: ReviewCommentSource;
    anchor: ReviewCommentAnchor;
}>;

/**
 * The details renderer contributes its current scoped host facts; this shared
 * file-details owner remains responsible for selecting and launching an
 * openable-content viewer.
 */
export type WorkspaceFileOpenableContentViewerHost = Readonly<{
    targetKind: 'session' | 'project';
    projection: PluginUiProjectionModel | null | undefined;
    /** The mounted details host's current platform, not an authored viewer capability. */
    platform: LocalServicePreviewPlatform;
    details: DetailsSurfaceRenderInputV1;
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts;
}>;

export type WorkspaceFileDetailsViewProps = Readonly<{
    scopeId: string;
    scope: WorkspaceScopeBase | null;
    filePath: string;
    initialView?: WorkspaceFileLinkView;
    deepLinkAnchor?: WorkspaceFileDeepLinkAnchor | null;
    findSeed?: FileFindSeed | null;
    onFindSeedConsumed?: () => void;
    sessionIdForAugmentation?: string | null;
    presentation?: 'screen' | 'panel';
    /** The host names the repository (the Code page): its root leads the header's breadcrumb. */
    breadcrumbRoot?: string | null;
    /** A breadcrumb folder opens here (the Code page's own listing); otherwise it reveals the folder in Files. */
    onOpenFolder?: (folderPath: string) => void;
    onStartEditingFile?: () => void;
    onRevealInFilesTree?: (path: string) => void;
    onOpenChanges?: () => void;
    openableContentViewer?: WorkspaceFileOpenableContentViewerHost;
}>;

function toBuiltinDetailsTab(tab: DetailsTabState): DetailsTab {
    return {
        key: tab.key,
        kind: tab.kind,
        title: tab.title,
        ...(tab.subtitle === undefined ? {} : { subtitle: tab.subtitle }),
        resource: tab.resource,
    };
}

function detailsTabIntent(tab: DetailsTabState): 'pinned' | 'preview' {
    return tab.isPreview ? 'preview' : 'pinned';
}

function resolveFileStatusLabel(kind: ScmEntryKind): string {
    switch (kind) {
        case 'added': return t('detailsSurface.file.statusAdded');
        case 'deleted': return t('detailsSurface.file.statusDeleted');
        case 'renamed': return t('detailsSurface.file.statusRenamed');
        case 'copied': return t('detailsSurface.file.statusCopied');
        case 'untracked': return t('detailsSurface.file.statusUntracked');
        case 'conflicted': return t('detailsSurface.file.statusConflicted');
        default: return t('detailsSurface.file.statusModified');
    }
}

function countTextLines(text: string): number {
    if (text.length === 0) return 0;
    let lines = 1;
    for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) lines += 1;
    }
    return text.endsWith('\n') ? lines - 1 : lines;
}

function unavailableViewerChoiceId(choice: Extract<WorkspaceFileViewerChoice, { kind: 'unavailable' }>): string {
    return `unavailable:${choice.preference.pluginId}:${choice.preference.contributionLocalId}`;
}

function findWorkspaceFileViewerChoice(
    model: WorkspaceFileViewerChoiceModel,
    candidateId: string,
): WorkspaceFileViewerChoice | null {
    for (const choice of model.choices) {
        if (choice.kind === 'builtin' && candidateId === 'builtin') return choice;
        if (choice.kind === 'plugin' && candidateId === choice.candidate.candidate.entry.id) return choice;
        if (choice.kind === 'unavailable' && candidateId === unavailableViewerChoiceId(choice)) return choice;
    }
    return null;
}

function readWorkspaceFileViewerPreferences(value: unknown) {
    const parsed = WorkspaceFileViewerPreferencesV1Schema.safeParse(value);
    return parsed.success ? parsed.data : DEFAULT_WORKSPACE_FILE_VIEWER_PREFERENCES_V1;
}

function createWorkspaceFileViewerChoiceChromeModel(input: Readonly<{
    model: WorkspaceFileViewerChoiceModel;
    selectedPluginViewerId: string | null;
    canSelect: boolean;
    selectCandidate: (candidateId: string, details: DetailsSurfaceRenderInputV1) => Promise<void>;
    details: DetailsSurfaceRenderInputV1;
    localizePluginText: PluginLocalizedTextResolver;
}>): PluginDetailsViewerChoiceModel {
    return Object.freeze({
        candidates: Object.freeze(input.model.choices.map((choice) => {
            if (choice.kind === 'builtin') {
                const selected = input.selectedPluginViewerId === null;
                return Object.freeze({
                    id: 'builtin',
                    label: t('common.default'),
                    selected,
                    ...(input.canSelect || selected ? {} : { disabled: true }),
                });
            }
            if (choice.kind === 'plugin') {
                const selected = choice.candidate.candidate.entry.id === input.selectedPluginViewerId;
                return Object.freeze({
                    id: choice.candidate.candidate.entry.id,
                    label: resolvePluginSurfaceDestinationLabel(
                        choice.candidate.candidate.placement,
                        input.localizePluginText,
                    ),
                    detail: choice.candidate.identity.pluginId,
                    selected,
                    ...(input.canSelect || selected ? {} : { disabled: true }),
                });
            }
            return Object.freeze({
                id: unavailableViewerChoiceId(choice),
                label: `${choice.preference.pluginId}/${choice.preference.contributionLocalId}`,
                detail: t('common.unavailable'),
                selected: false,
                disabled: true,
            });
        })),
        selectCandidate: async (candidateId) => {
            await input.selectCandidate(candidateId, input.details);
        },
    });
}

function stageWorkspaceFilePluginViewer(input: Readonly<{
    stage: ReturnType<typeof usePluginDetailsDestinationLaunchStaging>;
    host: WorkspaceFileOpenableContentViewerHost;
    binding: PluginSurfaceOpenableContentBinding;
    selected: WorkspaceFileViewerMatch;
    model: WorkspaceFileViewerChoiceModel;
    currentDetails: DetailsSurfaceRenderInputV1;
    originalBuiltinTab: DetailsTab;
    originalBuiltinTabState: DetailsTabState;
    canSelect: boolean;
    selectCandidate: (candidateId: string, details: DetailsSurfaceRenderInputV1) => Promise<void>;
    localizePluginText: PluginLocalizedTextResolver;
    header?: (context: Readonly<{ details: DetailsSurfaceRenderInputV1 }>) => React.ReactNode;
}>): boolean {
    const replaceTab = input.currentDetails.callbacks.replaceTab;
    if (!replaceTab) return false;
    const selectedPluginViewerId = input.selected.candidate.entry.id;
    const receipt = input.stage({
        placement: input.selected.candidate.placement,
        targetKind: input.host.targetKind,
        scopedLaunchFacts: input.host.scopedLaunchFacts,
        input: input.binding.ref,
        binding: Object.freeze({ openableContent: input.binding }),
        viewerChoice: (context) => createWorkspaceFileViewerChoiceChromeModel({
            model: input.model,
            selectedPluginViewerId,
            canSelect: input.canSelect,
            selectCandidate: input.selectCandidate,
            details: context.details,
            localizePluginText: input.localizePluginText,
        }),
        ...(input.header ? { header: input.header } : {}),
        unavailableFallback: (fallback) => {
            fallback.details.callbacks.replaceTab?.(
                fallback.details.tab.key,
                input.originalBuiltinTab,
                { intent: detailsTabIntent(input.originalBuiltinTabState) },
            );
        },
    });
    if (!receipt) return false;
    replaceTab(
        input.currentDetails.tab.key,
        createPluginDetailsDestinationTab({
            destination: receipt.resource.destination,
            ...(receipt.resource.instanceKey === undefined ? {} : { instanceKey: receipt.resource.instanceKey }),
            title: resolvePluginSurfaceDestinationLabel(
                input.selected.candidate.placement,
                input.localizePluginText,
            ),
        }),
        {
            intent: detailsTabIntent(input.originalBuiltinTabState),
            restoreSourceOnRehydrate: true,
        },
    );
    return true;
}

function WorkspaceFileOpenableContentViewerControls(props: Readonly<{
    scope: WorkspaceScopeBase | null;
    filePath: string;
    host: WorkspaceFileOpenableContentViewerHost | undefined;
    /** The built-in editor holds the body (or is about to): the selected plugin viewer waits until it is done. */
    builtinBodyRequired?: boolean;
    /** Ask the built-in tab to open straight into its editor (Edit in the plugin viewer's header). */
    requestEdit?: () => void;
    onRevealInFilesTree?: (path: string) => void;
}>): React.ReactElement | null {
    const settings = useSettingsSelector((settings) => ({
        workspaceFileViewerPreferencesV1: settings.workspaceFileViewerPreferencesV1,
    }));
    const settingsVersion = useSettingsVersion();
    const stage = usePluginDetailsDestinationLaunchStaging();
    const host = props.host;
    const pluginLocale = getPreferredLanguage();
    const localizePluginText = React.useMemo(
        () => createPluginLocalizedTextResolver({
            projection: host?.projection,
            locale: pluginLocale,
        }),
        [host?.projection, pluginLocale],
    );
    const deviceType = useDeviceType();
    const runtimeFormFactor = host
        ? resolvePluginUiRuntimeFormFactor({ deviceType })
        : 'tablet';
    const candidates = React.useMemo(() => (
        host?.projection
            ? resolveWorkspaceFileViewerCandidates({
                projection: host.projection,
                targetKind: host.targetKind,
                platform: host.platform,
                formFactor: runtimeFormFactor,
            })
            : []
    ), [host?.platform, host?.projection, host?.targetKind, runtimeFormFactor]);
    const preferences = React.useMemo(() => (
        readWorkspaceFileViewerPreferences(settings.workspaceFileViewerPreferencesV1)
    ), [settings.workspaceFileViewerPreferencesV1]);
    const hasViewerDemand = candidates.length > 0 || Object.keys(preferences.selections).length > 0;
    const binding = React.useMemo(() => (
        props.scope && host && hasViewerDemand
            ? createWorkspaceFileOpenableContentBinding({ target: props.scope, filePath: props.filePath })
            : null
    ), [hasViewerDemand, host?.targetKind, props.filePath, props.scope]);
    const [stat, setStat] = React.useState<OpenableContentStatResultV1 | null>(null);

    React.useEffect(() => {
        if (!binding) {
            setStat(null);
            return;
        }
        const controller = new AbortController();
        let current = true;
        void binding.stat({ signal: controller.signal }).then((next) => {
            if (current) setStat(next);
        });
        return () => {
            current = false;
            controller.abort();
        };
    }, [binding]);

    const choiceModel = React.useMemo(() => (
        stat?.status === 'ready'
            ? resolveWorkspaceFileViewerChoiceModel({
                metadata: stat,
                preferences,
                availablePluginViewers: candidates,
            })
            : null
    ), [candidates, preferences, stat]);
    const originalBuiltinTabState = host?.details.tab ?? null;
    const originalBuiltinTab = React.useMemo(() => (
        originalBuiltinTabState ? toBuiltinDetailsTab(originalBuiltinTabState) : null
    ), [originalBuiltinTabState]);
    const scope = props.scope;
    const textContent = stat?.status === 'ready' && stat.contentClass === 'text';
    const sizeBytes = stat?.status === 'ready' ? stat.sizeBytes : null;
    const { requestEdit, onRevealInFilesTree, filePath } = props;
    const header = React.useCallback((context: Readonly<{ details: DetailsSurfaceRenderInputV1 }>) => (scope ? (
        <FilePagePluginViewerHeader scope={scope} filePath={filePath} sizeBytes={sizeBytes}
            onRevealInFilesTree={onRevealInFilesTree}
            onEdit={textContent && requestEdit && originalBuiltinTab && originalBuiltinTabState ? () => {
                requestEdit();
                context.details.callbacks.replaceTab?.(context.details.tab.key, originalBuiltinTab,
                    { intent: detailsTabIntent(originalBuiltinTabState) });
            } : undefined} />
    ) : null), [scope, filePath, sizeBytes, textContent, requestEdit, onRevealInFilesTree, originalBuiltinTab, originalBuiltinTabState]);

    const selectCandidate = React.useCallback(async (
        candidateId: string,
        currentDetails: DetailsSurfaceRenderInputV1,
    ) => {
        if (!host || !binding || !stat || stat.status !== 'ready' || !originalBuiltinTab || !originalBuiltinTabState) return;
        const currentSettingsState = storage.getState();
        if (currentSettingsState.settingsVersion === null || currentSettingsState.settingsScope === null) return;
        const currentChoiceModel = resolveWorkspaceFileViewerChoiceModel({
            metadata: stat,
            preferences: readWorkspaceFileViewerPreferences(
                currentSettingsState.settings.workspaceFileViewerPreferencesV1,
            ),
            availablePluginViewers: candidates,
        });
        const choice = findWorkspaceFileViewerChoice(currentChoiceModel, candidateId);
        if (!choice || choice.kind === 'unavailable') return;
        const viewer = choice.kind === 'builtin'
            ? { kind: 'builtin' as const }
            : {
                kind: 'plugin' as const,
                pluginId: choice.candidate.identity.pluginId,
                contributionLocalId: choice.candidate.identity.localId,
            };
        try {
            const result = await getSyncSingleton().mutateAccountSettingsOnce({
                expectedSettingsScope: currentSettingsState.settingsScope,
                expectedSettingsVersion: currentSettingsState.settingsVersion,
                mutate: (raw) => Object.freeze({
                    settings: {
                        ...applyWorkspaceFileViewerPreferenceMutationV1(raw, {
                            kind: 'select',
                            selector: currentChoiceModel.preferenceSelector,
                            viewer,
                        }),
                    },
                    value: undefined,
                }),
            });
            if (result.status !== 'applied') return;
        } catch {
            return;
        }

        if (choice.kind === 'builtin') {
            currentDetails.callbacks.replaceTab?.(
                currentDetails.tab.key,
                originalBuiltinTab,
                { intent: detailsTabIntent(originalBuiltinTabState) },
            );
            return;
        }
        stageWorkspaceFilePluginViewer({
            stage,
            host,
            binding,
            selected: choice.candidate,
            model: currentChoiceModel,
            currentDetails,
            originalBuiltinTab,
            originalBuiltinTabState,
            canSelect: true,
            selectCandidate,
            localizePluginText,
            header,
        });
    }, [
        binding,
        candidates,
        host,
        header,
        localizePluginText,
        originalBuiltinTab,
        originalBuiltinTabState,
        stage,
        stat,
    ]);

    React.useEffect(() => {
        if (
            !host?.details.active
            || props.builtinBodyRequired === true
            || !binding
            || !choiceModel
            || choiceModel.selected.kind !== 'plugin'
            || !originalBuiltinTab
            || !originalBuiltinTabState
        ) {
            return;
        }
        stageWorkspaceFilePluginViewer({
            stage,
            host,
            binding,
            selected: choiceModel.selected.candidate,
            model: choiceModel,
            currentDetails: host.details,
            originalBuiltinTab,
            originalBuiltinTabState,
            canSelect: settingsVersion !== null,
            selectCandidate,
            localizePluginText,
            header,
        });
    }, [
        header,
        binding,
        choiceModel,
        host,
        localizePluginText,
        originalBuiltinTab,
        originalBuiltinTabState,
        props.builtinBodyRequired,
        selectCandidate,
        settingsVersion,
        stage,
    ]);

    if (!host || !choiceModel || choiceModel.selected.kind !== 'builtin') return null;
    const viewerChoice = createWorkspaceFileViewerChoiceChromeModel({
        model: choiceModel,
        selectedPluginViewerId: null,
        canSelect: settingsVersion !== null,
        selectCandidate,
        details: host.details,
        localizePluginText,
    });
    return <PluginDetailsViewerChoiceChrome model={viewerChoice} />;
}

type WorkspaceFileDetailsPersistedDraft = WorkspaceFileEditorDraft;

export function WorkspaceFileDetailsView(props: WorkspaceFileDetailsViewProps) {
    if (!props.scope) {
        return <SurfaceStateCard
            testID="file-details-scope-unavailable"
            kind="unavailable"
            title={t('common.unavailable')}
            reason={t('errors.daemonUnavailableBody')}
        />;
    }
    return <WorkspaceFileDetailsPage {...props} scope={props.scope} />;
}

function WorkspaceFileDetailsPage(props: WorkspaceFileDetailsViewProps & Readonly<{ scope: WorkspaceScopeBase }>) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const mountedRef = useMountedRef();
    const presentation = props.presentation ?? 'screen';
    const checkoutReachability = useCheckoutReachability(props.scope);
    const constrainWidth = presentation === 'screen';
    const pane = useAppPaneScope(props.scopeId);
    const editorAccountScope = useActiveServerAccountScope(props.scope?.serverId ?? null);
    const patchDetailsTabState = pane.patchDetailsTabState;
    const filePath = props.filePath;
    const scope = props.scope;
    const findSurfaceId = `file:${props.scopeId}:${filePath}`;
    const findRuntime = useFindSurfaceRuntime();
    const findFocusRoot = React.useRef<View | null>(null);

    const sessionId = (props.sessionIdForAugmentation ?? '').trim();
    const sessionAddress = normalizeSessionAddress(scope?.serverId, sessionId);
    const ownerMetadata = useSessionListPreferredMetadata(sessionAddress ?? sessionId);
    const project = useProjectForSession(sessionId, scope?.serverId);
    const sessionPath = resolveSessionWorkspacePath({
        sessionPath: typeof ownerMetadata?.path === 'string' ? ownerMetadata.path : null,
        projectPath: project?.key?.rootPath ?? (scope?.rootPath ?? null),
    });
    const [copyContentBusy, setCopyContentBusy] = React.useState(false);

    const tabKey = React.useMemo(() => `file:${filePath}`, [filePath]);
    const { view: fileView, patchView: patchFileView } = useWorkspaceFileView(pane, tabKey);
    const isActive = props.openableContentViewer?.details.active ?? (presentation === 'screen' || (pane.scopeState?.details?.isOpen === true && pane.scopeState.details.activeTabKey === tabKey));
    const persistedDraft = readWorkspaceFileEditorDraft(pane.scopeState?.details?.tabState?.[tabKey], editorAccountScope?.accountId ?? null);
    const persistDraft = React.useCallback((draft: WorkspaceFileDetailsPersistedDraft | null) => {
        patchDetailsTabState(tabKey, draft ?? {
            accountId: null, isEditingFile: false, editorOriginalText: undefined,
            editorOriginalHash: undefined, editorText: undefined,
        });
    }, [patchDetailsTabState, tabKey]);

    const deepLinkAnchor = props.deepLinkAnchor ?? null;
    const deepLinkKey = React.useMemo(() => {
        if (!deepLinkAnchor) return '';
        return buildWorkspaceFileReferenceAnchorKey({
            filePath,
            source: deepLinkAnchor.source,
            anchor: deepLinkAnchor.anchor,
        });
    }, [deepLinkAnchor, filePath]);

    const scmCommitStrategy = useSetting('scmCommitStrategy');
    const scmDefaultDiffModeByBackend = useSetting('scmDefaultDiffModeByBackend');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments');
    const fileEditorFeatureEnabled = useFeatureEnabled('files.editor');
    const showLineNumbers = useSetting('showLineNumbers');
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    const filesEditorAutoSave = useSetting('filesEditorAutoSave');
    const filesEditorChangeDebounceMs = useSetting('filesEditorChangeDebounceMs');
    const filesEditorBridgeMaxChunkBytes = useSetting('filesEditorBridgeMaxChunkBytes');
    const filesEditorWebMonacoEnabled = useSetting('filesEditorWebMonacoEnabled');
    const filesEditorNativeCodeMirrorEnabled = useSetting('filesEditorNativeCodeMirrorEnabled');
    const filesImagePreviewMaxBytes = useSetting('filesImagePreviewMaxBytes');

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const scmSnapshot = useWorkspaceScmSnapshot(scope);
    const commitSelectionPaths = useWorkspaceScmCommitSelectionPaths(scope);
    const commitSelectionPatches = useWorkspaceScmCommitSelectionPatches(scope);
    const inFlightScmOperation = useWorkspaceScmInFlightOperation(scope);
    const fileEntry = React.useMemo(
        () => scmSnapshot?.entries.find((entry) => entry.path === filePath) ?? null,
        [filePath, scmSnapshot]
    );
    const hasConflicts = scmSnapshot?.hasConflicts === true;
    const snapshotSignature = React.useMemo(() => scmSnapshot ? buildScmDiffSnapshotSignature(scmSnapshot) : null, [scmSnapshot]);

    const [displayMode, setDisplayMode] = React.useState<FileDisplayMode>(() => (
        persistedDraft?.isEditingFile ? 'file' : fileView.mode ?? (deepLinkAnchor?.source === 'file' ? 'file'
            : fileEntry ? 'diff' : resolveFileViewerKind({ path: filePath }).kind === 'markdown' ? 'markdown' : 'file')
    ));
    const requestedDisplayMode = fileView.mode ?? null;
    const onDisplayMode = React.useCallback((mode: FileDisplayMode) => {
        patchFileView({ mode });
        setDisplayMode(mode);
    }, [patchFileView]);
    const [diffMode, setDiffMode] = useFileDetailsDiffMode({
        fileKey: `${scope?.serverId}:${scope?.machineId}:${scope?.rootPath}:${filePath}`,
        snapshot: scmSnapshot,
        backendOverrides: scmDefaultDiffModeByBackend as Record<string, ScmDiffArea> | undefined,
        hasIncludedDelta: fileEntry?.hasIncludedDelta === true,
        hasPendingDelta: fileEntry?.hasPendingDelta === true,
    });
    const [selectedLineKeys, setSelectedLineKeys] = React.useState<Set<string>>(new Set());
    const [commitSelectionModeActive, setCommitSelectionModeActive] = React.useState(false);
    const [rangeSelectionActive, setRangeSelectionActive] = React.useState(false);
    const [reviewCommentModeActive, setReviewCommentModeActive] = React.useState(false);
    const [jumpToAnchor, setJumpToAnchor] = React.useState<ReviewCommentAnchor | null>(deepLinkAnchor?.anchor ?? null);

    const hasIncludedDelta = fileEntry?.hasIncludedDelta === true;
    const hasPendingDelta = fileEntry?.hasPendingDelta === true;
    const includeExcludeEnabled = allowsLiveStaging({
        strategy: scmCommitStrategy,
        snapshot: scmSnapshot,
    });
    const virtualSelectionEnabled = isAtomicCommitStrategy(scmCommitStrategy)
        && scmSnapshot?.capabilities?.writeCommitPathSelection === true;
    const virtualLineSelectionEnabled = isAtomicCommitStrategy(scmCommitStrategy)
        && scmSnapshot?.capabilities?.writeCommitLineSelection === true;
    const isSelectedForCommit = commitSelectionPaths.includes(filePath)
        || commitSelectionPatches.some((p) => p.path === filePath);
    const appliedSelectedLineKeys = React.useMemo(() => {
        const keys = new Set<string>();
        for (const patchSelection of commitSelectionPatches) {
            if (patchSelection.path !== filePath) continue;
            for (const key of extractSelectedDiffLineKeysFromPatch(patchSelection.patch)) {
                keys.add(key);
            }
        }
        return keys;
    }, [commitSelectionPatches, filePath]);
    const lineSelectionFingerprint = React.useMemo(
        () => buildFileLineSelectionFingerprint(fileEntry),
        [fileEntry]
    );
    const { fileContent, diffContent, setDiffContent, isLoading, isDiffLoading, error, fileWriteSupported, setFileWriteSupported, staleSince, lastOwnWriteHash, tooLarge, refreshAll, publishSavedFile } = useWorkspaceFileDetailsLoading({
        scope, filePath, diffMode,
        fileEntryKind: fileEntry?.kind ?? null,
        isBinaryContent: fileEntry?.stats.isBinary,
        fileHasIncludedDelta: fileEntry?.hasIncludedDelta,
        previewSlice: fileView.previewSlice,
        maxImagePreviewBytes: typeof filesImagePreviewMaxBytes === 'number' ? filesImagePreviewMaxBytes : null,
        includeDiff: displayMode === 'diff' && (scmSnapshot == null || fileEntry != null),
        includeFile: displayMode !== 'diff',
        snapshotSignature,
        isActive,
        refreshFingerprint: `${lineSelectionFingerprint ?? 'none'}:${scmSnapshot?.fetchedAt ?? 'none'}`,
    });
    const recentActivation = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!isActive) { recentActivation.current = null; return; }
        if (!scope || isLoading || isDiffLoading || error || (!fileContent && diffContent === null)) return;
        const workspaceKey = tryBuildWorkspaceCacheKey(scope);
        if (!workspaceKey) return;
        const activation = `${workspaceKey}\u0000${filePath}`;
        if (recentActivation.current === activation) return;
        recentActivation.current = activation;
        const state = storage.getState();
        const previous = state.localSettings.recentWorkspaceFilesV1;
        const next = recordRecentWorkspaceFile(previous, workspaceKey, filePath);
        if (next !== previous) state.applyLocalSettings({ recentWorkspaceFilesV1: next });
    }, [diffContent, error, fileContent, filePath, isActive, isDiffLoading, isLoading, scope]);
    const copyFileContent = React.useCallback(async () => {
        if (!fileContent || fileContent.isBinary || copyContentBusy) return;
        setCopyContentBusy(true);
        try {
            const copied = await setClipboardStringSafe(fileContent.content);
            if (!copied && mountedRef.current) Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
        } finally {
            if (mountedRef.current) setCopyContentBusy(false);
        }
    }, [copyContentBusy, fileContent, mountedRef]);
    const lineSelectionEnabled = !fileContent?.partial && canUseLineSelection({
        scmWriteEnabled,
        includeExcludeEnabled,
        virtualLineSelectionEnabled,
        hasConflicts,
        isBinary: fileEntry?.stats.isBinary === true,
        diffMode,
        diffContent,
    });
    const lineSelectionCanStart = !fileContent?.partial && canStartLineSelection({
        scmWriteEnabled,
        includeExcludeEnabled,
        virtualLineSelectionEnabled,
        hasConflicts,
        isBinary: fileEntry?.stats.isBinary === true,
        hasPendingDelta,
        hasIncludedDelta,
        diffContent,
    });
    const effectiveLineSelectionEnabled = lineSelectionEnabled && commitSelectionModeActive;
    const displayedSelectedLineKeys = commitSelectionModeActive ? selectedLineKeys : appliedSelectedLineKeys;

    const selectionResetKey = React.useMemo(
        () => [
            diffMode,
            diffContent ?? '',
            lineSelectionFingerprint ?? '',
        ].join('\n'),
        [diffContent, diffMode, lineSelectionFingerprint],
    );
    const previousSelectionResetRef = React.useRef<{
        key: string;
        diffContent: string | null;
    } | null>(null);
    React.useEffect(() => {
        const previous = previousSelectionResetRef.current;
        if (previous === null) {
            previousSelectionResetRef.current = { key: selectionResetKey, diffContent };
            return;
        }
        if (previous.key === selectionResetKey) return;
        previousSelectionResetRef.current = { key: selectionResetKey, diffContent };
        if (previous.diffContent === null && diffContent !== null) {
            return;
        }
        setSelectedLineKeys(new Set());
        setCommitSelectionModeActive(false);
        setRangeSelectionActive(false);
        setReviewCommentModeActive(false);
    }, [diffContent, selectionResetKey]);

    React.useEffect(() => {
        if (!lineSelectionCanStart) {
            setSelectedLineKeys(new Set());
            setCommitSelectionModeActive(false);
            setRangeSelectionActive(false);
            setReviewCommentModeActive(false);
        }
    }, [lineSelectionCanStart]);

    const language = getFileLanguageFromPath(filePath);
    const fileViewer = resolveFileViewerKind({ path: filePath, mimeType: fileContent?.binaryMime, isBinaryContent: fileEntry?.stats.isBinary });
    const markdownPreviewAvailable = fileContent?.isBinary !== true
        && fileViewer.kind === 'markdown'
        && typeof fileContent?.content === 'string';
    const hasRenderableDiff = React.useMemo(
        () => resolveFileDetailsRenderableDiff({ diffContent }),
        [diffContent],
    );

    React.useEffect(() => {
        if (!deepLinkAnchor) {
            setJumpToAnchor(null);
            return;
        }

        setJumpToAnchor(deepLinkAnchor.anchor);

        const timer = setTimeout(() => {
            setJumpToAnchor(null);
        }, 8000);

        return () => clearTimeout(timer);
    }, [deepLinkKey]);

    const sessionStageActions = useFileScmStageActions({
        sessionId,
        serverId: sessionAddress?.serverId,
        sessionPath,
        filePath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        diffMode,
        diffContent,
        lineSelectionEnabled: effectiveLineSelectionEnabled,
        includeExcludeEnabled,
        selectedLineKeys,
        refreshAll,
        setSelectedLineKeys,
    });

    const workspaceStageActions = useWorkspaceFileScmStageActions({
        scope,
        filePath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        diffMode,
        diffContent,
        lineSelectionEnabled: effectiveLineSelectionEnabled,
        includeExcludeEnabled,
        selectedLineKeys,
        refreshAll,
        setSelectedLineKeys,
    });

    const { isApplyingStage, handleStage, applySelectedLines } = sessionId ? sessionStageActions : workspaceStageActions;
    const applySelectedLinesRef = React.useRef(applySelectedLines);
    applySelectedLinesRef.current = applySelectedLines;

    const toggleSelectedLine = React.useCallback((key: string) => {
        if (!effectiveLineSelectionEnabled) return;
        setRangeSelectionActive(false);
        setSelectedLineKeys((previous) => {
            const next = new Set(previous);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }, [effectiveLineSelectionEnabled]);

    const fileName = filePath.split('/').pop() || filePath;
    const filePathDir = filePath.split('/').slice(0, -1).join('/');
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(filePath);
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(scope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(scope);

    // The writing agent's name for the editor's conflict and Undo copy; "the version on disk" when unknown.
    const editorAttribution = useFilePageAttribution({ address: sessionAddress, filePath, workspaceRoot: scope?.rootPath ?? null, active: isActive });
    const approval = useActionApprovalContinuation({
        scopeKey: JSON.stringify([scope?.serverId, editorAccountScope?.accountId, props.scopeId, filePath]),
        serverId: scope?.serverId ?? '', onExecuted: refreshAll,
    });
    const editorState = useWorkspaceFileEditorState({
        scope: scope ?? { serverId: 'unknown', machineId: 'unknown', rootPath: '/' },
        accountId: editorAccountScope?.accountId ?? null, filePath, displayMode,
        fileText: fileContent?.isBinary || fileContent?.partial ? null : (fileContent?.content ?? null),
        fileHash: fileContent?.isBinary || fileContent?.partial ? null : (fileContent?.contentHash ?? null),
        encoding: fileContent?.encoding, unreachable: checkoutReachability.unreachable,
        fileWriteSupported, setFileWriteSupported,
        fileEditorFeatureEnabled: fileEditorFeatureEnabled === true && !fileContent?.partial,
        filesEditorWebMonacoEnabled: filesEditorWebMonacoEnabled === true,
        filesEditorNativeCodeMirrorEnabled: filesEditorNativeCodeMirrorEnabled === true,
        filesEditorAutoSave: filesEditorAutoSave === true,
        filesEditorChangeDebounceMs: typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : 0,
        mountedRef, refreshAll, publishSavedFile, persistedDraft: persistedDraft ?? null, persistDraft,
        panePersistenceFailed: pane.persistenceFailed, agentName: editorAttribution.agentName,
        requestApproval: approval.requestApproval,
    });
    const approvalRouter = useRouter();
    const editorApprovalId = approval.approvalPending ? approval.approvalId : null;
    const openEditorApproval = React.useMemo(() => editorApprovalId && scope
        ? () => approvalRouter.pushRetainingCurrent(buildApprovalHref(editorApprovalId, scope.serverId)) : null,
    [approvalRouter, editorApprovalId, scope]);
    const { editorSurfaceEnabled, isEditingFile, editorResetKey, editorSeedText, editorHandleRef,
        onEditorChange, editorDirty, saveFileEdits, cancelEditingFile, startEditingFile,
        liveValue, initialLine, onEditorReady } = editorState;
    // Ask reads the mounted editor's selection; the handle exists once the engine reports ready.
    const [readyEditorHandle, setReadyEditorHandle] = React.useState<typeof editorHandleRef.current>(null);
    const bindCodeIntelligenceEditor = React.useRef<() => void>(() => undefined);
    const onCodeEditorReady = React.useCallback(() => {
        onEditorReady();
        setReadyEditorHandle(editorHandleRef.current);
        bindCodeIntelligenceEditor.current();
    }, [editorHandleRef, onEditorReady]);
    const codeGeometryText = fileContent?.isBinary ? editorSeedText : fileContent?.content ?? editorSeedText;
    const codeGeometry = React.useMemo(() => resolveFileCodeGeometry({ text: codeGeometryText, reviewCommentsEnabled, reviewCommentModeActive }), [codeGeometryText, reviewCommentsEnabled, reviewCommentModeActive]);
    // The tab strip shows this tab's unsaved dot; the editor state is the only owner of that fact.
    const detailsTabChrome = useDetailsTabChrome();
    React.useEffect(() => {
        detailsTabChrome.setUnsaved(editorDirty);
    }, [detailsTabChrome, editorDirty]);
    React.useEffect(() => () => detailsTabChrome.setUnsaved(false), [detailsTabChrome]);
    const openableContentViewerEligible = isWorkspaceFileOpenableContentViewerEligible({
        isEditingFile,
        hasPersistedEditingDraft: persistedDraft?.isEditingFile === true,
    });

    const isMarkdownFile = fileViewer.kind === 'markdown';

    React.useEffect(() => {
        setDisplayMode(resolveFileDetailsDisplayMode({
            requestedMode: requestedDisplayMode,
            persistedEditing: isEditingFile || persistedDraft?.isEditingFile === true,
            deepLinkSource: deepLinkAnchor?.source ?? null,
            hasRenderableDiff,
            hasFileContent: Boolean(fileContent),
            markdownPreviewAvailable,
            knownChanged: fileEntry !== null,
            previewKind: fileViewer.kind === 'markdown',
        }));
    }, [requestedDisplayMode, deepLinkAnchor?.source, fileContent, hasRenderableDiff, isEditingFile, markdownPreviewAvailable, persistedDraft?.isEditingFile, fileEntry, fileViewer.kind]);

    const handleStartEditingFile = React.useCallback((at?: { line: number }) => {
        onDisplayMode('file'); props.onStartEditingFile?.(); startEditingFile(at);
    }, [onDisplayMode, props.onStartEditingFile, startEditingFile]);
    // Edit from a plugin viewer's header lands here with a one-shot request: open the built-in editor once the
    // text is held (the request is cleared first, so a reload never re-enters editing by itself).
    const requestEditFromViewer = React.useCallback(() => patchFileView({ startEditing: true }), [patchFileView]);
    const editRequested = fileView.startEditing === true;
    React.useEffect(() => {
        if (!editRequested || !fileContent || fileContent.isBinary) return;
        patchFileView({ startEditing: undefined });
        if (!isEditingFile) handleStartEditingFile();
    }, [editRequested, fileContent, isEditingFile, handleStartEditingFile, patchFileView]);
    const focusedGroup = pane.scopeState?.details?.groups?.find(group => group.id === pane.scopeState?.details?.focusedGroupId);
    const editorHeader = useWorkspaceFileEditorCommands({
        editor: editorState, tabKey, onStart: handleStartEditingFile,
        serverId: scope?.serverId ?? null, accountId: editorAccountScope?.accountId ?? null,
        focused: isActive && (presentation === 'screen' || focusedGroup?.activeTabKey === tabKey),
    });

    // Gutter marks come from the same diff the Changes body shows, seeded once per saved version and scope;
    // the engine then carries them through the person's edits (P4-R9).
    const changeMarkerSeedKey = JSON.stringify([fileContent?.contentHash ?? null, diffMode, editorResetKey]);
    const changeMarkerDiff = isEditingFile && typeof diffContent === 'string' && diffContent.length > 0 ? diffContent : null;
    const changeMarkerDiffRef = React.useRef(changeMarkerDiff);
    changeMarkerDiffRef.current = changeMarkerDiff;
    // Seeded per saved version: a refreshed diff for the same version does not move marks under the caret.
    const changeMarkers = React.useMemo(() => changeMarkerDiffRef.current
        ? { key: changeMarkerSeedKey, items: buildEditorChangeMarkers(filePath, null, changeMarkerDiffRef.current) } : undefined,
    [changeMarkerSeedKey, changeMarkerDiff !== null, filePath]);
    const surfaceSize = useSurfaceStateSize();
    const editorAccessory = React.useMemo(() => (Platform.OS !== 'web' || surfaceSize === 'phone') ? {
        save: {
            visible: editorHeader.status !== 'conflict',
            enabled: editorHeader.status === 'dirty' || editorHeader.status === 'saving',
            busy: editorHeader.status === 'saving',
            tone: editorHeader.refusal ? 'default' as const : 'primary' as const,
            onPress: editorHeader.onSave,
        },
    } : null, [editorHeader.status, editorHeader.refusal, editorHeader.onSave, surfaceSize]);
    const editorPeek = React.useMemo(() => ({ dirty: editorDirty, attribution: editorAttribution.agentName }), [editorDirty, editorAttribution.agentName]);
    // Changes is offered from the moment the tree / SCM knows the file changed (its diff may still be on the way,
    // so the segment never appears late), and for changed images whose Changes is the visual compare (P5 U8).
    const changesOffered = hasRenderableDiff || (fileEntry !== null
        && (diffContent === null || fileViewer.kind === 'image' || fileViewer.kind === 'svg'));
    const headerModel = resolveFilePageHeaderModel({
        kind: fileViewer.kind,
        hasRenderableDiff: changesOffered, deleted: fileEntry?.kind === 'deleted',
        partial: Boolean(fileContent?.partial),
        hasText: (fileContent?.isBinary === false && typeof fileContent.content === 'string') || persistedDraft?.isEditingFile === true,
        writeSupported: fileWriteSupported || persistedDraft?.isEditingFile === true,
        editorAvailable: editorSurfaceEnabled,
    });
    const fileViewActionOwner = React.useRef<FileViewActionOwner | null>(null);
    fileViewActionOwner.current = {
        tabId: tabKey, active: isActive, serverId: scope?.serverId ?? null,
        accountId: editorAccountScope?.accountId ?? null,
        mode: isEditingFile ? 'edit' : headerModel.modes.find(option => option.displayMode === displayMode)?.id ?? 'view',
        changesScope: fileView.changesScope, blame: fileView.blame ?? false,
        availableModes: [...headerModel.modes.map(option => option.id), ...(headerModel.editUnavailableReason === null ? ['edit' as const] : [])],
        blameAvailable: scmSnapshot?.capabilities?.readBlame === true,
        changesScopeAvailable: scope !== null,
        set: patch => {
            if (patch.mode === 'edit') handleStartEditingFile();
            else if (patch.mode) {
                const option = headerModel.modes.find(option => option.id === patch.mode);
                if (!option) return false;
                onDisplayMode(option.displayMode);
            }
            const { mode: _mode, ...viewPatch } = patch;
            if (Object.keys(viewPatch).length > 0) patchFileView(viewPatch);
            return true;
        },
    };
    React.useEffect(() => registerFileViewActionOwner(JSON.stringify([props.scopeId, tabKey]), () => fileViewActionOwner.current!), [props.scopeId, tabKey]);

    // Navigation and the public view Action apply through the same mounted page owner.
    const initialViewKey = JSON.stringify([filePath, props.initialView?.view, props.initialView?.blame, props.deepLinkAnchor]);
    const appliedInitialView = React.useRef({ key: initialViewKey, view: false, blame: false });
    React.useEffect(() => {
        if (!isActive || (!fileContent && !hasRenderableDiff && persistedDraft?.isEditingFile !== true)) return;
        const requested = props.initialView;
        const owner = fileViewActionOwner.current;
        if (appliedInitialView.current.key !== initialViewKey) appliedInitialView.current = { key: initialViewKey, view: false, blame: false };
        if (!owner || (!requested?.view && requested?.blame === undefined)) return;
        // References name file coordinates; Markdown/SVG therefore open their Source mode.
        const mode = requested.view === 'view' && !owner.availableModes.includes('view')
            ? headerModel.modes.find(option => option.displayMode === 'file')?.id ?? headerModel.modes[0]?.id : requested.view;
        if (!appliedInitialView.current.view && mode && owner.availableModes.includes(mode)) {
            appliedInitialView.current.view = owner.mode === mode || owner.set({ mode });
        }
        if (!appliedInitialView.current.blame && requested.blame !== undefined && (owner.blameAvailable || requested.blame === false)) {
            appliedInitialView.current.blame = owner.blame === requested.blame || owner.set({ blame: requested.blame });
        }
    }, [initialViewKey, isActive, fileContent, hasRenderableDiff, persistedDraft?.isEditingFile,
        headerModel.editUnavailableReason, scmSnapshot?.capabilities?.readBlame]);

    const onStageFile = React.useCallback(() => {
        void handleStage(true);
    }, [handleStage]);

    const onUnstageFile = React.useCallback(() => {
        void handleStage(false);
    }, [handleStage]);

    const onApplySelectedLines = React.useCallback(async () => {
        setRangeSelectionActive(false);
        const applied = await applySelectedLinesRef.current();
        if (applied === true) {
            setCommitSelectionModeActive(false);
        }
    }, []);

    const onClearSelection = React.useCallback(() => {
        setSelectedLineKeys(new Set());
        setCommitSelectionModeActive(false);
        setRangeSelectionActive(false);
    }, []);

    const onStartLineSelection = React.useCallback(() => {
        if (!lineSelectionCanStart) return;
        setReviewCommentModeActive(false);
        setDisplayMode('diff');
        if (!lineSelectionEnabled) {
            setDiffContent(null);
            setDiffMode(hasPendingDelta ? 'pending' : 'included');
        }
        setSelectedLineKeys(new Set(appliedSelectedLineKeys));
        setCommitSelectionModeActive(true);
        setRangeSelectionActive(false);
    }, [appliedSelectedLineKeys, hasPendingDelta, lineSelectionCanStart, lineSelectionEnabled]);

    const onStartRangeSelection = React.useCallback(() => {
        if (!lineSelectionEnabled || !commitSelectionModeActive) return;
        setRangeSelectionActive(true);
    }, [commitSelectionModeActive, lineSelectionEnabled]);

    const onToggleReviewCommentMode = React.useCallback((active: boolean) => {
        setReviewCommentModeActive(active);
        if (!active) return;
        setCommitSelectionModeActive(false);
        setRangeSelectionActive(false);
        setSelectedLineKeys(new Set());
    }, []);
    // The selection toolbar's Comment: comment mode on, the inline composer on the selected lines.
    const [commentRangeRequest, setCommentRangeRequest] = React.useState<Readonly<{ startLine: number; endLine: number; key: number }> | null>(null);
    const onCommentSelectedRange = React.useCallback((range: Readonly<{ startLine: number; endLine: number }>) => {
        onToggleReviewCommentMode(true);
        setCommentRangeRequest((previous) => ({ startLine: range.startLine, endLine: range.endLine, key: (previous?.key ?? 0) + 1 }));
    }, [onToggleReviewCommentMode]);

    const onRefresh = React.useCallback(() => {
        void refreshAll();
    }, [refreshAll]);

    const fileStatusForHeaderActions = React.useMemo<ScmFileStatus | null>(() => {
        if (!fileEntry) return null;
        const segments = fileEntry.path.split('/');
        const statusFileName = segments[segments.length - 1] || fileEntry.path;
        const statusFilePath = segments.slice(0, -1).join('/');
        const useIncludedStats = fileEntry.hasIncludedDelta && !fileEntry.hasPendingDelta;
        return {
            fileName: statusFileName,
            filePath: statusFilePath,
            fullPath: fileEntry.path,
            status: fileEntry.kind,
            isIncluded: useIncludedStats,
            hasIncludedDelta: fileEntry.hasIncludedDelta,
            linesAdded: useIncludedStats ? fileEntry.stats.includedAdded : fileEntry.stats.pendingAdded,
            linesRemoved: useIncludedStats ? fileEntry.stats.includedRemoved : fileEntry.stats.pendingRemoved,
            oldPath: fileEntry.previousPath ?? undefined,
            isBinary: fileEntry.stats.isBinary,
            isComplete: fileEntry.stats.isComplete,
        };
    }, [fileEntry]);

    // The agent's write landing while you read (P3-R8, FV1m): the content updates in place, its new lines
    // tint once, and the attribution reads "Updated by {agent} just now".
    const reducedMotion = useReducedMotionPreference();
    const liveMoment = useWorkspaceFileLiveMoment({
        resourceKey: JSON.stringify([scope?.serverId, scope?.machineId, scope?.rootPath, filePath]),
        content: fileContent,
        isActive,
        isEditing: isEditingFile,
        hasDraft: persistedDraft?.isEditingFile === true,
        ownWriteHash: lastOwnWriteHash,
        reducedMotion,
    });
    const [liveMomentAt, setLiveMomentAt] = React.useState<number | null>(null);
    React.useEffect(() => { if (liveMoment) setLiveMomentAt(Date.now()); }, [liveMoment]);
    const attributionUpdatedAt = Math.max(editorAttribution.updatedAt ?? 0, liveMomentAt ?? 0) || null;

    const readBodyRef = React.useRef<View | null>(null);
    // ── The page's chrome: one header, one `⋯` list, one share owner (P3 §3.2, §3.3) ──
    const phonePage = surfaceSize === 'phone';
    const safeAreaInsets = useSafeAreaInsets();
    const machineReachable = !checkoutReachability.unreachable;
    const unavailableReason = t('projects.checkouts.notAnswering', { machine: checkoutReachability.machineName });
    const heldText = fileContent && !fileContent.isBinary && !fileContent.partial ? fileContent.content : null;
    const cachedContent = React.useMemo(() => {
        if (machineReachable || !fileContent) return null;
        const bytes = reconstructWorkspaceFileTextBytes({ text: fileContent.content,
            complete: !fileContent.isBinary && !fileContent.partial, encoding: fileContent.encoding });
        return bytes ? { bytes, fileName, mimeType: fileContent.binaryMime ?? fileViewer.mimeType ?? 'text/plain' } : null;
    }, [fileContent, fileName, fileViewer.mimeType, machineReachable]);
    const share = useWorkspaceFileShareActions({
        workspaceScope: scope,
        path: filePath,
        actionScope: editorAccountScope,
        linkInput: sessionId ? { target: { kind: 'session', sessionId, ...(scope?.serverId ? { serverId: scope.serverId } : {}) }, path: filePath } : undefined,
        machineReachable,
        unavailableReason,
        cachedContent,
        onSaveAsArtifact: editorAccountScope && scope ? () => {
            Modal.show({
                component: SaveFileAsArtifactDialog,
                props: {
                    source: {
                        scope: editorAccountScope,
                        sourceSessionId: sessionId || null,
                        // A project page has no Session: the workspace itself is the source (amendment A2).
                        sourceWorkspace: sessionId ? null : { machineId: scope.machineId, rootPath: scope.rootPath },
                        filePath,
                    },
                    sourceFacts: [filePathDir.split('/').filter(Boolean).join(' › '),
                        typeof fileContent?.binarySizeBytes === 'number' ? formatFilePageBytes(fileContent.binarySizeBytes) : null,
                        checkoutReachability.machineName ? t('files.pane.page.fromMachine', { machine: checkoutReachability.machineName }) : null,
                    ].filter(Boolean).join(' · '),
                },
            });
        } : undefined,
    });
    const effectiveWrapLines = fileView.wrap ?? wrapLinesInDiffs;
    const isBinaryContent = fileContent?.isBinary === true;
    const onChangesScopeChange = React.useCallback((changesScope: FileChangesScope) => patchFileView({ changesScope }), [patchFileView]);
    // P5's Changes owner, once per page: the Changes body draws it, and its comparison arm is the only
    // whole-file Discard / Restore (View, Changes and the deleted tab alike; no HEAD-arm fallback, RV-B M8).
    const changesReview = useFileChangesReview({
        scope, sessionId: sessionId || null, filePath,
        liveDiff: diffContent, refreshLiveDiff: onRefresh, view: fileView, onChangesScopeChange,
        active: isActive && (displayMode === 'diff' || Boolean(fileEntry)),
        agentName: editorAttribution.agentName,
        hasUnsavedEdits: () => editorDirty,
        onReplacedUnsavedEdits: cancelEditingFile,
    });
    // P7: one controller per File page; regions handed to this page (header fact, note, card, ⋯ commands).
    const codeIntelligence = useFilePageCodeIntelligence({
        scopeId: props.scopeId, scope, filePath, language,
        enabled: fileViewer.kind === 'code' && !fileContent?.isBinary && !fileContent?.partial && fileEntry?.kind !== 'deleted' && Boolean(fileContent),
        active: isActive, liveValue, getUnsaved: () => editorState.readSnapshot().dirty, editorHandleRef,
        sessionId: sessionId || null, accountId: editorAccountScope?.accountId ?? null,
        machineName: checkoutReachability.machineName, machineUnreachable: checkoutReachability.unreachable,
        agentName: editorAttribution.agentName, saveFileEdits,
        readSavedText: () => ({ savedText: fileContent?.isBinary ? '' : fileContent?.content ?? '', unsaved: editorState.readSnapshot().dirty }),
    });
    bindCodeIntelligenceEditor.current = codeIntelligence.bindEditor;
    const menuContext: FileMenuContext = {
        machineReachable,
        unavailableReason,
        hasCachedContent: cachedContent !== null,
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : desktopHostKind() === 'tauri' ? 'tauri' : 'web',
        partial: Boolean(fileContent?.partial),
        blame: fileView.blame === true,
        readBlame: scmSnapshot?.capabilities?.readBlame === true,
        toggleWrap: !isBinaryContent && displayMode !== 'markdown' ? () => patchFileView({ wrap: !effectiveWrapLines }) : undefined,
        copyContents: heldText !== null ? () => { void copyFileContent(); } : undefined,
        selectLines: scmWriteEnabled && (includeExcludeEnabled || virtualSelectionEnabled) && (lineSelectionCanStart || lineSelectionEnabled) && !commitSelectionModeActive
            ? () => onStartLineSelection() : undefined,
        revealInFiles: props.onRevealInFilesTree ? () => props.onRevealInFilesTree?.(filePath) : undefined,
        openChanges: props.onOpenChanges,
        discardEdits: isEditingFile && editorDirty ? cancelEditingFile : undefined,
        toggleBlame: scmSnapshot?.capabilities?.readBlame === true ? () => patchFileView({ blame: !(fileView.blame === true) }) : undefined,
        changes: fileEntry?.kind === 'deleted' ? undefined : changesReview.menuChanges,
        copyPath: share.copyPath ? () => share.copyPath?.() : undefined,
        copyLink: share.copyLink,
        attachToMessage: share.attachToMessage,
        saveAsArtifact: share.saveAsArtifact,
        download: fileEntry?.kind !== 'deleted' ? () => share.download() : undefined,
        shareFile: share.shareFile,
        openInDefaultApp: share.openInDefaultApp,
        commands: codeIntelligence.menuCommands,
    };
    const menuActions = resolveFileMenuItems(menuContext, phonePage ? 'phone' : 'page').map((item) => ({
        id: item.id,
        title: item.title ?? t(item.titleKey),
        testID: `file-menu-${item.id}`,
        category: item.group,
        ...(item.destructive ? { destructive: true } : {}),
        ...(item.id === 'wrap' ? { checked: effectiveWrapLines } : {}),
        ...(typeof item.state === 'object' ? { disabled: true, subtitle: item.state.disabledReason } : {}),
        ...(item.id === 'download' && share.busy ? { loading: true } : {}),
        onSelect: () => item.run(),
    }));
    const pageEditControl = resolveFilePageEditControl({
        fileEditorEnabled: editorSurfaceEnabled && !isBinaryContent && fileEntry?.kind !== 'deleted' && headerModel.editUnavailableReason === null,
        isEditingFile: isEditingFile && displayMode === 'file',
        editor: editorHeader,
        onStart: () => handleStartEditingFile(),
        onSave: saveFileEdits,
        onCancel: cancelEditingFile,
        machineUnreachable: checkoutReachability.unreachable,
        keyRowCarriesSave: editorAccessory !== null,
    });
    // The phone's bottom toolbar steps aside while something else holds the bottom edge: the editor's key row
    // (ED1p) or the review bar in Changes (rvp P1). The header then carries the view choice and Done itself.
    const phoneToolbar = phonePage && !(isEditingFile && displayMode === 'file')
        && !(displayMode === 'diff' && changesReview.controller.strip.total > 0);
    const pageFind = (displayMode === 'diff' ? typeof diffContent === 'string' : typeof fileContent?.content === 'string' && !isBinaryContent)
        && headerModel.findAvailable !== false ? { onOpen: () => findRuntime.open(findSurfaceId) } : null;

    const previewTooLarge = error === t('files.fileTooLargeToPreview');
    const fatalError = Boolean(error) && !previewTooLarge && !diffContent && !fileContent;

    // One preview identity for the body and the Media stage it opens (P2 §3.3): the stage reuses these bytes.
    const viewerPreviewIdentity = scope ? buildWorkspacePreviewIdentity(scope, filePath, fileContent?.binarySizeBytes,
        JSON.stringify([snapshotSignature ?? lineSelectionFingerprint ?? null, fileContent?.binaryPreviewRevision ?? null])) : null;
    const viewerPreviewInput = React.useMemo<UseFilePreviewSourceInput>(() => ({
        source: scope ? { kind: 'workspace', scope, filePath } : { kind: 'uri', uri: '' },
        enabled: Boolean(scope) && fileViewer.previewable && fileViewer.kind !== 'svg',
        ...viewerPreviewIdentity,
        mimeType: fileViewer.mimeType,
        sizeBytes: fileContent?.binarySizeBytes ?? null,
        // Video admission is the transfer's own; every other kind uses the image-preview budget.
        ...(fileViewer.kind === 'video' ? { maxBytes: null } : {}),
    }), [scope, filePath, fileViewer.previewable, fileViewer.kind, fileViewer.mimeType, viewerPreviewIdentity?.cacheScopeId, viewerPreviewIdentity?.cacheKey, fileContent?.binarySizeBytes]);

    // Blame (P8 U5): a region the page places. Its run column rides the reading surface's leading lane in
    // View and Changes; the card and its one note sit beside it.
    const blameScope = React.useMemo(() => scope && editorAccountScope?.accountId ? { ...scope, accountId: editorAccountScope.accountId } : null,
        [editorAccountScope?.accountId, scope]);
    const blameContent = React.useMemo(() => fileContent && !fileContent.isBinary && !fileContent.partial
        && typeof fileContent.content === 'string' && fileContent.contentHash ? { text: fileContent.content, hash: fileContent.contentHash } : null,
    [fileContent]);
    const blameRegion = useFileBlameRegion({
        scope: blameScope, path: filePath, content: blameContent,
        enabled: fileView.blame === true && isActive && !isEditingFile,
        readBlame: scmSnapshot?.capabilities?.readBlame === true,
        sessionAddress, compact: phonePage,
    });


    const isBinaryFile = fileContent?.isBinary === true;
    const deleted = fileEntry?.kind === 'deleted';
    // The header's facts (details lab 2): how the file changed and by how much, or, for an unchanged
    // file, that nothing changed and how long it is; a partial view says which part it holds.
    const headerStatusLabel = fileEntry && !deleted ? resolveFileStatusLabel(fileEntry.kind) : null;
    const headerDiffStat = fileStatusForHeaderActions && !deleted
        ? { added: fileStatusForHeaderActions.linesAdded, removed: fileStatusForHeaderActions.linesRemoved }
        : null;
    const partial = fileContent?.partial ?? null;
    const headerSummaryFacts = partial
        ? [t('files.pane.page.partialFact', { slice: formatFilePageBytes(partial.length), size: formatFilePageBytes(partial.totalBytes) })]
        : tooLarge && !fileContent ? [formatFilePageBytes(tooLarge.sizeBytes)]
        : !fileEntry && !hasPendingDelta && !hasIncludedDelta && typeof fileContent?.content === 'string' && !isBinaryFile
            // "No changes" only once source control has answered; until then the line says only what is known.
            ? [...(scmSnapshot ? [t('detailsSurface.file.noChanges')] : []), t('detailsSurface.file.lines', { count: countTextLines(fileContent.content) })]
            : null;
    // Offline or behind: the content we hold stays at full strength under one line (FV1o, OR-1); editing
    // is never blocked. One cause, one line: a page above that already says it is not repeated here.
    const stale = Boolean(fileContent || diffContent !== null) && (checkoutReachability.unreachable || staleSince !== null);
    const freshnessLine = stale && !checkoutReachability.announced ? (
        <SurfaceFreshnessLine
            testID="file-details-freshness"
            asOf={staleSince ?? checkoutReachability.lastSeenAt}
            reason={checkoutReachability.unreachable ? unavailableReason : (error ?? unavailableReason)}
            action={{ label: t('common.retry'), onPress: () => { void retryMachineReachability(); onRefresh(); } }}
        />
    ) : null;
    const errorLine = error && !stale && !previewTooLarge && !fatalError ? (
        <SurfaceFreshnessLine
            testID="file-preview-unavailable-banner"
            tone="warning"
            reason={error}
            action={{ label: t('common.retry'), onPress: onRefresh }}
        />
    ) : null;
    const textKind = fileViewer.kind === 'markdown' || fileViewer.kind === 'code';
    const bodyLoading = !isEditingFile && !tooLarge && (
        (displayMode === 'diff' && !diffContent && (isDiffLoading || isLoading))
        || (displayMode !== 'diff' && !fileContent && !error && !previewTooLarge)
    );

    // The reading surface (find, comments, line selection) is one; Changes feeds it the scope's diff and rows.
    const renderFindPanel = (surface: FileChangesDiffSurface | null) => (
                    <>
                    {blameRegion.note ? <FileBlameNote note={blameRegion.note} /> : null}
                    {blameRegion.card}
                    <FileViewerFindSurface surfaceId={findSurfaceId} active={isActive} focusRootRef={findFocusRoot}
                        content={{ path: filePath, mode: displayMode, text: displayMode === 'diff' ? (surface ? surface.unifiedDiff : diffContent) : fileContent?.isBinary ? null : fileContent?.content ?? null }}
                        findSeed={props.findSeed} onFindSeedConsumed={props.onFindSeedConsumed}>
                    {(find) => (
                    <FileContentPanel
                        find={find}
                        liveMoment={displayMode === 'file' ? liveMoment : null}
                        intelligence={displayMode === 'file' ? codeIntelligence.viewBinding : null}
                        theme={theme}
                        displayMode={displayMode}
                        sessionId={sessionId}
                        filePath={filePath}
                        diffContent={surface ? surface.unifiedDiff : diffContent}
                        hunks={surface?.hunks}
                        reviewUnits={surface?.reviewUnits}
                        reviewScrollToLineId={surface?.scrollToLineId}
                        fileContent={fileContent?.isBinary ? null : (fileContent?.content ?? null)}
                        language={language}
                        syntaxHighlighting={syntaxHighlighting}
                        selectedLineKeys={displayedSelectedLineKeys}
                        lineSelectionEnabled={effectiveLineSelectionEnabled && Boolean(scope)}
                        onToggleLine={toggleSelectedLine}
                        commentRangeRequest={commentRangeRequest}
                        rangeSelectionActive={rangeSelectionActive}
                        wrapLines={effectiveWrapLines}
                        showLineNumbers={showLineNumbers}
                        showPrefix={showLineNumbers}
                        reviewCommentsEnabled={reviewCommentsEnabled}
                        reviewCommentModeActive={reviewCommentModeActive}
                        reviewCommentDrafts={reviewCommentDrafts}
                        onUpsertReviewCommentDraft={reviewDraftHandlers.onUpsertReviewCommentDraft}
                        onDeleteReviewCommentDraft={reviewDraftHandlers.onDeleteReviewCommentDraft}
                        onReviewCommentError={reviewDraftHandlers.onReviewCommentError}
                        jumpToAnchor={jumpToAnchor}
                        scrollTestID="file-details-scroll"
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={scrollFades.onScroll}
                        renderLeadingLane={blameRegion.renderLeadingLane}
                        emphasizedLines={blameRegion.emphasizedLines}
                    />
                    )}
                    </FileViewerFindSurface>
                    </>
    );

    return (
        <View ref={findFocusRoot} style={[styles.container, { backgroundColor: paintColor(theme.colors.surface.base, 'transparent') }]}>
            <View
                style={{
                    width: '100%',
                    ...(constrainWidth ? { maxWidth: layout.maxWidth, alignSelf: 'center' } : { maxWidth: '100%' }),
                }}
            >
                <FilePageHeader
                    // The Code page's own bar already names the file and its folders (until it hosts this header).
                    fileName={fileName}
                    filePath={filePath}
                    breadcrumbRoot={props.breadcrumbRoot}
                    onOpenFolder={props.onOpenFolder ?? (props.onRevealInFilesTree ? (folder) => props.onRevealInFilesTree?.(folder) : undefined)}
                    attribution={deleted ? null : editorAttribution.agentName || attributionUpdatedAt !== null ? {
                        agentName: editorAttribution.agentName,
                        requesterName: editorAttribution.requesterName,
                        updatedAt: attributionUpdatedAt,
                    } : null}
                    deletion={deleted ? {
                        agentName: editorAttribution.agentName,
                        at: editorAttribution.updatedAt,
                        onRestore: changesReview.menuChanges.discardAll,
                    } : null}
                    statusPill={deleted ? { label: t('detailsSurface.file.statusDeleted') } : null}
                    modes={headerModel.modes}
                    find={pageFind}
                    edit={pageEditControl}
                    menuActions={menuActions}
                    toolbarBelow={phoneToolbar}
                    displayMode={displayMode}
                    onDisplayMode={onDisplayMode}
                    diffMode={diffMode}
                    onDiffMode={setDiffMode}
                    hasPendingDelta={hasPendingDelta}
                    hasIncludedDelta={hasIncludedDelta}
                    isUntrackedFile={fileEntry?.kind === 'untracked'}
                    scmWriteEnabled={scmWriteEnabled && Boolean(scope)}
                    includeExcludeEnabled={includeExcludeEnabled && Boolean(scope)}
                    virtualSelectionEnabled={virtualSelectionEnabled && Boolean(scope)}
                    isSelectedForCommit={isSelectedForCommit}
                    lineSelectionEnabled={lineSelectionEnabled && Boolean(scope)}
                    lineSelectionActive={commitSelectionModeActive}
                    rangeSelectionActive={rangeSelectionActive}
                    reviewCommentsEnabled={reviewCommentsEnabled}
                    commentModeActive={reviewCommentModeActive}
                    selectedLineCount={commitSelectionModeActive ? selectedLineKeys.size : 0}
                    isApplyingStage={isApplyingStage}
                    inFlightScmOperation={inFlightScmOperation}
                    onStageFile={onStageFile}
                    onUnstageFile={onUnstageFile}
                    onApplySelectedLines={onApplySelectedLines}
                    onClearSelection={onClearSelection}
                    onStartRangeSelection={onStartRangeSelection}
                    onToggleCommentMode={onToggleReviewCommentMode}
                    fileEditorEnabled={editorSurfaceEnabled && !isBinaryFile && !deleted}
                    isEditingFile={isEditingFile}
                    editor={editorHeader}
                    onStartEditingFile={handleStartEditingFile}
                    onCancelEditingFile={cancelEditingFile}
                    onSaveEditingFile={saveFileEdits}
                    statusLabel={headerStatusLabel}
                    diffStat={headerDiffStat}
                    summaryFacts={headerSummaryFacts}
                    providerFacts={codeIntelligence.headerFacts}
                    notice={(
                        <>
                            {freshnessLine}
                            {errorLine}
                            {codeIntelligence.notice}
                            <FileEditorNoticeLine editor={editorHeader} editing={isEditingFile && displayMode === 'file' && !editorState.comparison}
                                reachability={checkoutReachability} agentName={editorAttribution.agentName}
                                onOpenApproval={openEditorApproval} />
                        </>
                    )}
                />
                {props.openableContentViewer && openableContentViewerEligible ? (
                    <WorkspaceFileOpenableContentViewerControls
                        scope={scope}
                        filePath={filePath}
                        host={props.openableContentViewer}
                        builtinBodyRequired={isEditingFile || fileView.startEditing === true}
                        requestEdit={requestEditFromViewer}
                        onRevealInFilesTree={props.onRevealInFilesTree}
                    />
                ) : null}
            </View>

            <View
                style={{
                    flex: 1,
                    minHeight: 0,
                    position: 'relative',
                    width: '100%',
                    ...(constrainWidth ? { maxWidth: layout.maxWidth, alignSelf: 'center' } : { maxWidth: '100%' }),
                }}
            >
                {fatalError && !isEditingFile ? (
                    <FileErrorState filePath={filePath} error={error} onRetry={onRefresh} />
                ) : tooLarge && !fileContent && !isEditingFile && displayMode !== 'diff' ? (
                    <FileTooLargeState
                        sizeBytes={tooLarge.sizeBytes}
                        sliceBytes={tooLarge.maxPreviewBytes}
                        onShowFirst={() => patchFileView({ previewSlice: 'head' })}
                        onShowLast={() => patchFileView({ previewSlice: 'tail' })}
                        onDownload={() => { void share.download(); }}
                    />
                ) : previewTooLarge && !fileContent && !isEditingFile && displayMode !== 'diff' ? (
                    // Over the budget and not readable as text: the whole file goes through Download.
                    <FileTooLargeState sizeBytes={null} onDownload={() => { void share.download(); }} />
                ) : bodyLoading ? (
                    // Nothing of this file is held yet and its machine isn't answering: say what it waits for.
                    checkoutReachability.unreachable ? <CheckoutUnreachableState reachability={checkoutReachability} testID="file-details-unreachable" />
                        : textKind && displayMode !== 'markdown' ? (
                            <View style={{ flex: 1 }}>
                                <FileReadingLine machineName={checkoutReachability.machineName} />
                                <FileCodeSkeleton active={isActive} />
                            </View>
                        ) : <FileLoadingState filePath={filePath} />
                ) : displayMode === 'file' && isEditingFile && isMarkdownFile ? (
                    <MarkdownCodeEditorField
                        {...codeGeometry}
                        value={editorSeedText} resetKey={String(editorResetKey)} filePath={filePath} language={language}
                        onChange={onEditorChange} editorRef={editorHandleRef} liveValue={liveValue}
                        findSurfaceId={findSurfaceId} active={isActive} focusRootRef={findFocusRoot}
                        findSeed={props.findSeed} onFindSeedConsumed={props.onFindSeedConsumed}
                        wrapLines={effectiveWrapLines} showLineNumbers={showLineNumbers}
                        changeDebounceMs={typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : undefined}
                        bridgeMaxChunkBytes={typeof filesEditorBridgeMaxChunkBytes === 'number' ? filesEditorBridgeMaxChunkBytes : undefined}
                        onReady={onEditorReady} initialLine={initialLine}
                    />
                ) : displayMode === 'file' && isEditingFile ? (
                    <>
                    <FileEditorPanel
                        {...codeGeometry}
                        onReady={onCodeEditorReady}
                        initialLine={initialLine}
                        surfaceId={findSurfaceId}
                        active={isActive}
                        filePath={filePath}
                        focusRootRef={findFocusRoot}
                        findSeed={props.findSeed}
                        onFindSeedConsumed={props.onFindSeedConsumed}
                        theme={theme}
                        resetKey={String(editorResetKey)}
                        editorRef={editorHandleRef}
                        value={editorSeedText}
                        language={language}
                        onChange={onEditorChange}
                        wrapLines={effectiveWrapLines}
                        showLineNumbers={showLineNumbers}
                        changeDebounceMs={typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : undefined}
                        bridgeMaxChunkBytes={typeof filesEditorBridgeMaxChunkBytes === 'number' ? filesEditorBridgeMaxChunkBytes : undefined}
                        changeMarkers={changeMarkers}
                        accessory={editorAccessory}
                        peek={editorPeek}
                    />
                    {scope ? (
                        <FileEditorAskControls handle={readyEditorHandle} scopeId={props.scopeId} scope={scope} filePath={filePath}
                            savedText={fileContent?.isBinary ? undefined : fileContent?.content} sessionId={sessionId || null} active={isActive} />
                    ) : null}
                    </>
                ) : (displayMode === 'file' && isBinaryFile) ? (
                    <FileViewerBody
                        viewer={fileViewer}
                        title={filePath.split(/[\\/]/).at(-1) || filePath}
                        source={viewerPreviewInput}
                        sizeBytes={fileContent?.binarySizeBytes ?? null}
                        isActive={isActive}
                        findSurfaceId={findSurfaceId}
                        onDownload={() => { void share.download(); }}
                        {...(share.openInDefaultApp ? { onOpenInDefaultApp: share.openInDefaultApp } : {})}
                        testID="file-viewer-body"
                    />
                ) : displayMode === 'diff' && scope ? (
                    <FileChangesSection review={changesReview} scope={scope} filePath={filePath}
                        keyboardActive={isActive} liveChangeKind={fileEntry?.kind ?? null}
                        ask={{ scopeId: props.scopeId, sessionId: sessionId || null, active: isActive }}>
                        {(surface) => renderFindPanel(surface)}
                    </FileChangesSection>
                ) : (
                    // The read bodies (code view, Markdown preview) are one selection source for Ask (lab AS1).
                    <View ref={readBodyRef} collapsable={false} style={{ flex: 1, minHeight: 0 }}>
                        {renderFindPanel(null)}
                        {Platform.OS === 'web' && heldText !== null && (displayMode === 'file' || displayMode === 'markdown') ? (
                            <FileReadAskControls rootRef={readBodyRef} mode={displayMode === 'markdown' ? 'markdown' : 'code'}
                                scopeId={props.scopeId} scope={scope} filePath={filePath} text={heldText}
                                sessionId={sessionId || null} active={isActive && !reviewCommentModeActive}
                                onCommentRange={reviewCommentsEnabled && displayMode === 'file' ? onCommentSelectedRange : undefined} />
                        ) : null}
                    </View>
                )}

                {displayMode === 'file' && isEditingFile && editorState.comparison ? (
                    // Compare covers the editor without unmounting it, so the engine keeps its buffer, caret and undo.
                    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
                        <FileEditorCompareBody comparison={editorState.comparison} agentName={editorAttribution.agentName}
                            filePath={filePath} showLineNumbers={showLineNumbers}
                            onUsePlaceMine={editorState.usePlaceMine} onUsePlaceTheirs={editorState.usePlaceTheirs}
                            onUseAllMine={editorState.useAllMine} onUseAllTheirs={editorState.useAllTheirs}
                            onBackToEditing={editorState.backToEditing} />
                    </View>
                ) : null}
                {displayMode === 'file' && isEditingFile ? null : (
                    <>
                        <ScrollEdgeFades color={theme.colors.surface.base} size={18} edges={scrollFades.visibility} />
                        <ScrollEdgeIndicators
                            edges={scrollFades.visibility}
                            color={theme.colors.text.secondary}
                            size={14}
                            opacity={0.35}
                        />
                    </>
                )}
            </View>
            {partial && displayMode !== 'diff' ? (
                <FilePartialFooter slice={partial.slice} sliceBytes={partial.length} totalBytes={partial.totalBytes}
                    onDownload={() => { void share.download(); }} />
            ) : null}
            {codeIntelligence.layer}
            {phoneToolbar ? (
                <FilePageToolbar
                    modes={headerModel.modes}
                    displayMode={displayMode}
                    onDisplayMode={onDisplayMode}
                    find={pageFind}
                    edit={pageEditControl}
                    bottomInset={safeAreaInsets.bottom}
                />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
}));
