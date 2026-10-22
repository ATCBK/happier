import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import * as React from 'react';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { ShareSheet } from '../ShareSheet';
import type { ShareSheetPresentation } from '../shareSheetTypes';
import { createMachineShareAdapter } from './machineShareAdapter';
import { useMachineShareController } from './useMachineShareController';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

type MachineShareSheetProps = Readonly<{
    machineId: string; machineName: string; scope: ServerAccountScope; online: boolean | null;
    presentation: ShareSheetPresentation;
    onRequestClose?: () => void;
    testID: string;
}>;

/** The machine's one share sheet: the page's Sharing section and the "Share <machine>" sheet mount the same model. */
function ScopedMachineShareSheet(props: MachineShareSheetProps) {
    const controller = useMachineShareController(props);
    const router = useRouter();
    const adapter = createMachineShareAdapter({ machineName: props.machineName, online: props.online, controller,
        openApproval: artifactId => router.push(`/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(props.scope.serverId)}`),
    });
    return <ShareSheet model={controller.model} actions={controller.actions} adapter={adapter}
        presentation={props.presentation} onRequestClose={props.onRequestClose} testID={props.testID} />;
}

/** Scope changes discard no other host's state. */
function MachineShareSheet(props: MachineShareSheetProps) {
    return <ScopedMachineShareSheet key={`${props.scope.serverId}:${props.scope.accountId}:${props.machineId}`} {...props} />;
}

/** The machine page's Sharing section; its page (the Sharing sub-page) carries the title and the description. */
export function MachineSharingSection(props: Readonly<{
    machineId: string; machineName: string; scope: ServerAccountScope; online: boolean | null;
}>) {
    // The section's sheet is the share sheet's surface on every width: `full` would draw a second card inside it.
    // Its rows carry their own row inset, so the sheet sits directly in the card (lab m-share A/Ap: field, trust
    // block and people share one edge); a content row around it would inset everything twice.
    return <ItemGroup>
        <View testID="machine-detail-sharing">
            <MachineShareSheet {...props} presentation="inline" testID="machine-share-editor" />
        </View>
    </ItemGroup>;
}

type MachineShareModalProps = CustomModalInjectedProps & Readonly<{
    machineId: string; machineName: string; scope: ServerAccountScope; online: boolean | null;
}>;

function MachineShareModal(props: MachineShareModalProps) {
    const { onClose, setChrome: _setChrome, ...sheet } = props;
    const presence = useMachinePresenceSummary(props.scope.serverId, props.machineId);
    const { binding } = useServerCredentialAccountScopeBinding(props.scope.serverId);
    const online = !binding?.isCurrent() || binding.scope.accountId !== props.scope.accountId || presence.reachability === 'unknown'
        ? null : presence.reachability === 'reachable';
    return <MachineShareSheet {...sheet} online={online} presentation="full" onRequestClose={onClose} testID="machine-share-editor" />;
}

/** The machine's ⋯ → "Share <machine>": the same sheet at full presentation, with its search and Done (lab m-share S). */
export function showMachineShareSheet(params: Readonly<{
    machineId: string; machineName: string; scope: ServerAccountScope; online: boolean | null;
    /** What the machine is, for example "Linux · End-to-end encrypted". */
    subtitle?: string;
}>): void {
    const { subtitle, ...sheet } = params;
    Modal.show({
        component: MachineShareModal,
        props: sheet,
        chrome: {
            kind: 'card',
            phonePresentation: 'sheet',
            testID: 'machine-share-modal',
            title: t('shareSheet.documents.shareTitle', { name: params.machineName }),
            ...(subtitle ? { subtitle } : {}),
            scrollHost: 'bounded',
            bodyScroll: 'none',
            dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.92, size: 'md' },
        },
        closeOnBackdrop: true,
    });
}
