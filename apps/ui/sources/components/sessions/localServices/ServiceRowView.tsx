import * as React from 'react';
import { Platform, View } from 'react-native';
import { isLocalServiceStateRunningV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SURFACE_CARD_PADDING_PX, SURFACE_CARD_RADIUS_PX } from '@/components/ui/cards/SurfaceCard';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatMachineDuration } from '@/components/machines/durationWords';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { ServicesOpenInBrowserResult } from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import type { ServiceRow, ServiceRowStatus } from '@/sync/domains/local/services/serviceRow';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';
import type { TranslationKey } from '@/text/i18n';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { LocalServiceActionFailureNotice } from './LocalServiceActionFailureNotice';
import { useLocalServiceActionRunner } from './localServiceActionOutcome';
import type { LocalServiceActionInvocationOptions } from './localServiceActionAdmission';
import {
    copyLocalServiceAddress,
    formatLocalServiceRowAddress,
    hasUnsettledLocalServiceCustody,
    resolveLocalServiceEntryActions,
} from './localServiceEntryActions';
import {
    hasLocalServicePublicPreviewSurface,
    LocalServicePublicPreviewControls,
    LocalServiceShareLinkButton,
    resolveLocalServicePublicLinkOffer,
} from './LocalServicePublicPreviewControls';
import type { LocalServicePublicPreviewActions } from './publicPreviewActions';
import { ServiceMark } from './ServiceMark';
import { ServiceStatusDot } from './ServiceStatusDot';
import type { LocalServiceCapabilityDisabledReasons } from './useLocalServicePublicPreviewFeature';
import { useProjectServicePlacementObservation } from '@/components/projects/detail/services/projectServicePlacementObservation';

export type ServiceRowOpenHandler = (target: LocalServiceLaunchTarget) => ServicesOpenInBrowserResult | void | Promise<unknown>;
export type ServiceRowStartHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
export type ServiceRowTerminateHandler = (target: LocalServiceLaunchTarget, options?: LocalServiceActionInvocationOptions) => void | Promise<unknown>;
export type ServiceRowForgetHandler = (target: LocalServiceLaunchTarget) => void | Promise<unknown>;
/** Stop or Restart a managed lifetime through its exact occurrence; the result, not the press, settles the row. */
export type ServiceRowManagedControlHandler = (target: LocalServiceLaunchTarget, options?: LocalServiceActionInvocationOptions) => void | Promise<unknown>;
export type ServiceRowCopyUrlHandler = (
    target: LocalServiceLaunchTarget,
    value: string,
) => Promise<boolean>;

/** The gap between the expansion's controls, shared with their press frames. */
const ROW_ACTION_GAP_PX = 8;

const stylesheet = StyleSheet.create((theme) => ({
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    title: {
        flexShrink: 1,
        color: theme.colors.text.primary,
        fontWeight: '600',
    },
    /** A declaration that cannot start here: it keeps its row and says why, at a lower voice. */
    titleInert: {
        color: theme.colors.text.tertiary,
        fontWeight: '400',
    },
    statusLabel: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    statusLabelAttention: {
        color: theme.colors.state.attention.foreground,
    },
    facts: {
        gap: theme.space.s2,
        alignItems: 'flex-start',
    },
    /** Lead facts, the source badge, then the trailing facts on one line (lab s-services). */
    factsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s6,
        maxWidth: '100%',
    },
    /**
     * The lead (an address, a command) stays readable: when the pane is too narrow for the trailing
     * facts beside it (a phone), they wrap to their own line instead of cutting the address.
     */
    factsLead: {
        maxWidth: '100%',
    },
    factsTail: {
        flexShrink: 1,
    },
    badgeLabel: {
        ...Typography.mono(),
    },
    factsLine: {
        ...Typography.tabular(),
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    reasonText: {
        color: theme.colors.text.secondary,
    },
    /**
     * An open row is ONE filled tile (services lab O): the header, the action line and the live link
     * sit together on the selected surface, with no second bordered card inside it.
     */
    tile: {
        backgroundColor: theme.colors.surface.selected,
        borderRadius: SURFACE_CARD_RADIUS_PX,
        overflow: 'hidden',
    },
    expansion: {
        paddingBottom: theme.space.s4,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: ROW_ACTION_GAP_PX,
        paddingHorizontal: SURFACE_CARD_PADDING_PX.sm.horizontal,
        // Under the open row's header on the tile: the buttons start where the row's title does.
        paddingLeft: PAGE_LIST_METRICS.rowPaddingHorizontalPx + PAGE_LIST_METRICS.rowLeadingColumnPx + PAGE_LIST_METRICS.rowLeadingGapPx,
        paddingTop: 0,
        paddingBottom: SURFACE_CARD_PADDING_PX.sm.vertical,
    },
    /** First row of the pushed page's sheet: it keeps the sheet rows' inset and clears the sheet's top edge. */
    actionsInSheet: {
        paddingLeft: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingRight: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingTop: SURFACE_CARD_PADDING_PX.sm.vertical,
    },
    actionsSpacer: {
        flex: 1,
    },
}));

const STATUS_LABEL_KEYS: Readonly<Record<ServiceRowStatus, TranslationKey>> = {
    loading: 'common.loading',
    running: 'localServices.rowStatus.running',
    starting: 'localServices.rowStatus.starting',
    stopping: 'localServices.rowStatus.stopping',
    stale: 'localServices.rowStatus.stale',
    stopped: 'localServices.rowStatus.stopped',
    failed: 'localServices.rowStatus.failed',
    unavailable: 'localServices.rowStatus.unavailable',
};

/** A declaration nobody has started yet: it is Ready to start, so it carries no status word. */
function isNotStarted(row: ServiceRow): boolean {
    return row.status === 'stopped'
        && row.primaryAction?.kind === 'start'
        && row.target.serviceState === undefined;
}

/** Nothing to do with it here: no Start, no Open, not live. Its title steps back. */
function isInert(row: ServiceRow): boolean {
    return row.primaryAction === null && !hasUnsettledLocalServiceCustody(row)
        && (row.status === 'stopped' || row.status === 'unavailable' || row.status === 'failed');
}

/** The name, then the status in words beside its dot ("web ● Running"), as the lab draws it. */
function ServiceRowTitle(props: Readonly<{
    row: ServiceRow;
    operationText?: string | null;
    /** The machine stopped answering: the row shows what was last known, not a live status. */
    offline?: boolean;
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const unsettled = !props.offline && hasUnsettledLocalServiceCustody(props.row);
    const statusLabel = props.operationText ?? (props.offline
        ? t('localServices.rowStatus.lastKnown')
        : unsettled ? t('localServices.rowStatus.unknown') : t(STATUS_LABEL_KEYS[props.row.status]));
    const ready = !props.operationText && ((props.row.scope === 'suggestion' && props.row.status === 'stopped') || isNotStarted(props.row));
    return (
        <View style={styles.titleRow}>
            <Text style={[styles.title, isInert(props.row) ? styles.titleInert : null]} numberOfLines={1}>{props.row.title}</Text>
            {/* Unnamed: the status is the word beside it, so it is announced once. */}
            {!ready ? <ServiceStatusDot
                status={props.operationText || props.offline ? 'stale' : props.row.status}
                animationEnabled={props.animationEnabled}
                testID={`${props.testID}-dot`}
            /> : null}
            {!ready ? <Text testID={`${props.testID}-status-${props.operationText ? 'operation' : props.row.status}`} style={[styles.statusLabel, unsettled ? styles.statusLabelAttention : null]} numberOfLines={1}>
                {statusLabel}
            </Text> : null}
        </View>
    );
}

/**
 * The row's supporting facts: where it answers (or that it has no address), the file it is declared
 * in, what runs it and on which machine — plus the launcher's reason when the row cannot be acted on.
 * The address is text here; copying it is the expansion's job, so a collapsed row carries no
 * controls of its own. Lab `s-services`: `localhost:3005 · [project.json] on devbox`.
 */
function resolveRowFacts(row: ServiceRow, machineName: string | null, startedByName: string | null, unavailableMachineName: string | null): Readonly<{
    lead: readonly string[];
    tail: readonly string[];
    /** The tail is the reason the row cannot act (lab `db`: "Docker isn't available on devbox"). */
    tailReason: ReturnType<typeof resolveReasonCopy> | null;
    reason: ReturnType<typeof resolveReasonCopy> | null;
}> {
    const reason = row.status !== 'loading' && row.reasonCode
        ? resolveReasonCopy({ reasonCode: row.reasonCode, kind: 'localServiceLauncher', machineName: unavailableMachineName ?? undefined })
        : null;
    // Someone else's service names who started it (lab STATES 12); the viewer's own needs no byline.
    const on = startedByName
        ? machineName
            ? t('localServices.row.startedByOn', { name: startedByName, machine: machineName })
            : t('localServices.row.startedBy', { name: startedByName })
        : machineName ? t('localServices.row.onMachine', { machine: machineName }) : null;
    // Offline: the host says so once, with Check again; the row keeps its last-known facts under
    // a "Last known" status instead of repeating the outage on every row.
    if (row.status === 'starting') {
        return { lead: [machineName ? t('localServices.row.startingOn', { machine: machineName }) : t('localServices.rowStatus.starting')], tail: [], tailReason: null, reason };
    }
    if (row.addressNote === 'waiting') {
        return { lead: [t('localServices.row.waitingAddress')], tail: [], tailReason: null, reason };
    }
    if (isNotStarted(row) || isInert(row) || hasUnsettledLocalServiceCustody(row)) {
        const lead = [row.processLabel].filter((part): part is string => Boolean(part));
        if (row.status === 'failed') return { lead, tail: [t('localServices.row.failed')], tailReason: null, reason };
        if (reason) return { lead, tail: [reason.body], tailReason: reason, reason: null };
        // "Ready to start" already says it is not started: one quiet line, the command then the same
        // source chip a running row draws (lab s-services).
        return { lead, tail: [], tailReason: null, reason: null };
    }
    const address = row.addressLabel
        ?? formatLocalServiceRowAddress(row)?.replace(/^https?:\/\//, '').replace(/^127\.0\.0\.1(?=:)/, 'localhost')
        ?? row.portLabel
        ?? (row.addressNote === 'none' ? t('localServices.row.noAddress') : null);
    // Where it runs names the machine on a machine-scoped host; elsewhere the source says what it is.
    const where = row.scope === 'thisSession'
        ? t('localServices.session.thisSessionTitle')
        : on ?? (row.sourceBadge ? null : t(row.sourceLabel));
    // How long it has run, from the feed's own start time (lab `42 min`): read at render, no timer.
    const age = row.status === 'running' && typeof row.target.startedAtMs === 'number'
        ? formatMachineDuration(Date.now() - row.target.startedAtMs)
        : null;
    return {
        lead: [address].filter((part): part is string => Boolean(part)),
        tail: [row.serviceLabel ?? row.processLabel, where, age].filter((part): part is string => Boolean(part)),
        tailReason: null,
        reason,
    };
}

function ServiceRowFacts(props: Readonly<{
    row: ServiceRow;
    machineName: string | null;
    startedByName: string | null;
    unavailableMachineName: string | null;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { row } = props;
    const facts = resolveRowFacts(row, props.machineName, props.startedByName, props.unavailableMachineName);
    const badge = row.sourceBadge ?? null;
    const lead = facts.lead.join(' · ');
    const tail = facts.tail.join(' · ');
    // One line of facts: lead · [source badge] tail. Without a badge the separator joins lead and tail.
    const leadText = lead && (badge || tail) ? `${lead} ·` : lead;
    return (
        <View style={styles.facts}>
            <View testID={`${props.testID}-meta`} style={styles.factsRow}>
                {leadText ? <Text style={[styles.factsLine, tail || badge ? styles.factsLead : null]} numberOfLines={1}>{leadText}</Text> : null}
                {badge ? (
                    <StatusPill
                        testID={`${props.testID}-source`}
                        variant="neutral"
                        label={badge}
                        hideDot
                        labelStyle={styles.badgeLabel}
                    />
                ) : null}
                {tail ? (
                    <Text
                        testID={facts.tailReason ? `${props.testID}-reason` : undefined}
                        accessibilityHint={facts.tailReason?.diagnosticCode ?? undefined}
                        style={[styles.factsLine, styles.factsTail]}
                        // Facts stay one line (a narrow pane truncates them rather than breaking a
                        // machine name across lines); a reason keeps room for its sentence.
                        numberOfLines={facts.tailReason ? 2 : 1}
                    >
                        {tail}
                    </Text>
                ) : null}
            </View>
            {facts.reason ? (
                <Text
                    testID={`${props.testID}-reason`}
                    accessibilityHint={facts.reason.diagnosticCode ?? undefined}
                    style={styles.reasonText}
                    numberOfLines={2}
                >
                    {facts.reason.body}
                </Text>
            ) : null}
        </View>
    );
}

/**
 * Copy address, as the expansion's secondary action. One owner for "copy a local service URL": the
 * handler dispatches the audited `localServices.actions.copyUrl` where the row has a target the
 * action can address (G14), and a refused copy says so instead of failing silently.
 */
function CopyAddressButton(props: Readonly<{
    addressValue: string;
    target: LocalServiceLaunchTarget;
    onCopyServiceUrl?: ServiceRowCopyUrlHandler;
    testID: string;
}>): React.ReactElement {
    const copyFeedback = useHappierCopyFeedback();
    const { addressValue, onCopyServiceUrl, target } = props;
    const copyAddress = React.useCallback(() => {
        void (async () => {
            if (await copyLocalServiceAddress(target, addressValue, onCopyServiceUrl, setClipboardStringSafe)) {
                copyFeedback.markCopied('address');
            }
        })();
    }, [addressValue, copyFeedback, onCopyServiceUrl, target]);
    return (
        <>
            <RoundButton
                testID={`${props.testID}-copy-address`}
                size="small"
                display="secondary"
                title={t('localServices.pane.copyAddress')}
                accessibilityLabel={t('localServices.actions.copyAddressA11y')}
                onPress={copyAddress}
            />
            <CopiedPill
                visible={copyFeedback.isCopied('address')}
                testID={`${props.testID}-copy-address-feedback`}
            />
        </>
    );
}

export function ServiceRowView(props: Readonly<{
    row: ServiceRow;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    onStartLauncherTarget?: ServiceRowStartHandler;
    onTerminateDetectedService?: ServiceRowTerminateHandler;
    onForgetDetectedService?: ServiceRowForgetHandler;
    onStopManagedService?: ServiceRowManagedControlHandler;
    onRestartManagedService?: ServiceRowManagedControlHandler;
    onCopyServiceUrl?: ServiceRowCopyUrlHandler;
    /**
     * The openable instance already running on a port, other than this row. A start that collided
     * with this project's own listener offers it ("Open running web") instead of Retry.
     */
    findRunningOpenTarget?: (port: number, failedTarget: LocalServiceLaunchTarget) => LocalServiceLaunchTarget | null;
    /** The occurrence's actual Machine, independent of the pane's Source. */
    machineName?: string | null;
    unavailableMachineName?: string | null;
    /** The machine is unreachable: every fact on the row is last known. */
    offline?: boolean;
    /**
     * Who started this service, already named by the account name owner — and only when that is
     * someone other than the viewer. Never a name made from a bare id.
     */
    startedByName?: string | null;
    /**
     * Where the service runs next (plan 32 "Runs on" / "If it can't run there"), drawn by its
     * placement owner inside the expansion under the row's controls. The row only hosts it.
     */
    placement?: React.ReactNode;
    /** The row's live public link, shown only while it is expanded. */
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewActions?: LocalServicePublicPreviewActions;
    publicPreviewCapabilityDisabledReasons?: LocalServiceCapabilityDisabledReasons;
    /** One expanded row at a time is the pane's decision; the row only asks. */
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
    /**
     * Phone (lab PAGEp): the row pushes its detail instead of growing in place. `detail` draws that
     * pushed page: the same header and the same body, always open.
     */
    onOpenDetail?: () => void;
    pressableRef?: ItemProps['pressableRef'];
    presentation?: 'row' | 'detail';
    showDivider?: boolean;
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { row } = props;
    const declaration = row.target.declaration;
    const relocation = useProjectServicePlacementObservation(declaration?.selection.kind === 'manifest' ? declaration.selection.name : '',
        undefined, { declarationWorkspaceRefId: declaration?.workspaceRefId, absent: row.status === 'stopped',
            bindingPending: row.reasonCode === 'project_service_binding_pending',
            machineId: row.target.machineId,
            managedServiceId: row.target.sourceClass?.kind === 'managed_service' ? row.target.sourceClass.managedServiceId : undefined });
    const recoverable = relocation.stoppedBeforeStart;
    const operationActive = relocation.active || relocation.awaitingBinding;
    const operationText = recoverable ? t('localServices.rowStatus.stopped') : operationActive ? relocation.progressText : null;
    // A refused action reads in place under its own row, never in a dialog over the page.
    const runner = useLocalServiceActionRunner({ presentation: 'inline',
        observedNativeBinding: row.target.sourceClass?.kind === 'managed_service'
            && isLocalServiceStateRunningV1(row.target.serviceState) && !hasUnsettledLocalServiceCustody(row) });
    const primary = row.primaryAction;
    // The one decision of what this entry offers, shared with the Processes port menu (plan 30 RU-3).
    const offered = resolveLocalServiceEntryActions(row, props);
    const canOpen = !operationActive && offered.open !== null;
    const canStart = !operationActive && !runner.failure?.awaitingNativeStart && offered.start !== null;
    const startLabel = t('localServices.actions.startA11y');
    const canTerminate = !operationActive && offered.terminateDetected;
    const canForget = offered.forget;
    const canStop = !operationActive && offered.stopManaged;
    const canRestart = !operationActive && offered.restartManaged;
    const addressValue = operationActive ? null : offered.address;

    /**
     * Two pending ids for one row, because feedback belongs where the user acted.
     *
     * An inline action has a control the user is looking at, and the button already owns that
     * control's pending state. An overflow action has no visible control by the time it runs: the
     * popover has closed, so the ROW is the only place left to say "working". Sharing one id would
     * put both spinners on screen for the same dispatch.
     */
    const inlinePendingId = `${row.id}:inline`;
    const startPendingId = `${row.id}:start`;
    const menuPendingId = `${row.id}:menu`;

    const handleOpen = React.useCallback(async () => {
        if (primary?.kind !== 'open') return undefined;
        return await runner.run({
            id: inlinePendingId,
            failureTitle: t('localServices.actions.failureTitle.open', { service: row.title }),
            action: async () => props.onOpenServiceInBrowser?.(primary.openTarget),
        });
    }, [inlinePendingId, primary, props, row.title, runner]);

    const handleStart = React.useCallback(() => {
        if (!canStart || primary?.kind !== 'start') return undefined;
        if (recoverable) relocation.clear();
        return runner.run({
            id: startPendingId,
            failureTitle: t('localServices.actions.failureTitle.start', { service: row.title }),
            observeNativeStart: true,
            action: async () => props.onStartLauncherTarget?.(primary.target),
        });
    }, [canStart, startPendingId, primary, props, recoverable, relocation.clear, row.title, runner]);

    const handleTerminate = React.useCallback(() => {
        void (async () => {
            if (!props.onTerminateDetectedService) return;
            await runner.run({
                id: menuPendingId,
                failureTitle: t('localServices.actions.failureTitle.terminate', { service: row.title }),
                action: async () => props.onTerminateDetectedService?.(row.target),
            });
        })();
    }, [menuPendingId, props, row.target, row.title, runner]);

    const handleStop = React.useCallback(() => {
        void (async () => {
            if (!props.onStopManagedService) return;
            await runner.run({
                id: menuPendingId,
                failureTitle: t('localServices.actions.failureTitle.stop', { service: row.title }),
                action: async () => props.onStopManagedService?.(row.target),
            });
        })();
    }, [menuPendingId, props, row.target, row.title, runner]);

    const handleRestart = React.useCallback(() => {
        void runner.run({
            id: menuPendingId,
            failureTitle: t('localServices.actions.failureTitle.restart', { service: row.title }),
            action: async () => props.onRestartManagedService?.(row.target),
        });
    }, [menuPendingId, props, row.target, row.title, runner]);

    const handleForget = React.useCallback(() => {
        void (async () => {
            if (!props.onForgetDetectedService) return;
            await runner.run({
                id: menuPendingId,
                failureTitle: t('localServices.actions.failureTitle.forget', { service: row.title }),
                action: async () => props.onForgetDetectedService?.(row.target),
            });
        })();
    }, [menuPendingId, props, row.target, row.title, runner]);

    // A start that collided with this project's own running instance points at it instead of repeating itself.
    const failure = runner.failure;
    const collision = failure?.establishmentFailure;
    const runningTarget = collision?.cause === 'port_in_use' && collision.sameProject && collision.port !== undefined
        ? props.findRunningOpenTarget?.(collision.port, row.target) ?? null : null;
    const failureNotice = failure ? (
        <LocalServiceActionFailureNotice
            testID={`${props.testID}-failure`}
            failure={failure}
            nextAction={runningTarget ? {
                label: t('localServices.actions.failure.openRunning', { service: row.title }),
                onPress: () => {
                    void runner.run({
                        id: inlinePendingId,
                        failureTitle: t('localServices.actions.failureTitle.open', { service: row.title }),
                        action: async () => props.onOpenServiceInBrowser?.(runningTarget),
                    });
                },
            } : null}
            onDismiss={runner.dismissFailure}
        />
    ) : null;

    /**
     * Destructive and secondary actions live in the expansion's overflow (U-11): naming the
     * consequence in a menu is safer and calmer than two red glyphs side by side, and
     * `ItemRowActions` already carries the destructive tone, the press frame and the popover.
     */
    const overflowActions = React.useMemo((): ItemAction[] => {
        const actions: ItemAction[] = [];
        if (canRestart) {
            actions.push({
                id: 'restart',
                title: t('localServices.actions.restartTitle'),
                icon: 'arrow-clockwise',
                onPress: handleRestart,
            });
        }
        if (canStop) {
            actions.push({
                id: 'stop',
                title: t('localServices.actions.stopConfirmCta'),
                icon: 'stop',
                destructive: true,
                onPress: handleStop,
            });
        }
        if (canTerminate) {
            actions.push({
                id: 'terminate',
                title: t('localServices.actions.terminateConfirmCta'),
                // The identity confidence belongs to the decision, not to a permanent grey line.
                ...(row.terminateIdentityConfidence === 'pid_only'
                    ? { subtitle: t('localServices.actions.terminatePidOnlyConfidence') }
                    : {}),
                icon: 'x-circle',
                destructive: true,
                onPress: handleTerminate,
            });
        }
        if (canForget) {
            actions.push({
                id: 'forget',
                title: t('localServices.actions.forgetA11y'),
                icon: 'eye-slash',
                onPress: handleForget,
            });
        }
        return actions;
    }, [canForget, canRestart, canStop, canTerminate, handleForget, handleRestart, handleStop, handleTerminate, row.terminateIdentityConfidence]);

    const minimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const pending = runner.pendingId === menuPendingId;
    // A row that can only be started (a package script) or not acted on at all has nothing to
    // grow into: it stays a plain row, with ▶ as its one control.
    const hasPublicLink = !operationActive && Boolean(props.publicPreviewState && props.publicPreviewActions)
        && hasLocalServicePublicPreviewSurface(row.target);
    // A row grows only into what it has to show: its address, its link, where it runs (plan 32: Runs
    // on is reachable on every service, stopped or address-less). A live service with no address — a
    // queue worker — keeps its overflow on the row itself (lab s-services `jobs`).
    const hasPlacement = props.placement !== undefined && props.placement !== null && props.placement !== false;
    const expandable = canOpen || Boolean(addressValue) || hasPublicLink || hasPlacement;
    const expanded = expandable && props.expanded === true;
    const onExpandedChange = props.onExpandedChange;

    const offline = props.offline === true;
    const machineName = props.machineName ?? null;
    // While its own Start is in flight the row reads as Starting (lab STATES 1), then returns to what the feed says.
    const shown = runner.pendingId === startPendingId && row.status !== 'running' ? { ...row, status: 'starting' as const } : row;
    const title = <ServiceRowTitle row={shown} operationText={operationText} offline={offline} animationEnabled={props.animationEnabled} testID={props.testID} />;
    const subtitle = operationActive ? undefined : <ServiceRowFacts row={shown} machineName={machineName} startedByName={props.startedByName ?? null}
        unavailableMachineName={props.unavailableMachineName ?? null} testID={props.testID} />;
    const identity = <ServiceMark row={row} testID={`${props.testID}-identity`} />;
    // One tap: a running row's signature action sits on the row itself, like ▶ on a row that can be
    // started (services lab O, H-UX F-8). Pressing the row still grows it into what you do less often.
    const openControl = canOpen ? (
        <IconButton
            testID={`${props.testID}-open`}
            iconName="arrow-square-out"
            variant="plain"
            accessibilityLabel={t('localServices.actions.openA11y', { service: row.title })}
            tooltip={t('common.open')}
            minimumInteractiveTargetSize={minimumTargetSize}
            animationEnabled={props.animationEnabled}
            onPress={handleOpen}
        />
    ) : null;
    const startControl = canStart ? (
        <IconButton
            testID={`${props.testID}-start`}
            iconName="play"
            variant="plain"
            accessibilityLabel={startLabel}
            tooltip={startLabel}
            minimumInteractiveTargetSize={minimumTargetSize}
            animationEnabled={props.animationEnabled}
            onPress={handleStart}
        />
    ) : null;

    const overflowControl = overflowActions.length > 0 ? (
        <ItemRowActions
            title={row.title}
            actions={overflowActions}
            // Always compact: every action here is secondary or destructive.
            compactThreshold={Number.POSITIVE_INFINITY}
            compactActionIds={[]}
            overflowTriggerTestID={`${props.testID}-overflow`}
            gap={ROW_ACTION_GAP_PX}
        />
    ) : null;


    // With no address to copy and no Open or ▶ on the row, the overflow stays on the row (lab `jobs`).
    const overflowOnRow = !addressValue && !openControl && !startControl;
    const rowControl = openControl ?? startControl ?? (overflowOnRow ? overflowControl : null);
    // "Share a link" sits in the action line beside Copy address (services lab O); an issued link and
    // the reasons a link cannot be made are the public-preview block's below it.
    const shareOffer = !operationActive && props.publicPreviewActions
        ? resolveLocalServicePublicLinkOffer({
            state: props.publicPreviewState,
            launchTarget: row.target,
            capabilityDisabledReasons: props.publicPreviewCapabilityDisabledReasons,
        })
        : null;
    const shareControl = shareOffer?.kind === 'create' && props.publicPreviewActions ? (
        <LocalServiceShareLinkButton
            testID={`${props.testID}-share`}
            offer={shareOffer}
            actions={props.publicPreviewActions}
        />
    ) : null;
    const actionBar = addressValue || shareControl || (overflowControl && !overflowOnRow) ? (
        <View style={[styles.actions, props.presentation === 'detail' ? styles.actionsInSheet : null]}>
            {addressValue ? (
                <CopyAddressButton
                    addressValue={addressValue}
                    target={row.target}
                    onCopyServiceUrl={props.onCopyServiceUrl}
                    testID={props.testID}
                />
            ) : null}
            {shareControl}
            <View style={styles.actionsSpacer} />
            {overflowOnRow ? null : overflowControl}
        </View>
    ) : null;
    // One body for the desktop expansion and the phone's pushed detail; only the container differs.
    const body = (
        <View testID={`${props.testID}-expansion`} style={styles.expansion}>
            {actionBar}
            {props.placement}
            <LocalServicePublicPreviewControls
                launchTargets={operationActive ? [] : [row.target]}
                state={operationActive ? null : props.publicPreviewState}
                actions={operationActive ? undefined : props.publicPreviewActions}
                capabilityDisabledReasons={props.publicPreviewCapabilityDisabledReasons}
                shareInActionLine
                testID={`${props.testID}-public-preview`}
            />
        </View>
    );

    if (props.presentation === 'detail') {
        return (
            <View testID={props.testID}>
                <Item
                    testID={`${props.testID}-item`}
                    title={title}
                    icon={identity}
                    subtitle={subtitle}
                    subtitleLines={2}
                    mode="info"
                    showChevron={false}
                    showDivider={false}
                    loading={pending}
                    rightElement={rowControl}
                />
                {failureNotice}
                {/* The pushed page is a page: its detail sits on the shared sheet (lab PAGEp), not on the
                    selection tint that marks an open row inside a list. */}
                <ItemGroup header="none">{body}</ItemGroup>
            </View>
        );
    }

    const onOpenDetail = props.onOpenDetail;
    if (expandable && onOpenDetail) {
        return (
            <View testID={props.testID}>
                <Item
                    testID={`${props.testID}-item`}
                    title={title}
                    icon={identity}
                    subtitle={subtitle}
                    subtitleLines={2}
                    showDivider={props.showDivider}
                    loading={pending}
                    onPress={onOpenDetail}
                    pressableRef={props.pressableRef}
                    rightElement={rowControl}
                    // Open, ▶ and a worker's overflow are their own buttons: never nest them in the row's press.
                    rightElementOutsidePressable={rowControl !== null}
                />
                {failureNotice}
            </View>
        );
    }

    if (!expandable || !onExpandedChange) {
        return (
            <View testID={props.testID}>
                <Item
                    testID={`${props.testID}-item`}
                    title={title}
                    icon={identity}
                    subtitle={subtitle}
                    subtitleLines={2}
                    mode="info"
                    showChevron={false}
                    showDivider={props.showDivider}
                    loading={pending}
                    rightElement={openControl ?? startControl ?? overflowControl}
                />
                {failureNotice}
            </View>
        );
    }

    return (
        <View testID={props.testID} style={expanded ? styles.tile : null}>
            <ExpandableItem
                expanded={expanded}
                onExpandedChange={onExpandedChange}
                showDivider={props.showDivider}
                header={({ headerProps }) => (
                    <Item
                        {...headerProps}
                        testID={`${props.testID}-item`}
                        title={title}
                        icon={identity}
                        subtitle={subtitle}
                        subtitleLines={2}
                        loading={pending}
                        rightElement={rowControl}
                        // Open, ▶ and a worker's overflow are their own buttons: never nest them in the row's press.
                        rightElementOutsidePressable={rowControl !== null}
                    />
                )}
            >
                {/* The disclosure mounts this only while open (and through its collapse). */}
                {body}
            </ExpandableItem>
            {failureNotice}
        </View>
    );
}
