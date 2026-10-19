import * as React from 'react';
import { Platform, ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import { ApprovalPromptCard } from '@/components/tools/shell/approvals/ApprovalPromptCard';
import { ApprovalPromptRoomContext, shareApprovalPromptRoom, type ApprovalPromptCardHeights, type ApprovalPromptRoom } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { Typography } from '@/constants/Typography';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';

type AttentionRequest =
    | Readonly<{ kind: 'permission'; request: PendingPermissionRequest }>
    | Readonly<{ kind: 'approval'; request: OpenApprovalArtifactForSession }>;

function getAttentionRequestKey(request: AttentionRequest): string {
    switch (request.kind) {
        case 'permission':
            return request.request.id;
        case 'approval':
            return `approval:${request.request.artifact.id}`;
    }
}

// The tray's own spacing, which the requests' shared height leaves room for so the cards fit without a scroll.
const TRAY_BOTTOM_INSET_PX = 2;
const TRAY_DIVIDER_PX = 1;

const stylesheet = StyleSheet.create((theme) => ({
    permissionRequestsContainer: {
        // Cancel out AgentInput's `unifiedPanel` padding so this block can go edge-to-edge.
        marginHorizontal: -8,
        // Cancel out the panel's top padding so the chrome reaches the top edge.
        marginTop: -2,
    },
    permissionRequestTitle: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'semiBold'),
    },
    chrome: {
        borderTopLeftRadius: Platform.select({ default: 16, android: 20 }),
        borderTopRightRadius: Platform.select({ default: 16, android: 20 }),
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        overflow: 'hidden',
    },
    divider: {
        height: TRAY_DIVIDER_PX,
        backgroundColor: theme.colors.border.default,
        opacity: 1,
    },
}));

export const AgentInputPermissionRequests = React.memo(function AgentInputPermissionRequests(props: Readonly<{
    sessionId: string;
    permissionRequests: readonly PendingPermissionRequest[];
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    permissionLocationsById: ReadonlyMap<string, PermissionToolCallMessageLocation | null>;
    approvalLocationsByArtifactId?: ReadonlyMap<string, PermissionToolCallMessageLocation | null>;
    metadata: Metadata | null;
    canApprovePermissions: boolean;
    disabledReason?: TranscriptPermissionDisabledReason;
    maxHeightPx: number;
    onContentSizeChange: (width: number, height: number) => void;
    onLayout: (event: LayoutChangeEvent) => void;
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    fadeVisibility?: Readonly<{ top?: boolean; bottom?: boolean }>;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    const permissionRequests = props.disabledReason === 'inactive' ? [] : props.permissionRequests;
    const approvalRequests = props.approvalRequests ?? [];
    const attentionRequests = React.useMemo<AttentionRequest[]>(() => [
        ...permissionRequests.map((request) => ({ kind: 'permission' as const, request })),
        ...approvalRequests.map((request) => ({ kind: 'approval' as const, request })),
    ], [approvalRequests, permissionRequests]);
    const scrollStyle = React.useMemo(() => ({ maxHeight: props.maxHeightPx }), [props.maxHeightPx]);
    // The requests share the tray: each card reports the height it wants, and the room is divided so every
    // card's decision is in view at once (the shortest keep their height; the rest split what is left).
    const [cardHeights, setCardHeights] = React.useState<ReadonlyMap<string, ApprovalPromptCardHeights>>(() => new Map());
    const reportCardHeights = React.useCallback((cardId: string, heights: ApprovalPromptCardHeights | null) => setCardHeights((current) => {
        const previous = current.get(cardId);
        if (heights === null ? !previous : previous?.natural === heights.natural && previous.minimum === heights.minimum) return current;
        const next = new Map(current);
        if (heights === null) next.delete(cardId); else next.set(cardId, heights);
        return next;
    }), []);
    const room = React.useMemo<ApprovalPromptRoom>(() => {
        const available = props.maxHeightPx - TRAY_BOTTOM_INSET_PX - (attentionRequests.length - 1) * TRAY_DIVIDER_PX;
        // Until every card has reported, each gets an even part, so no decision starts out of view.
        const bounds = cardHeights.size === attentionRequests.length ? shareApprovalPromptRoom(available, cardHeights) : new Map<string, number>();
        return {
            boundFor: (cardId) => bounds.get(cardId) ?? Math.floor(available / Math.max(1, attentionRequests.length)),
            report: reportCardHeights,
        };
    }, [attentionRequests.length, cardHeights, props.maxHeightPx, reportCardHeights]);

    if (attentionRequests.length === 0) {
        return null;
    }

    return (
        <View style={styles.permissionRequestsContainer}>
            <View testID="agentInput.permissionRequests.chrome" style={styles.chrome}>
                <View style={{ position: 'relative' }}>
                    <ScrollView
                        testID="agentInput.permissionRequests.scroll"
                        style={scrollStyle}
                        contentContainerStyle={{ paddingBottom: TRAY_BOTTOM_INSET_PX }}
                        nestedScrollEnabled={true}
                        scrollEventThrottle={16}
                        showsVerticalScrollIndicator={false}
                        onContentSizeChange={props.onContentSizeChange}
                        onLayout={props.onLayout}
                        onScroll={props.onScroll}
                    >
                        {/* The requests share the tray: each card's facts scroll and its decision stays in view. */}
                        <ApprovalPromptRoomContext.Provider value={room}>
                        <View style={{ paddingTop: 0 }}>
                            {attentionRequests.map((item, index) => (
                                <React.Fragment key={getAttentionRequestKey(item)}>
                                    {index > 0 ? (
                                        <View
                                            testID={`agentInput.permissionRequests.divider:${getAttentionRequestKey(item)}`}
                                            style={styles.divider}
                                        />
                                    ) : null}
                                    {item.kind === 'permission' ? (
                                        <PermissionPromptCard
                                            chrome="inline"
                                            request={item.request}
                                            location={props.permissionLocationsById.get(item.request.id) ?? null}
                                            sessionId={props.sessionId}
                                            metadata={props.metadata}
                                            canApprovePermissions={props.canApprovePermissions}
                                            disabledReason={props.disabledReason}
                                        />
                                    ) : (
                                        <ApprovalPromptCard
                                            chrome="inline"
                                            artifact={item.request.artifact}
                                            approval={item.request.approval}
                                            location={props.approvalLocationsByArtifactId?.get(item.request.artifact.id) ?? null}
                                            sessionId={props.sessionId}
                                            metadata={props.metadata}
                                            canApprovePermissions={props.canApprovePermissions}
                                            disabledReason={props.disabledReason}
                                        />
                                    )}
                                </React.Fragment>
                            ))}
                        </View>
                        </ApprovalPromptRoomContext.Provider>
                    </ScrollView>

                    <ScrollEdgeFades
                        color={theme.colors.surface.elevated}
                        edges={{
                            top: props.fadeVisibility?.top === true,
                            bottom: props.fadeVisibility?.bottom === true,
                        }}
                    />
                    <ScrollEdgeIndicators
                        color={theme.colors.text.secondary}
                        edges={{
                            top: props.fadeVisibility?.top === true,
                            bottom: props.fadeVisibility?.bottom === true,
                        }}
                    />
                </View>
            </View>
        </View>
    );
});
