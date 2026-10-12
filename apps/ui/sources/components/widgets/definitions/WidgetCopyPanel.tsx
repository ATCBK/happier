import * as React from 'react';
import type { View } from 'react-native';
import type { JsonValue } from '@happier-dev/protocol';
import { isWidgetTargetHostableV1, projectWidgetBindingInputV1, readWidgetDefinitionNetworkOverrideV1,
    type WidgetDefinitionV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { WidgetSetupStep } from '@/components/widgets/add/WidgetSetupStep';
import { WidgetFlowPanel } from '@/components/widgets/flow/WidgetFlowPanel';
import { listWidgetGroupProjects, resolveWidgetGroupCopyDestinations, WidgetCopyDestinationMenu } from '@/components/widgets/group/widgetGroupCopy';
import { useWidgetInstanceDescriptor } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { WidgetSetupPreview } from '@/components/widgets/surface/WidgetSetupPreview';
import { buildWidgetCandidateSetup, widgetProvidedContext, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { randomUUID } from '@/platform/randomUUID';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { runWidgetDefinitionCommand } from './widgetDefinitionCommands';

/** The copy's candidate and the places that can host it: never where it already is. */
function useWidgetCopyTarget(instance: WidgetInstanceV1, current: WidgetSurfaceRefV1) {
    const runtime = useAppShellPluginUiProjection();
    const installed = React.useMemo(() => readWidgetDescriptor(runtime.pluginUiProjection, instance.definition), [runtime.pluginUiProjection, instance.definition]);
    const candidate = useWidgetInstanceDescriptor(current, instance, installed);
    const refs = useWorkspaceRefs();
    const destinations = React.useMemo(() => resolveWidgetGroupCopyDestinations({ current,
        projects: listWidgetGroupProjects(refs, current.serverId) })
        .filter(destination => candidate && isWidgetTargetHostableV1(candidate, destination.surface.owner.kind)), [candidate, current, refs]);
    return { candidate, destinations };
}

/**
 * Add to… for one widget, step one: the same chooser a group uses (lab wgmenu C/M), anchored to the
 * card's ⋯. Choosing a place moves on to the copy's setup; it never adds by itself, because the
 * destination may need inputs the source page supplied. Mounted only while open.
 */
export function WidgetCopyChooser(props: Readonly<{
    instance: WidgetInstanceV1;
    current: WidgetSurfaceRefV1;
    anchorRef: React.RefObject<View | null>;
    onChoose: (destinationKey: string) => void;
    onClose: () => void;
    testID: string;
}>) {
    const { destinations } = useWidgetCopyTarget(props.instance, props.current);
    const { onChoose } = props;
    return <WidgetCopyDestinationMenu destinations={destinations} anchorRef={props.anchorRef}
        onChoose={destination => onChoose(destination.key)} onClose={props.onClose} testID={`${props.testID}.destination`} />;
}

/**
 * Add to… step two: the chosen place's setup, with the source's resolved inputs copied in rather
 * than its context promises; the destination's setup owns rebinding. Back returns to the chooser.
 */
export function WidgetCopyPanel(props: Readonly<{
    instance: WidgetInstanceV1;
    current: WidgetSurfaceRefV1;
    destinationKey: string;
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    onBack: () => void;
    onClose: () => void;
    testID: string;
}>) {
    const { candidate, destinations } = useWidgetCopyTarget(props.instance, props.current);
    // This open flow retains an acknowledged library copy when destination placement is refused.
    const promoted = React.useRef<WidgetDefinitionV1 | null>(null);
    const phone = useDeviceType() === 'phone';
    const destination = destinations.find(entry => entry.key === props.destinationKey);
    if (!candidate || !destination) return (
        <WidgetFlowPanel title={t('widgetFrame.groupAddTo')} onBack={props.onBack} onCancel={props.onClose} testID={props.testID}
            note={t('widgetDefinition.aboutUnavailable')}>{null}</WidgetFlowPanel>
    );
    const owner = destination.surface.owner;
    const context: WidgetSurfaceContext = owner.kind === 'project' ? { slots: {
        projects: { label: t('widgetAdd.thisProject'), value: { value: [owner.projectId], label: destination.label } },
    } } : {};
    const copiedInput = projectWidgetBindingInputV1({ instance: props.instance, fields: candidate.inputs?.fields ?? [],
        context: props.providedContext, viewerValues: {} });
    const providedContext = widgetProvidedContext(context);
    const setup = buildWidgetCandidateSetup({ candidate, context, audience: 'personal', scope: destination.surface,
        mode: { kind: 'add', submitLabel: t('widgetAdd.areaAddTo', { surface: destination.label }), copiedInput },
        submit: async draft => {
            const sourceOwner = props.current.owner;
            if (sourceOwner.kind === 'sessionBoard' && !promoted.current) {
                const saved = await runWidgetDefinitionCommand('widgets.definition.saveFromSession', () => ({
                    account: { serverId: props.current.serverId, accountId: props.current.accountId },
                    session: { serverId: props.current.serverId, sessionId: sourceOwner.sessionId },
                    itemId: props.instance.id, artifactId: randomUUID(),
                }), props.current);
                if (saved.kind === 'approvalPending') return { ok: true, approvalPending: true };
                if (saved.kind === 'refused') return { ok: false, message: t('widgetDefinition.saveFailed') };
                promoted.current = saved.result.definition;
            }
            const definition = promoted.current;
            const { networkOverride: _sourceNetworkOverride, ...sourceInstance } = props.instance;
            const networkOverride = definition ? readWidgetDefinitionNetworkOverrideV1(definition) : undefined;
            const outcome = await runWidgetDefinitionCommand('widgets.item.add', () => ({ surface: destination.surface,
                instance: definition ? { ...sourceInstance, id: randomUUID(), definition: { kind: 'artifact', artifactId: definition.id },
                    bindings: draft.bindings, ...(networkOverride ? { networkOverride } : {}) }
                    : { ...props.instance, id: randomUUID(), bindings: draft.bindings },
                ...(destination.area ? { area: destination.area } : {}), ...(draft.size ? { size: draft.size } : {}) }), destination.surface);
            return outcome.kind === 'refused' ? { ok: false, message: t(definition ? 'widgetDefinition.savedButNotPlaced' : 'widgetAdd.addFailed') }
                : { ok: true, ...(outcome.kind === 'approvalPending' ? { approvalPending: true } : {}) };
        },
        renderPreview: ({ draft }) => <WidgetSetupPreview scope={destination.surface} providedContext={providedContext}
            candidate={candidate} draft={draft} testID={`${props.testID}.preview`} />,
    });
    return <WidgetSetupStep key={destination.key} setup={setup} phone={phone} onBack={props.onBack}
        onCancel={props.onClose} onDone={result => {
            publishPresentationNotice({ key: `widget-copy:${props.instance.id}`, severity: 'info', message: result.approvalPending
                ? `${promoted.current ? `${t('widgetDefinition.savedButNotPlaced')} ` : ''}${t('widgetAdd.areaApprovalPending')}`
                : t('widgetAdd.justAdded', { widget: props.instance.displayName ?? candidate.title }) });
            props.onClose();
        }} serverId={props.current.serverId} testID={`${props.testID}.setup`} />;
}
