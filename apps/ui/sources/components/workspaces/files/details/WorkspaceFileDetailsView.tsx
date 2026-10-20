import { FileBrowserToolbarIconButton } from '@/components/ui/filesystemBrowser/FileBrowserToolbar';
import { Icon } from '@/components/ui/icons/Icon';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { FileActionToolbar, type FileDisplayMode } from '@/components/workspaces/files/file/FileActionToolbar';
import { FileBinaryState, FileErrorState, FileLoadingState } from '@/components/workspaces/files/file/FileScreenState';
import { CheckoutUnreachableState, useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { FileContentPanel, resolveFileCodeGeometry } from '@/components/workspaces/files/file/FileContentPanel';
import { FileViewerFindSurface } from './FileViewerFindSurface';
import { useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { FileEditorPanel } from '@/components/workspaces/files/file/editor/FileEditorPanel';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { WorkspaceFileDownloadButton } from '@/components/workspaces/files/file/WorkspaceFileDownloadButton';
import { WorkspaceAugmentedScmChangeDiscardButton } from '@/components/workspaces/files/details/sessionAugmentation/WorkspaceAugmentedScmChangeDiscardButton';

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
import { useWorkspaceFileTransfers } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';
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
import { useFilePreviewSource } from '@/components/ui/media/useFilePreviewSource';
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
    /** The host already names the file above the reader (the Code page's breadcrumb): the header doesn't repeat it. */
    hostNamesFile?: boolean;
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
        });
    }, [
        binding,
        candidates,
        host,
        localizePluginText,
        originalBuiltinTab,
        originalBuiltinTabState,
        stage,
        stat,
    ]);

    React.useEffect(() => {
        if (
            !host?.details.active
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
        });
    }, [
        binding,
        choiceModel,
        host,
        localizePluginText,
        originalBuiltinTab,
        originalBuiltinTabState,
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
    const downloadActionsAvailable = Boolean(scope);
    const rawTransfers = useWorkspaceFileTransfers({ workspaceScope: scope });
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
        persistedDraft?.isEditingFile ? 'file' : fileView.mode ?? (deepLinkAnchor?.source === 'file' ? 'file' : 'diff')
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
    const { fileContent, diffContent, setDiffContent, isLoading, isDiffLoading, error, fileWriteSupported, setFileWriteSupported, refreshAll, publishSavedFile } = useWorkspaceFileDetailsLoading({
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
    const exportRawFile = React.useCallback(async () => {
        if (!scope || fileEntry?.kind === 'deleted') return;
        const result = await rawTransfers.startDownload({ path: filePath, asZip: false });
        if (!result.ok && result.canceled !== true && mountedRef.current) Modal.alert(t('common.error'), result.error);
    }, [fileEntry?.kind, filePath, mountedRef, rawTransfers.startDownload, scope]);
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
        panePersistenceFailed: pane.persistenceFailed,
        requestApproval: approval.requestApproval,
    });
    const { editorSurfaceEnabled, isEditingFile, editorResetKey, editorSeedText, editorHandleRef,
        onEditorChange, editorDirty, saveFileEdits, cancelEditingFile, startEditingFile,
        startComparison, liveValue, initialLine, onEditorReady } = editorState;
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
        }));
    }, [requestedDisplayMode, deepLinkAnchor?.source, fileContent, hasRenderableDiff, isEditingFile, markdownPreviewAvailable, persistedDraft?.isEditingFile]);

    const handleStartEditingFile = React.useCallback((at?: { line: number }) => {
        onDisplayMode('file'); props.onStartEditingFile?.(); startEditingFile(at);
    }, [onDisplayMode, props.onStartEditingFile, startEditingFile]);
    const focusedGroup = pane.scopeState?.details?.groups?.find(group => group.id === pane.scopeState?.details?.focusedGroupId);
    const editorHeader = useWorkspaceFileEditorCommands({
        editor: editorState, tabKey, onStart: handleStartEditingFile,
        serverId: scope?.serverId ?? null, accountId: editorAccountScope?.accountId ?? null,
        focused: isActive && (presentation === 'screen' || focusedGroup?.activeTabKey === tabKey),
    });

    const headerModel = resolveFilePageHeaderModel({
        kind: fileViewer.kind,
        hasRenderableDiff, deleted: fileEntry?.kind === 'deleted',
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
        blameAvailable: scmSnapshot?.capabilities.readBlame === true,
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
        headerModel.editUnavailableReason, scmSnapshot?.capabilities.readBlame]);

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

    const previewTooLarge = error === t('files.fileTooLargeToPreview');
    const fatalError = Boolean(error) && !previewTooLarge && !diffContent && !fileContent;

    const imagePreviewMime = fileViewer.kind === 'image' ? fileViewer.mimeType : null;
    const videoPreviewMime = fileViewer.kind === 'video' ? fileViewer.mimeType : null;
    const imagePreviewIdentity = scope ? buildWorkspacePreviewIdentity(scope, filePath, fileContent?.binarySizeBytes,
        JSON.stringify([snapshotSignature ?? lineSelectionFingerprint ?? null, fileContent?.binaryPreviewRevision ?? null])) : null;
    const imagePreview = useFilePreviewSource({
        source: scope ? { kind: 'workspace', scope, filePath } : { kind: 'uri', uri: '' },
        enabled: isActive && Boolean(scope && imagePreviewMime),
        ...imagePreviewIdentity,
        mimeType: imagePreviewMime,
        sizeBytes: fileContent?.binarySizeBytes ?? null,
    });
    const imagePreviewUri = imagePreview.status === 'loaded' ? imagePreview.uri : null;

    if (!scope) {
        return <SurfaceStateCard
            testID="file-details-scope-unavailable"
            kind="unavailable"
            title={t('common.unavailable')}
            reason={t('errors.daemonUnavailableBody')}
        />;
    }

    if (isLoading && !fileContent && !isEditingFile) {
        // The machine isn't answering and nothing of this file is known yet: say what it waits for
        // (once, when the page above already does) instead of an "Opening…" that never ends.
        if (checkoutReachability.unreachable) return <CheckoutUnreachableState reachability={checkoutReachability} testID="file-details-unreachable" />;
        return <FileLoadingState filePath={filePath} />;
    }

    if (fatalError && !isEditingFile) {
        return <FileErrorState filePath={filePath} error={error} onRetry={onRefresh} />;
    }

    const isBinaryFile = fileContent?.isBinary === true;
    // The header's facts (details lab 2): how the file changed and by how much, or, for an unchanged
    // file, that nothing changed and how long it is.
    const headerStatusLabel = fileEntry ? resolveFileStatusLabel(fileEntry.kind) : null;
    const headerDiffStat = fileStatusForHeaderActions
        ? { added: fileStatusForHeaderActions.linesAdded, removed: fileStatusForHeaderActions.linesRemoved }
        : null;
    const headerSummaryFacts = !fileEntry && !hasPendingDelta && !hasIncludedDelta && typeof fileContent?.content === 'string' && !isBinaryFile
        ? [t('detailsSurface.file.noChanges'), t('detailsSurface.file.lines', { count: countTextLines(fileContent.content) })]
        : null;
    const showDownloadAction = downloadActionsAvailable && (previewTooLarge || isBinaryFile);
    const showDiscardAction = Boolean(
        sessionId
        && fileStatusForHeaderActions
        && scmWriteEnabled
        && (scmSnapshot?.capabilities?.writeDiscard === true),
    );
    const canFindText = !isBinaryFile
        && (displayMode === 'diff' ? typeof diffContent === 'string' : typeof fileContent?.content === 'string');
    const fileHeaderRightElement = canFindText || showDownloadAction || showDiscardAction || props.onRevealInFilesTree || props.onOpenChanges ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s20 }}>
            {canFindText ? <FileBrowserToolbarIconButton testID="file-header-find" accessibilityRole="button" accessibilityLabel={t('find.open')} onPress={() => findRuntime.open(findSurfaceId)}>
                <Icon name="magnifying-glass" size={16} color={theme.colors.text.secondary} />
            </FileBrowserToolbarIconButton> : null}
            {props.onRevealInFilesTree ? <FileBrowserToolbarIconButton testID="file-header-reveal" accessibilityRole="button" accessibilityLabel={t('files.revealInFiles')} onPress={() => props.onRevealInFilesTree?.(filePath)}>
                <Icon name="folder" size={16} color={theme.colors.text.secondary} />
            </FileBrowserToolbarIconButton> : null}
            {props.onOpenChanges ? <FileBrowserToolbarIconButton testID="file-header-open-changes" accessibilityRole="button" accessibilityLabel={t('files.openChanges')} onPress={props.onOpenChanges}>
                <Icon name="git-branch" size={16} color={theme.colors.text.secondary} />
            </FileBrowserToolbarIconButton> : null}
            {showDownloadAction ? (
                <WorkspaceFileDownloadButton
                    testID="file-header-download"
                    workspaceScope={scope}
                    path={filePath}
                    asZip={false}
                />
            ) : null}
            {sessionId && fileStatusForHeaderActions && showDiscardAction ? (
                <WorkspaceAugmentedScmChangeDiscardButton
                    sessionId={sessionId}
                    serverId={sessionAddress?.serverId}
                    sessionPath={sessionPath}
                    snapshot={scmSnapshot ?? null}
                    scmWriteEnabled={scmWriteEnabled}
                    commitStrategy={scmCommitStrategy}
                    file={fileStatusForHeaderActions}
                    surface="file"
                    onAfterDiscard={refreshAll}
                />
            ) : null}
        </View>
    ) : null;

    return (
        <View ref={findFocusRoot} style={[styles.container, { backgroundColor: paintColor(theme.colors.surface.base, 'transparent') }]}>
            <View
                style={{
                    width: '100%',
                    ...(constrainWidth ? { maxWidth: layout.maxWidth, alignSelf: 'center' } : { maxWidth: '100%' }),
                }}
            >
                <FileActionToolbar
                    theme={theme}
                    fileName={fileName}
                    filePathDir={filePathDir}
                    hostNamesFile={props.hostNamesFile}
                    rightElement={fileHeaderRightElement}
                    contentActions={{
                        onRaw: exportRawFile,
                        onCopy: copyFileContent,
                        rawDisabled: fileEntry?.kind === 'deleted',
                        copyDisabled: !fileContent || isBinaryFile,
                        rawBusy: rawTransfers.downloadState.status === 'downloading',
                        copyBusy: copyContentBusy,
                    }}
                    displayMode={displayMode}
                    onDisplayMode={onDisplayMode}
                    showDiffToggle={headerModel.modes.some(option => option.id === 'changes')}
                    showFileToggle={!previewTooLarge && fileEntry?.kind !== 'deleted'}
                    showMarkdownToggle={isMarkdownFile && !isBinaryFile && !previewTooLarge && fileEntry?.kind !== 'deleted'}
                    showWrapLinesToggle={!isBinaryFile && !previewTooLarge && displayMode !== 'markdown'}
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
                    lineSelectionCanStart={lineSelectionCanStart && Boolean(scope)}
                    lineSelectionActive={commitSelectionModeActive}
                    rangeSelectionActive={rangeSelectionActive}
                    reviewCommentsEnabled={reviewCommentsEnabled}
                    commentModeActive={reviewCommentModeActive}
                    selectedLineCount={commitSelectionModeActive ? selectedLineKeys.size : 0}
                    appliedLineSelectionCount={appliedSelectedLineKeys.size}
                    isApplyingStage={isApplyingStage}
                    inFlightScmOperation={inFlightScmOperation}
                    onStageFile={onStageFile}
                    onUnstageFile={onUnstageFile}
                    onApplySelectedLines={onApplySelectedLines}
                    onClearSelection={onClearSelection}
                    onStartLineSelection={onStartLineSelection}
                    onStartRangeSelection={onStartRangeSelection}
                    onToggleCommentMode={onToggleReviewCommentMode}
                    fileEditorEnabled={editorSurfaceEnabled && !isBinaryFile && fileEntry?.kind !== 'deleted'}
                    isEditingFile={isEditingFile}
                    editor={editorHeader}
                    onStartEditingFile={handleStartEditingFile}
                    onCancelEditingFile={cancelEditingFile}
                    onSaveEditingFile={saveFileEdits}
                    statusLabel={headerStatusLabel}
                    diffStat={headerDiffStat}
                    summaryFacts={headerSummaryFacts}
                    notice={(
                        <>
                            {error ? (
                                <SurfaceFreshnessLine
                                    testID="file-preview-unavailable-banner"
                                    tone="warning"
                                    reason={error}
                                    action={{ label: t('common.retry'), onPress: onRefresh }}
                                />
                            ) : null}
                            {editorState.conflict ? (
                                <SurfaceFreshnessLine
                                    testID="file-editor-external-change-banner"
                                    tone="warning"
                                    reason={t('files.externalFileChange')}
                                    action={{ label: t('detailsSurface.file.compare'), onPress: startComparison }}
                                />
                            ) : null}
                        </>
                    )}
                />
                {props.openableContentViewer && openableContentViewerEligible ? (
                    <WorkspaceFileOpenableContentViewerControls
                        scope={scope}
                        filePath={filePath}
                        host={props.openableContentViewer}
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
                {(displayMode === 'diff' && !diffContent && isDiffLoading) || (displayMode !== 'diff' && !fileContent && !error && !isEditingFile) ? (
                    <FileLoadingState filePath={filePath} />
                ) : displayMode === 'file' && isEditingFile && isMarkdownFile ? (
                    <MarkdownCodeEditorField
                        {...codeGeometry}
                        value={editorSeedText} resetKey={String(editorResetKey)} filePath={filePath} language={language}
                        onChange={onEditorChange} editorRef={editorHandleRef} liveValue={liveValue}
                        findSurfaceId={findSurfaceId} active={isActive} focusRootRef={findFocusRoot}
                        findSeed={props.findSeed} onFindSeedConsumed={props.onFindSeedConsumed}
                        wrapLines={wrapLinesInDiffs} showLineNumbers={showLineNumbers}
                        changeDebounceMs={typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : undefined}
                        bridgeMaxChunkBytes={typeof filesEditorBridgeMaxChunkBytes === 'number' ? filesEditorBridgeMaxChunkBytes : undefined}
                        onReady={onEditorReady} initialLine={initialLine}
                    />
                ) : displayMode === 'file' && isEditingFile ? (
                    <FileEditorPanel
                        {...codeGeometry}
                        onReady={onEditorReady}
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
                        wrapLines={wrapLinesInDiffs}
                        showLineNumbers={showLineNumbers}
                        changeDebounceMs={typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : undefined}
                        bridgeMaxChunkBytes={typeof filesEditorBridgeMaxChunkBytes === 'number' ? filesEditorBridgeMaxChunkBytes : undefined}
                    />
                ) : (displayMode === 'file' && isBinaryFile) ? (
                    <ScrollView
                        style={{ flex: 1, minHeight: 0 }}
                        testID="file-details-scroll"
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={scrollFades.onScroll}
                        scrollEventThrottle={16}
                    >
                        <FileBinaryState
                            theme={theme}
                            filePath={filePath}
                            imagePreviewUri={imagePreviewUri}
                            workspaceScope={scope}
                            videoMimeType={videoPreviewMime}
                            binaryPreviewRevision={fileContent?.binaryPreviewRevision}
                            isActive={isActive}
                        />
                    </ScrollView>
                ) : (
                    <FileViewerFindSurface surfaceId={findSurfaceId} active={isActive} focusRootRef={findFocusRoot}
                        content={{ path: filePath, mode: displayMode, text: displayMode === 'diff' ? diffContent : fileContent?.isBinary ? null : fileContent?.content ?? null }}
                        findSeed={props.findSeed} onFindSeedConsumed={props.onFindSeedConsumed}>
                    {(find) => (
                    <FileContentPanel
                        find={find}
                        theme={theme}
                        displayMode={displayMode}
                        sessionId={sessionId}
                        filePath={filePath}
                        diffContent={diffContent}
                        fileContent={fileContent?.isBinary ? null : (fileContent?.content ?? null)}
                        language={language}
                        syntaxHighlighting={syntaxHighlighting}
                        selectedLineKeys={displayedSelectedLineKeys}
                        lineSelectionEnabled={effectiveLineSelectionEnabled && Boolean(scope)}
                        onToggleLine={toggleSelectedLine}
                        rangeSelectionActive={rangeSelectionActive}
                        wrapLines={wrapLinesInDiffs}
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
                    />
                    )}
                    </FileViewerFindSurface>
                )}

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
