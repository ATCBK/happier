import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionCoordinatorEnableResultV1Schema } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorActionsV1';
import type { SessionCoordinatorRuleCensusV1 } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorSetupV1';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { resolveCoordinatorKeepDefault } from '@happier-dev/protocol/account/settings/accountSettings';

import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { useRoleMark } from '@/components/roles/catalog/useRoleMark';
import { CoordinatorKeepListPreview, CoordinatorKeepRailPreview } from '@/components/settings/coordination/CoordinatorKeepPreviews';
import { useSessionMachineName } from '@/components/sessions/agents/presentation/useSessionMachineName';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useInboxSessionHandoff } from '@/hooks/inbox/useInboxSessionHandoff';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { Text } from '@/components/ui/text/Text';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { randomUUID } from '@/platform/randomUUID';
import { describeFollowRuleMatchCount, useFollowRuleMatchCounts, type FollowRuleMatchCount } from '@/components/sessions/follow/followRuleMatchCounts';
import { leaveProjectToFollowRule, undoFollowRuleProjectExclusion } from '@/sync/api/session/sessionFollowRuleEdits';
import { readSessionFollowRules } from '@/sync/api/session/sessionFollowRulesApi';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSession, useSessionDisplayNameProjections, useSetting } from '@/sync/domains/state/storage';
import { useProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { sessionCoordinatorActions } from '@/sync/ops/sessions/sessionCoordinatorActions';
import { t } from '@/text';
import { inferProjectTitleFromPath } from '@/utils/path/browseSegments';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    buildMakeCoordinatorDraft,
    buildMakeCoordinatorEnableInput,
    describeMakeCoordinatorOverlap,
    toggleMakeCoordinatorRule,
    type MakeCoordinatorDraft,
    type MakeCoordinatorKeep,
} from './makeCoordinatorModel';

type MakeCoordinatorDialogProps = CustomModalInjectedProps & Readonly<{ sessionId: string; serverId: string }>;
type RuleScope = 'project' | 'home';
type RuleCount = FollowRuleMatchCount;
type Census = SessionCoordinatorRuleCensusV1 | null | 'loading';

const KEEP_VALUES = ['rail_bot', 'list_pin', 'none'] as const satisfies readonly MakeCoordinatorKeep[];
const KEEP_TITLES = {
    rail_bot: 'settingsCoordination.keepRail',
    list_pin: 'settingsCoordination.keepList',
    none: 'settingsCoordination.keepNone',
} as const satisfies Record<MakeCoordinatorKeep, string>;
const KEEP_CAPTIONS = {
    rail_bot: 'sessionCoordinator.make.keepRailCaption',
    list_pin: 'sessionCoordinator.make.keepListCaption',
    none: 'sessionCoordinator.make.keepNoneCaption',
} as const satisfies Record<MakeCoordinatorKeep, string>;
const MANAGED_BY_NONE = '__none__';

/**
 * "Make coordinator…" (C1 §6, lab P3 M/M1/M2/MA): one dialog that shows what will happen and asks only what it
 * can't answer for you. Role, Managed by, where to keep it and what it hears about start from Settings →
 * Coordination; Protocol prepares the suggestions and the one `session.coordinator.enable` Action applies the
 * ordinary pieces (role, Bot/pin, manager, rule follows) and reports each one.
 */
export function MakeCoordinatorDialog(props: MakeCoordinatorDialogProps) {
    const { sessionId, serverId, onClose } = props;
    const session = useSession(sessionId, serverId);
    const settings = {
        coordinationCoordinatorRoleId: useSetting('coordinationCoordinatorRoleId'),
        coordinationCoordinatorKeep: useSetting('coordinationCoordinatorKeep'),
        coordinationCoordinatorAnswersWorkerQuestions: useSetting('coordinationCoordinatorAnswersWorkerQuestions'),
        coordinationCoordinatorSuggestProjectRule: useSetting('coordinationCoordinatorSuggestProjectRule'),
        coordinationCoordinatorSuggestHomeRule: useSetting('coordinationCoordinatorSuggestHomeRule'),
    };
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const workspaceRefs = useProjectAccountWorkspaceRefs(true);
    const ruleIds = React.useRef({ project: randomUUID(), home: randomUUID() }).current;
    const initialSettings = React.useRef(settings).current;
    const preparedDraft = React.useMemo(() => buildMakeCoordinatorDraft({ serverId, sessionId, ownerMetadata,
        workspaceRefs, settings: initialSettings, ruleIds, ruleCensus: null }),
    [serverId, sessionId, ownerMetadata, workspaceRefs, initialSettings, ruleIds]);
    const [draft, setDraft] = React.useState<MakeCoordinatorDraft>(preparedDraft);
    const project = draft.project;
    // A name only from a readable path; never an id or a hash in its place.
    const projectName = project && typeof ownerMetadata?.path === 'string' && ownerMetadata.path.trim()
        ? inferProjectTitleFromPath(ownerMetadata.path) : null;
    const projectLabel = projectName ?? t('sessionCoordinator.make.thisProject');
    const currentManagerSessionId = readSessionManagerSessionIdV1(session);
    const name = session ? getSessionName(session, serverId) : '';

    // Capture setup choices for this open. Late Project hydration can supply the
    // initial suggestion; a refresh cannot broaden a chosen Project into Home.
    const rulesChosen = React.useRef(false);
    React.useEffect(() => {
        setDraft(current => {
            if (current.project || !preparedDraft.project) return current;
            const rules = rulesChosen.current ? preparedDraft.rules.map(rule => ({ ...rule,
                enabled: current.rules.find(previous => previous.scope === rule.scope)?.enabled ?? false })) : preparedDraft.rules;
            const homeWide = rules.some(rule => rule.scope === 'home' && rule.enabled);
            return { ...current, project: preparedDraft.project, rules,
                keep: current.keepFromSetting ? resolveCoordinatorKeepDefault(current.keepPreference, homeWide ? 'home' : 'project') : current.keep };
        });
    }, [preparedDraft]);
    const [census, setCensus] = React.useState<Census>('loading');
    const managedByChosen = React.useRef(false);
    React.useEffect(() => {
        const controller = new AbortController();
        void readSessionFollowRules(serverId, controller.signal).then((snapshot) => {
            if (controller.signal.aborted) return;
            const next = snapshot.status === 'ready' ? { serverId, coverage: 'complete' as const, rules: snapshot.rules } : null;
            setCensus(next);
            if (managedByChosen.current) return;
            const suggested = buildMakeCoordinatorDraft({ serverId, sessionId, ownerMetadata, workspaceRefs, settings, ruleIds, ruleCensus: next }).managedBySessionId;
            setDraft((current) => (current.managedBySessionId === suggested ? current : { ...current, managedBySessionId: suggested }));
        });
        return () => controller.abort();
        // One read per open; the settings and project were captured with the draft.
    }, [serverId]); // eslint-disable-line react-hooks/exhaustive-deps

    const counts = useRulePreviews(serverId, sessionId, draft.rules);
    const [submitting, setSubmitting] = React.useState(false);
    const [footnote, setFootnote] = React.useState<string | null>(null);

    const submit = async () => {
        setSubmitting(true);
        setFootnote(null);
        const result = await sessionCoordinatorActions.enable(sessionId, buildMakeCoordinatorEnableInput(draft, { currentManagerSessionId }), { serverId });
        setSubmitting(false);
        if (!result.ok) { setFootnote(t('sessionCoordinator.make.failed')); return; }
        if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) {
            setFootnote(t('sessionCoordinator.make.waitingApproval'));
            return;
        }
        const parsed = SessionCoordinatorEnableResultV1Schema.safeParse(result.result);
        if (!parsed.success) { setFootnote(t('sessionCoordinator.make.failed')); return; }
        // A partial result keeps the dialog open: what didn't land is said, and Make coordinator again finishes it.
        const unfinished = parsed.data.effects.filter((effect) => effect.status !== 'accepted');
        if (unfinished.length > 0) {
            setFootnote(unfinished.some((effect) => effect.status === 'approval_required')
                ? t('sessionCoordinator.make.partialApproval')
                : t('sessionCoordinator.make.partial', { count: unfinished.length }));
            return;
        }
        publishPresentationNotice({
            key: `session-coordinator:${serverId}:${sessionId}`,
            severity: 'info',
            message: t('sessionCoordinator.make.done', { name }),
            emphasis: name,
        });
        onClose();
    };
    const submitRef = React.useRef(submit);
    submitRef.current = submit;

    const noRules = draft.rules.every((rule) => !rule.enabled);
    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('sessionCoordinator.make.title'),
        subtitle: project ? t('sessionCoordinator.make.subtitleProject', { project: projectLabel }) : t('sessionCoordinator.make.subtitle'),
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default },
        phonePresentation: 'sheet' as const,
        scrollHost: 'bounded' as const,
        testID: 'make-coordinator-dialog',
        footer: (
            <View style={styles.footer}>
                <SectionButtonRow
                    footnote={footnote ?? (noRules ? t('sessionCoordinator.make.noRulesHint') : null)}
                    footnoteTone={footnote ? 'danger' : 'secondary'}
                    trailing={<RoundButton
                        testID="make-coordinator-submit"
                        size="small"
                        title={t('sessionCoordinator.make.submit')}
                        disabled={submitting}
                        loading={submitting}
                        onPress={() => { void submitRef.current(); }}
                    />}
                >
                    <RoundButton testID="make-coordinator-cancel" size="small" display="inverted" title={t('common.cancel')} onPress={onClose} />
                </SectionButtonRow>
            </View>
        ),
    }), [footnote, noRules, onClose, project, projectLabel, submitting]));

    const ruleTitle = (scope: RuleScope) => scope === 'project'
        ? t('sessionCoordinator.make.ruleProject', { project: projectLabel })
        : t('sessionCoordinator.make.ruleHome');
    return (
        <ItemList presentation="grouped" style={styles.list} keyboardShouldPersistTaps="handled" testID="make-coordinator">
            <ItemGroup>
                <RoleField roleId={draft.roleId} onChange={(roleId) => setDraft({ ...draft, roleId })} />
                <ManagedByField
                    sessionId={sessionId}
                    serverId={serverId}
                    census={census}
                    value={draft.managedBySessionId}
                    onChange={(managedBySessionId) => { managedByChosen.current = true; setDraft({ ...draft, managedBySessionId }); }}
                />
            </ItemGroup>
            <KeepSection draft={draft} onChange={(keep) => setDraft({ ...draft, keep, keepFromSetting: false })} />
            <ItemGroup title={t('sessionCoordinator.make.hearsAbout')}>
                {draft.rules.map((rule) => (
                    <Item
                        key={rule.scope}
                        testID={`make-coordinator-rule-${rule.scope}`}
                        title={ruleTitle(rule.scope)}
                        subtitle={describeRuleCount(counts[rule.scope])}
                        subtitleLines={0}
                        showChevron={false}
                        rightElement={<Switch
                            accessibilityLabel={ruleTitle(rule.scope)}
                            value={rule.enabled}
                            onValueChange={(enabled) => { rulesChosen.current = true; setDraft(toggleMakeCoordinatorRule(draft, rule.scope, enabled)); }}
                        />}
                    />
                ))}
                <Item
                    testID="make-coordinator-answers-questions"
                    title={t('settingsCoordination.answersWorkerQuestions')}
                    subtitle={t('settingsCoordination.answersWorkerQuestionsDescription')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch
                        accessibilityLabel={t('settingsCoordination.answersWorkerQuestions')}
                        value={draft.answersWorkerQuestions}
                        onValueChange={(answersWorkerQuestions) => setDraft({ ...draft, answersWorkerQuestions })}
                    />}
                />
            </ItemGroup>
            {project && census !== 'loading' && census && draft.rules.some((rule) => rule.scope === 'project' && rule.enabled) ? (
                <OverlapNote
                    sessionId={sessionId}
                    serverId={serverId}
                    project={project}
                    projectLabel={projectLabel}
                    census={census}
                    preview={counts.project}
                    onEdited={setCensus}
                />
            ) : null}
            <MachineNote sessionId={sessionId} serverId={serverId} />
        </ItemList>
    );
}

function describeRuleCount(count: RuleCount | undefined): string {
    return describeFollowRuleMatchCount(count, t('session.follow.policy.important'));
}

/** What a suggestion would match is fixed for the dialog's life; toggling it changes nothing here. */
function useRulePreviews(serverId: string, sessionId: string, rules: MakeCoordinatorDraft['rules']) {
    const previews = React.useMemo(() => rules.map((rule) => ({ key: rule.scope, filter: rule.suggestion.ruleDefinition.filter })), [rules]);
    return useFollowRuleMatchCounts(serverId, sessionId, previews) as Partial<Record<RuleScope, RuleCount>>;
}

/** The same Role catalog and marks every role picker reads. */
function RoleField(props: Readonly<{ roleId: string; onChange: (roleId: string) => void }>) {
    const [open, setOpen] = React.useState(false);
    const catalog = useRoleCatalog();
    const mark = useRoleMark();
    const choices = catalog.entries.filter((entry) => entry.role.enabled || entry.roleId === props.roleId);
    const selected = choices.find((entry) => entry.roleId === props.roleId);
    const items: DropdownMenuItem[] = choices.map((entry) => ({ id: entry.roleId, title: entry.role.name, icon: mark(entry.role, 20, entry.roleId) }));
    return (
        <DropdownMenu
            testID="make-coordinator-role"
            open={open}
            onOpenChange={setOpen}
            variant="selectable"
            search={false}
            selectedId={selected ? props.roleId : null}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            itemTrigger={{
                title: t('sessionCoordinator.make.role'),
                subtitle: t('sessionCoordinator.make.roleDescription'),
                showSelectedSubtitle: false,
                detailFormatter: () => selected?.role.name ?? (catalog.status === 'ready' ? t('common.unavailable') : t('common.loading')),
                field: selected ? { leading: mark(selected.role, 16, selected.roleId) } : undefined,
                itemProps: { subtitleLines: 0 },
            }}
            items={items}
            onSelect={(id) => { props.onChange(id); setOpen(false); }}
        />
    );
}

/** Other sessions that follow by a rule in this Home: the ones that can sensibly hear this one's summaries. */
function ManagedByField(props: Readonly<{
    sessionId: string;
    serverId: string;
    census: Census;
    value: string | null;
    onChange: (sessionId: string | null) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const loading = props.census === 'loading';
    const rules = props.census === 'loading' ? null : props.census?.rules;
    const candidateIds = React.useMemo(() => {
        const ids = new Set<string>();
        for (const rule of rules ?? []) {
            if (rule.receiver.kind === 'session' && rule.receiver.sessionId !== props.sessionId && rule.definition.enabled) ids.add(rule.receiver.sessionId);
        }
        if (props.value) ids.add(props.value);
        return [...ids];
    }, [props.sessionId, props.value, rules]);
    const addresses = React.useMemo(() => candidateIds.map((sessionId) => ({ sessionId, serverId: props.serverId })), [candidateIds, props.serverId]);
    const names = useSessionDisplayNameProjections(addresses, (source) => (source ? getSessionName(source, props.serverId) : null));
    const nameOf = (id: string) => names[candidateIds.indexOf(id)] ?? t('sessionCoordinator.make.unknownSession');
    const items: DropdownMenuItem[] = [
        { id: MANAGED_BY_NONE, title: t('sessionCoordinator.make.managedByNone') },
        ...candidateIds.map((id) => ({ id, title: nameOf(id) })),
    ];
    const subtitle = props.value ? t('sessionCoordinator.make.managedByDescription')
        : candidateIds.length > 1 ? t('sessionCoordinator.make.managedByChoose') : t('sessionCoordinator.make.managedByNoneDescription');
    return (
        <DropdownMenu
            testID="make-coordinator-managed-by"
            open={open}
            onOpenChange={setOpen}
            variant="selectable"
            search={false}
            selectedId={props.value ?? MANAGED_BY_NONE}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            itemTrigger={{
                title: t('sessionCoordinator.make.managedBy'),
                subtitle,
                showSelectedSubtitle: false,
                detailFormatter: () => loading ? t('common.loading')
                    : props.value ? nameOf(props.value) : t('sessionCoordinator.make.managedByNone'),
                itemProps: { subtitleLines: 0 },
            }}
            items={items}
            onSelect={(id) => { props.onChange(id === MANAGED_BY_NONE ? null : id); setOpen(false); }}
        />
    );
}

/** Settings → Coordination's Where-to-keep anatomy: one stacked row, the real-surface tiles, the choice in words. */
function KeepSection(props: Readonly<{ draft: MakeCoordinatorDraft; onChange: (keep: MakeCoordinatorKeep) => void }>) {
    const caption = t(KEEP_CAPTIONS[props.draft.keep]);
    return (
        <ItemGroup>
            <Item
                testID="make-coordinator-keep"
                title={t('sessionCoordinator.make.keepTitle')}
                subtitle={props.draft.keepFromSetting ? `${caption} · ${t('sessionCoordinator.make.fromSetting')}` : caption}
                subtitleLines={0}
                accessoryLayout="stacked"
                showChevron={false}
                rightElement={<SelectionTiles
                    variant="visual"
                    accessibilityLabel={t('sessionCoordinator.make.keepTitle')}
                    testIdPrefix="make-coordinator-keep"
                    value={props.draft.keep}
                    onChange={(next) => { if (next) props.onChange(next); }}
                    options={KEEP_VALUES.map((value) => ({
                        id: value,
                        title: t(KEEP_TITLES[value]),
                        preview: value === 'rail_bot' ? <CoordinatorKeepRailPreview /> : <CoordinatorKeepListPreview pinned={value === 'list_pin'} />,
                    }))}
                />}
            />
        </ItemGroup>
    );
}

/**
 * "3 of these are also followed by Daily coordinator" (lab P3 M, MA). Leave them to this one edits that other
 * rule through the shared rule-edit owner (adds "not in project …") and its receipt carries a version-bound Undo.
 */
function OverlapNote(props: Readonly<{
    sessionId: string;
    serverId: string;
    project: QualifiedProjectKeyV1;
    projectLabel: string;
    census: SessionCoordinatorRuleCensusV1;
    preview: RuleCount | undefined;
    onEdited: (census: SessionCoordinatorRuleCensusV1) => void;
}>) {
    const { theme } = useUnistyles();
    const first = props.preview?.status === 'ready'
        ? describeMakeCoordinatorOverlap({ sessionId: props.sessionId, census: props.census, overlaps: props.preview.preview.overlaps })[0]
        : undefined;
    const receiverSessionId = first?.receiverSessionId;
    const addresses = React.useMemo(() => (receiverSessionId ? [{ sessionId: receiverSessionId, serverId: props.serverId }] : []), [props.serverId, receiverSessionId]);
    const [otherName] = useSessionDisplayNameProjections(addresses, (source) => (source ? getSessionName(source, props.serverId) : null));
    const [pending, setPending] = React.useState(false);
    if (!first) return null;
    const other = otherName ?? t('sessionCoordinator.make.unknownSession');
    const { census, onEdited } = props;
    const replaceRule = (rule: SessionCoordinatorRuleCensusV1['rules'][number]) =>
        onEdited({ ...census, rules: census.rules.map((candidate) => (candidate.ruleId === rule.ruleId ? rule : candidate)) });
    const leave = async () => {
        const key = `coordinator-overlap:${first.rule.ruleId}`;
        setPending(true);
        const result = await leaveProjectToFollowRule({ serverId: props.serverId, rule: first.rule, project: props.project });
        setPending(false);
        if (result.kind !== 'ok') {
            publishPresentationNotice({ key, severity: 'error', message: t('sessionCoordinator.make.leaveFailed') });
            return;
        }
        replaceRule(result.value.rule);
        publishPresentationNotice({
            key,
            severity: 'info',
            message: t('sessionCoordinator.make.leftNotice', { name: other, project: props.projectLabel }),
            emphasis: other,
            undo: {
                label: t('bots.undo'),
                run: () => {
                    retirePresentationNotice(key);
                    fireAndForget((async () => {
                        const undone = await undoFollowRuleProjectExclusion(result.value.undo);
                        if (undone.kind === 'ok') replaceRule(undone.value);
                        else publishPresentationNotice({ key, severity: 'error', message: t('sessionCoordinator.make.undoFailed') });
                    })(), { tag: 'MakeCoordinatorDialog.undoOverlap' });
                },
            },
        });
    };
    return (
        <ItemGroup>
            <Item
                testID="make-coordinator-overlap"
                icon={<Icon name="tree-structure" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                title={t('sessionCoordinator.make.overlap', { count: first.count, name: other })}
                titleLines={0}
                subtitle={t('sessionCoordinator.make.overlapBoth')}
                subtitleLines={0}
                mode="info"
                showChevron={false}
            />
            <Item
                testID="make-coordinator-overlap-leave"
                title={t('sessionCoordinator.make.leaveToThis')}
                subtitle={t('sessionCoordinator.make.leaveToThisDescription', { name: other, project: props.projectLabel })}
                subtitleLines={0}
                loading={pending}
                onPress={() => { void leave(); }}
                showChevron={false}
            />
        </ItemGroup>
    );
}

/** The session's machine as it is now; reachable now is never promised as always on. */
function MachineNote(props: Readonly<{ sessionId: string; serverId: string }>) {
    const { theme } = useUnistyles();
    const machineName = useSessionMachineName(props.sessionId, props.serverId);
    const { machineReachability } = useSessionMachineReachability(props.sessionId, props.serverId);
    // Move goes through the one Session handoff owner, offered only when a move can succeed now.
    const handoff = useInboxSessionHandoff(useSession(props.sessionId, props.serverId) ?? null);
    if (!machineName) return null;
    const reachable = machineReachability === 'reachable';
    return (
        <ItemGroup>
            <Item
                testID="make-coordinator-machine"
                icon={<Icon name="desktop" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                title={reachable ? t('sessionCoordinator.make.machineOnline', { machine: machineName }) : t('sessionCoordinator.make.machineOffline', { machine: machineName })}
                titleLines={0}
                subtitle={reachable ? t('sessionCoordinator.make.machineOnlineDescription') : t('sessionCoordinator.make.machineOfflineDescription')}
                subtitleLines={0}
                mode="info"
                showChevron={false}
                rightElement={handoff.availability.available ? (
                    <RoundButton testID="make-coordinator-move" size="small" display="secondary"
                        title={t('sessionCoordinator.make.moveMachine')} onPress={() => { void handoff.run(); }} />
                ) : undefined}
            />
        </ItemGroup>
    );
}

export function showMakeCoordinatorDialog(params: Readonly<{ sessionId: string; serverId: string }>): void {
    Modal.show({ component: MakeCoordinatorDialog, props: params });
}

const styles = StyleSheet.create(() => ({
    list: { paddingTop: 0 },
    footer: { width: '100%' },
}));
