import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { formatHappierAsOfTime } from '@happier-dev/plugin-ui/presentation';
import type { PublicActionResultById } from '@happier-dev/protocol';
import { readWidgetDefinitionResourcesV1, type WidgetDefinitionV1, type WidgetInstanceRefV1 } from '@happier-dev/protocol/widgets';

import { readWidgetDescriptor, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { ConfiguredWidgetTargetResolution } from '@/sync/domains/widgets/widgetBinding';
import { useWorkBoardSummaries } from '@/components/boards/model/useWorkBoards';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { resolvePluginAppPages, selectPluginAppPagePlacements } from '@/components/appShell/plugins/pluginAppPages';
import { humanizeIdentifier } from '@/components/settings/home/governance/homeFeatureLabels';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage, useArtifact } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import { WidgetFactRow, WidgetFlowPanel, WidgetFlowTextAction, widgetFlowText } from '@/components/widgets/flow/WidgetFlowPanel';

type PlacementSummary = NonNullable<PublicActionResultById['widgets.definition.get']['placementSummary']>;

/** One read the definition admits, as the person reads it. */
export type WidgetAboutSource = Readonly<{
    key: string;
    /** The serving plugin ("analytics replica"). */
    plugin: string;
    /** The machine its read runs on, when the projection says so. */
    machine: string | null;
    /** Each viewer's own connection is used for it. */
    usesViewerConnection: boolean;
    /** The declared read as words ("Bound count"). */
    read: string;
    /** The exact admitted Resource, qualified by its plugin ("acme.checks/bound-count"); the declaration exposes no saved query text. */
    identity: string;
}>;

/** Read metadata uses the admitted target's projection, never the containing page's machine. */
export function readWidgetAboutSources(input: Readonly<{
    definition: WidgetDefinitionV1 | null;
    descriptor: WidgetCandidate | null;
    resolution: ConfiguredWidgetTargetResolution | null;
}>): readonly WidgetAboutSource[] {
    const runtime = input.resolution?.status === 'ready' ? input.resolution.runtime : null;
    const projection = runtime?.pluginUiProjection;
    const reference = input.definition?.body.kind === 'installed' || input.definition?.body.kind === 'builtin' ? input.definition.body
        : input.descriptor?.sourceDefinition ?? (input.descriptor?.surface ? { kind: 'installed' as const, surface: input.descriptor.surface } : null);
    const installed = reference ? readWidgetDescriptor(projection, reference) : null;
    const resources = input.definition && (input.definition.body.kind === 'declarative' || input.definition.body.kind === 'html') ? readWidgetDefinitionResourcesV1(input.definition)
        : reference && runtime ? installed?.resources ?? [] : input.descriptor?.resources ?? [];
    const state = storage.getState();
    return resources.map((resource) => {
        const declaration = Object.values(projection?.resourcesById ?? {}).find((row) => row.pluginId === resource.pluginId && row.id === resource.localId);
        const origin = readPluginUiContributionOrigin(declaration);
        const machine = origin?.machineId ? resolveServerScopedMachine(state, origin.serverId, origin.machineId) : null;
        return {
            key: `${resource.pluginId}/${resource.localId}`,
            identity: `${resource.pluginId}/${resource.localId}`,
            plugin: projection?.installedPackagesById[resource.pluginId]?.displayName ?? installed?.pluginName ?? resource.pluginId,
            machine: getMachineDisplayName(machine),
            usesViewerConnection: (declaration?.connectedAccountPurposes?.length ?? 0) > 0,
            // The declaration carries no title, so the id is said as words ("count" -> "Count").
            read: humanizeIdentifier(resource.localId),
        };
    });
}

/** The plugin page's own title as the viewer's navigation shows it, or `null` while the page is not in this viewer's projection. */
function readPluginPageName(pluginId: string, pageId: string): string | null {
    const projection = readCurrentAppShellPluginUiProjection();
    if (!projection) return null;
    const page = resolvePluginAppPages({ placements: selectPluginAppPagePlacements(projection),
        localize: createPluginLocalizedTextResolver({ projection }) })
        .find(candidate => candidate.pluginId === pluginId && candidate.localId === pageId);
    return page?.label ?? null;
}

/** One place a copy is used: its name as the person knows it, led by that place's own mark. */
export type WidgetPlacementLabel = Readonly<{ label: string; icon: IconName }>;

/**
 * Where the copies are ("Launch week" with the Board mark, "Home"); scopes it cannot list are said,
 * never guessed. The mark says what kind of place it is, so a Board's name is never followed by "board".
 */
export function useWidgetPlacementLabels(summary: PlacementSummary | null): readonly WidgetPlacementLabel[] {
    const boards = useWorkBoardSummaries(summary?.placements.some(ref => ref.surface.owner.kind === 'workBoard') ?? false);
    return React.useMemo(() => {
        if (!summary) return [];
        const labels = summary.placements.map((ref: WidgetInstanceRefV1): WidgetPlacementLabel => {
            const owner = ref.surface.owner;
            switch (owner.kind) {
                case 'home': return { label: t('widgetDefinition.placedOnHome'), icon: 'chats-circle' };
                case 'workBoard': {
                    const board = boards.find((candidate) => candidate.id === owner.boardId);
                    return { label: board ? board.name : t('widgetDefinition.placedOnABoard'), icon: 'squares-four' };
                }
                case 'sessionBoard':
                case 'companion': {
                    const session = storage.getState().sessions[owner.sessionId];
                    return { label: session ? getSessionName(session, ref.surface.serverId) : t('widgetDefinition.placedInASession'), icon: 'chat-circle' };
                }
                case 'project': return { label: t('widgetDefinition.placedInAProject'), icon: 'folder' };
                case 'corePage': return { label: t('widgetDefinition.placedOnACorePage'), icon: 'layout' };
                case 'pluginArea': return { label: readPluginPageName(owner.pluginId, owner.pageId) ?? t('widgetDefinition.placedOnAPluginPage'), icon: 'puzzle-piece' };
            }
        });
        const seen = new Set<string>();
        return labels.filter((entry) => {
            const key = `${entry.icon}\u0000${entry.label}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }, [boards, summary]);
}

/**
 * About this widget (lab `dashboards` dagent G2): who made it and from where, the read it is allowed
 * to make and where that runs, its inputs for this copy, how it refreshes, and every place it is
 * used — with the consequence said plainly: editing the widget changes all of them. Change with the
 * agent drafts a request; Duplicate makes an independent copy.
 */
export function WidgetAboutPanel(props: Readonly<{
    artifactId?: string;
    definition: WidgetDefinitionV1 | null;
    descriptor: WidgetCandidate | null;
    name: string;
    sources: readonly WidgetAboutSource[];
    placements: PlacementSummary | null;
    /** This copy's binding, in words, and the step that edits it. */
    inputs?: Readonly<{ binding: string | null; onEdit?: () => void }>;
    onRefresh?: () => Promise<boolean>;
    onClose?: () => void;
    onChangeWithAgent?: () => void;
    onDuplicate?: () => Promise<string | null>;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const text = widgetFlowText;
    const artifact = useArtifact(props.artifactId ?? '');
    const sources = props.sources;
    const placements = useWidgetPlacementLabels(props.placements);
    const [refresh, setRefresh] = React.useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
    const [duplicate, setDuplicate] = React.useState<Readonly<{ state: 'idle' | 'busy' } | { state: 'done'; name: string } | { state: 'failed' }>>({ state: 'idle' });

    const provenance = props.definition?.provenance.source;
    const origin = provenance?.kind === 'session'
        ? (() => {
            const session = storage.getState().sessions[provenance.sessionId];
            return t('widgetDefinition.savedFromSession', { session: session ? getSessionName(session, provenance.serverId) : t('widgetDefinition.aSession') });
        })()
        : provenance ? t('widgetDefinition.madeInYourAccount') : props.descriptor?.pluginName ?? t('widgetDefinition.aboutUnavailable');
    const edited = artifact?.updatedAt ? t('widgetDefinition.edited', { time: formatHappierAsOfTime(artifact.updatedAt) }) : null;
    const count = props.placements?.placements.length ?? 0;
    const unlisted = (props.placements?.unavailableScopes.length ?? 0) > 0;

    const link = (label: string, onPress: () => void, testID: string) => (
        <WidgetFlowTextAction label={label} onPress={onPress} testID={testID} />
    );

    // The footer (lab G2): the one bordered action — change it with the agent — and Duplicate as a
    // quiet text action beside it.
    return (
        <WidgetFlowPanel
            title={props.name}
            hint={edited ? `${origin} · ${edited}` : origin}
            {...(props.descriptor?.icon ? { mark: props.descriptor.icon } : {})}
            testID={props.testID}
            onClose={props.onClose}
            // A widget with nothing to change or copy here (a built-in) ends on its last fact, with no empty footer band.
            {...(props.onChangeWithAgent || props.onDuplicate ? { footerStart: (
                <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s12 }}>
                    {props.onChangeWithAgent ? (
                        <RoundButton testID={`${props.testID}.changeWithAgent`} size="small" display="secondary"
                            leading={<Icon name="sparkle" size={ICON_SIZE.xs} color={theme.colors.text.primary} />}
                            title={t('widgetDefinition.changeWithAgent')} onPress={props.onChangeWithAgent} />
                    ) : null}
                    {props.onDuplicate ? <WidgetFlowTextAction
                        testID={`${props.testID}.duplicate`}
                        icon="copy"
                        label={t('widgetDefinition.duplicate')}
                        busy={duplicate.state === 'busy'}
                        disabled={duplicate.state === 'busy'}
                        onPress={() => {
                            setDuplicate({ state: 'busy' });
                            void props.onDuplicate!().then((name) => setDuplicate(name ? { state: 'done', name } : { state: 'failed' }));
                        }}
                    /> : null}
                    {duplicate.state === 'done' || duplicate.state === 'failed' ? (
                        <Text style={text.secondary} accessibilityLiveRegion="polite" testID={`${props.testID}.duplicateResult`}>
                            {duplicate.state === 'done' ? t('widgetDefinition.duplicated', { name: duplicate.name }) : t('widgetDefinition.duplicateFailed')}
                        </Text>
                    ) : null}
                </View>
            ) } : {})}
        >
            {sources.length > 0 ? (
                <WidgetFactRow label={t('widgetDefinition.aboutData')} testID={`${props.testID}.data`}>
                    {sources.map((source) => (
                        <View key={source.key}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 }}>
                                <Icon name="hard-drives" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                                <Text style={[text.primary, text.strong]}>{source.plugin}</Text>
                            </View>
                            <Text style={text.secondary}>
                                {[t('widgetDefinition.readsOnly'),
                                    source.machine ? t('widgetDefinition.runsOn', { machine: source.machine }) : null,
                                    source.usesViewerConnection ? t('widgetDefinition.withYourConnection') : null].filter(Boolean).join(' · ')}
                            </Text>
                        </View>
                    ))}
                </WidgetFactRow>
            ) : null}
            {sources.length > 0 ? (
                <WidgetFactRow label={t('widgetDefinition.aboutReads')} testID={`${props.testID}.reads`}>
                    {sources.map((source) => (
                        <View key={source.key}>
                            <Text style={text.primary}>{t('widgetDefinition.readsResource', { read: source.read, plugin: source.plugin })}</Text>
                            <Text style={[text.secondary, Typography.mono()]} testID={`${props.testID}.reads.identity`}>{source.identity}</Text>
                        </View>
                    ))}
                    <Text style={text.secondary}>{t('widgetDefinition.cannotRunAnythingElse')}</Text>
                </WidgetFactRow>
            ) : null}
            {props.inputs && (props.definition?.inputs ?? props.descriptor?.inputs)?.fields.length ? (
                <WidgetFactRow label={t('widgetDefinition.aboutInputs')} testID={`${props.testID}.inputs`}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: theme.space.s6 }}>
                        <Text style={text.primary}>
                            {props.inputs.binding ?? (props.definition?.inputs ?? props.descriptor?.inputs)?.fields.map((field) => field.title).join(', ')}
                        </Text>
                        {props.inputs.onEdit ? link(t('common.edit'), props.inputs.onEdit, `${props.testID}.editInputs`) : null}
                    </View>
                    <Text style={text.secondary}>{t('widgetDefinition.inputsThisCopy')}</Text>
                </WidgetFactRow>
            ) : null}
            {sources.length > 0 ? (
                <WidgetFactRow label={t('widgetDefinition.aboutRefresh')} testID={`${props.testID}.refresh`}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: theme.space.s6 }}>
                        <Text style={text.primary}>{t('widgetDefinition.refreshWhenOpen')}</Text>
                        {props.onRefresh ? link(
                            refresh === 'busy' ? t('widgetDefinition.refreshing') : t('widgetDefinition.refreshNow'),
                            () => {
                                if (refresh === 'busy') return;
                                setRefresh('busy');
                                void props.onRefresh!().then((ok) => setRefresh(ok ? 'done' : 'failed'));
                            },
                            `${props.testID}.refreshNow`,
                        ) : null}
                    </View>
                    {refresh === 'done' || refresh === 'failed' ? (
                        <Text style={text.secondary} accessibilityLiveRegion="polite">
                            {refresh === 'done' ? t('widgetDefinition.refreshed') : t('widgetDefinition.refreshFailed')}
                        </Text>
                    ) : null}
                </WidgetFactRow>
            ) : null}
            <WidgetFactRow label={t('widgetDefinition.aboutUsedIn')} testID={`${props.testID}.usedIn`}>
                {placements.length > 0 ? placements.map((place) => (
                    <View key={`${place.icon}:${place.label}`} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 }}>
                        <Icon name={place.icon} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                        <Text style={text.primary} numberOfLines={1}>{place.label}</Text>
                    </View>
                )) : <Text style={text.primary}>{t('widgetDefinition.notPlacedYet')}</Text>}
                {unlisted ? <Text style={text.secondary}>{t('widgetDefinition.otherPlacesNotListed')}</Text> : null}
                {props.artifactId ? <Text style={text.secondary} testID={`${props.testID}.consequence`}>
                    {unlisted || count === 0 ? t('widgetDefinition.editsChangeEverywhere') : t('widgetDefinition.editsChangeAll', { count })}
                </Text> : null}
            </WidgetFactRow>
        </WidgetFlowPanel>
    );
}
