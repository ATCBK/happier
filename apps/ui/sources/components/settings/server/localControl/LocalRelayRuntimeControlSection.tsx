import * as React from 'react';
import { View } from 'react-native';

import { SystemTaskProgressCard } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { useLocalRelayRuntimeControl } from './useLocalRelayRuntimeControl';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { fireAndForget } from '@/utils/system/fireAndForget';

function resolveStatusSubtitle(status: ReturnType<typeof useLocalRelayRuntimeControl>['status']): string {
    if (!status) {
        return t('settings.localRelayRuntime.statusChecking');
    }
    if (!status.installed) {
        return t('settings.localRelayRuntime.statusNotInstalled');
    }
    if (status.service.active !== true) {
        return t('settings.localRelayRuntime.statusStopped');
    }
    return status.healthy
        ? t('settings.localRelayRuntime.statusRunningHealthy')
        : t('settings.localRelayRuntime.statusRunningNeedsAttention');
}

type LocalRelayRuntimeControlSectionProps = Readonly<{
    runner?: SystemTaskRunner;
    controller?: ReturnType<typeof useLocalRelayRuntimeControl>;
    onStatusChange?: (status: ReturnType<typeof useLocalRelayRuntimeControl>['status']) => void;
    showProgress?: boolean;
}>;

function OwnedLocalRelayRuntimeControlSection(props: LocalRelayRuntimeControlSectionProps) {
    const router = useRouter();
    const controller = useLocalRelayRuntimeControl({ ...(props.runner ? { runner: props.runner } : {}) });
    return <>
        <LocalRelayRuntimeControlSectionContent {...props} controller={controller} />
        {controller.approval.approvalPending && controller.approval.approvalId && controller.actionServerId ? <ItemGroup>
            <ActionApprovalPendingNotice message={t('secrets.catalog.approvalPending')}
                onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(controller.approval.approvalId!)}?serverId=${encodeURIComponent(controller.actionServerId)}`)} />
        </ItemGroup> : null}
    </>;
}

const LocalRelayRuntimeControlSectionContent = React.memo(function LocalRelayRuntimeControlSectionContent(props: LocalRelayRuntimeControlSectionProps & Readonly<{
    controller: ReturnType<typeof useLocalRelayRuntimeControl>;
}>) {
    const {
        activeTaskSnapshot,
        cancelTask,
        installOrUpdate,
        isBusy,
        isUnavailable,
        lastErrorMessage,
        refreshStatus,
        startRelay,
        status,
        stopRelay,
    } = props.controller;
    const canStart = !isUnavailable && status?.installed === true && status.service.active !== true && !isBusy;
    const canStop = !isUnavailable && status?.service.active === true && !isBusy;
    const cancel = React.useCallback(() => {
        if (!activeTaskSnapshot) {
            return;
        }
        fireAndForget(cancelTask(activeTaskSnapshot.taskId), { tag: 'LocalRelayRuntimeControlSection.cancel' });
    }, [activeTaskSnapshot, cancelTask]);

    React.useEffect(() => {
        props.onStatusChange?.(status);
    }, [props.onStatusChange, status]);

    return (
        <>
            <ItemGroup
                title={t('settings.localRelayRuntime.title')}
                description={t('settings.localRelayRuntime.footer')}
            >
                <Item
                    testID="settings.localRelayRuntime.status"
                    title={t('settings.localRelayRuntime.statusTitle')}
                    subtitle={isUnavailable ? t('settings.systemTaskBridgeUnavailable') : resolveStatusSubtitle(status)}
                    showChevron={false}
                    mode="info"
                />
                {status?.version ? (
                    <Item
                        title={t('settings.localRelayRuntime.versionTitle')}
                        subtitle={status.version}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {status?.relayUrl ? (
                    <Item
                        testID="settings.localRelayRuntime.relayUrl"
                        title={t('settings.localRelayRuntime.relayUrlTitle')}
                        subtitle={status.relayUrl}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                <Item
                    testID="settings.localRelayRuntime.installOrUpdate"
                    title={t('settings.localRelayRuntime.installOrUpdateAction')}
                    onPress={() => {
                        void installOrUpdate();
                    }}
                    disabled={isBusy || isUnavailable}
                />
                <Item
                    testID="settings.localRelayRuntime.start"
                    title={t('settings.localRelayRuntime.startAction')}
                    onPress={() => {
                        void startRelay();
                    }}
                    disabled={!canStart}
                />
                <Item
                    testID="settings.localRelayRuntime.stop"
                    title={t('settings.localRelayRuntime.stopAction')}
                    onPress={() => {
                        void stopRelay();
                    }}
                    disabled={!canStop}
                />
                <Item
                    title={t('settings.localRelayRuntime.refreshAction')}
                    onPress={() => {
                        void refreshStatus();
                    }}
                    disabled={isBusy || isUnavailable}
                />
                {lastErrorMessage ? (
                    <Item
                        title={t('common.error')}
                        subtitle={lastErrorMessage}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
            </ItemGroup>
            {activeTaskSnapshot && props.showProgress !== false ? (
                <SystemTaskProgressCard
                    title={t('settings.localRelayRuntime.progressTitle')}
                    snapshot={activeTaskSnapshot}
                    onCancel={cancel}
                />
            ) : null}
        </>
    );
});

export const LocalRelayRuntimeControlSection = React.memo(function LocalRelayRuntimeControlSection(props: LocalRelayRuntimeControlSectionProps) {
    if (props.controller) {
        return <LocalRelayRuntimeControlSectionContent {...props} controller={props.controller} />;
    }
    return <OwnedLocalRelayRuntimeControlSection {...props} />;
});
