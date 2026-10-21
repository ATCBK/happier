import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { View, ScrollView, useWindowDimensions } from 'react-native';
import { ToolCall, Message } from "@happier-dev/session-core/messages";
import { CodeView } from '@/components/ui/media/CodeView';
import { resolveCodeMonoFontFamily } from '@/components/ui/code/codeTypography';
import { Metadata } from '@happier-dev/session-core/state';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import { getToolViewComponent } from '@/components/tools/renderers/core/_registry';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { StructuredResultView } from '@/components/tools/renderers/system/StructuredResultView';
import { normalizeToolCallForRendering } from "@happier-dev/session-core/tools";
import { PermissionFooter } from '../permissions/PermissionFooter';
import { useSetting } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { Text, TextSelectabilityScope } from '@/components/ui/text/Text';
import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';
import { resolvePermissionPromptSurface, shouldShowGenericPermissionPromptForRequest } from '@/utils/sessions/permissions/permissionPromptPolicy';
import {
    isSidechainHydrationPendingStatus,
    useEnsureSidechainsLoaded,
} from '@/hooks/session/useEnsureSidechainsLoaded';
import { ChainTranscriptList } from '@/components/sessions/transcript/ChainTranscriptList';
import { SessionTranscriptSourceProvider, useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { createAppSidechainHistoryLoader } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { resolveToolTranscriptSidechainId } from './resolveToolTranscriptSidechainId';
import {
    SidechainHydrationInlineStatus,
    shouldShowSidechainHydrationInlineStatus,
} from './SidechainHydrationInlineStatus';
import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';
import { resolveInactiveSessionToolCallFailure } from '../permissions/resolveInactiveSessionToolCallFailure';
import { ToolError } from '@/components/tools/shell/presentation/ToolError';
import { resolveToolPermissionTerminalErrorMessage } from '../permissions/resolveToolPermissionTerminalErrorMessage';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { Icon } from '@/components/ui/icons/Icon';
import { useHistoricalTranscriptAgentId } from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';


interface ToolFullViewProps {
    tool: ToolCall;
    owningMessageId: string;
    sessionId?: string;
    /** Exact Home for the sidechain transcript and its pending-message authorship. */
    serverId?: string | null;
    metadata?: Metadata | null;
    messages?: Message[];
    jumpChildId?: string | null;
    forcePermissionFooterInTranscript?: boolean;
    interaction?: TranscriptInteraction;
    /**
     * Exact-target pending/discarded rows for this sidechain, resolved by the
     * canonical pending owner. They render inside the transcript projection with
     * the ordinary pending-to-committed crossover, never as a footer.
     */
    pendingMessages?: readonly PendingMessage[] | null;
    discardedMessages?: readonly DiscardedPendingMessage[] | null;
    /** The exact destination those rows belong to; omitted means the main Session. */
    pendingRecipient?: PendingMessage['recipient'];
}

export function ToolFullView(props: ToolFullViewProps) {
    const source = useSessionTranscriptSource();
    // Full detail is already the tool's destination. Keep its Session actions,
    // but do not stack another full-detail destination from nested tool rows.
    const detailSource = React.useMemo(() => ({ ...source, navigate: null }), [source]);
    return <SessionTranscriptSourceProvider source={detailSource}><ToolFullViewContent {...props} /></SessionTranscriptSourceProvider>;
}

function ToolFullViewContent({ tool, owningMessageId, sessionId, serverId, metadata, messages = [], jumpChildId, forcePermissionFooterInTranscript = false, pendingMessages, discardedMessages, pendingRecipient }: ToolFullViewProps) {
    const source = useSessionTranscriptSource();
    const interaction = source.useInteraction();
    const { theme } = useUnistyles();
    // This view opens one historical row on its own screen, so the row's own
    // Agent — published by the opener — outranks the Session's current one.
    const historicalAgentId = useHistoricalTranscriptAgentId();
    // Composed at render time: the module-scope stylesheet evaluates once, so a
    // baked-in `layout.maxWidth` would freeze the user's content-width preference.
    const contentMaxWidthStyle = useLayoutMaxWidthStyle();
    const toolForRendering = React.useMemo<ToolCall>(() => {
        return resolveInactiveSessionToolCallFailure({
            tool: normalizeToolCallForRendering(tool),
            permissionDisabledReason: interaction?.permissionDisabledReason,
        });
    }, [interaction?.permissionDisabledReason, tool]);

    const permissionTerminalErrorMessage = React.useMemo(() => {
        return resolveToolPermissionTerminalErrorMessage({
            tool: toolForRendering,
            metadata: metadata ?? null,
            permissionDisabledReason: interaction?.permissionDisabledReason,
            historicalAgentId,
        });
    }, [historicalAgentId, interaction?.permissionDisabledReason, metadata, toolForRendering]);

    const permissionTerminalError = permissionTerminalErrorMessage ? (
        <TextSelectabilityScope selectable>
            <ToolError message={permissionTerminalErrorMessage} />
        </TextSelectabilityScope>
    ) : null;

    const normalizedJumpChildId = typeof jumpChildId === 'string' && jumpChildId.length > 0 ? jumpChildId : null;

    const normalizedToolName = React.useMemo(() => {
        return resolveToolHeaderTextPresentation({ tool: toolForRendering, metadata: metadata ?? null }).normalizedToolName;
    }, [metadata, toolForRendering]);

    const transcriptSidechainId = React.useMemo(() => {
        return resolveToolTranscriptSidechainId({ tool: toolForRendering, normalizedToolName });
    }, [normalizedToolName, toolForRendering]);
    const isSubAgentTranscriptTool = isSubAgentTranscriptToolName(normalizedToolName);

    const sidechainHydration = useEnsureSidechainsLoaded({
        enabled:
            typeof sessionId === 'string' &&
            sessionId.length > 0 &&
            isSubAgentTranscriptTool && source.loadSidechain !== null,
        sessionId,
        sidechainIds: [transcriptSidechainId],
        loadSidechain: source.loadSidechain,
    });
    const sidechainHydrationStatus = transcriptSidechainId
        ? sidechainHydration.bySidechainId[transcriptSidechainId]?.status ?? sidechainHydration.status
        : sidechainHydration.status;
    const showSidechainLoading =
        isSubAgentTranscriptTool &&
        messages.length === 0 &&
        isSidechainHydrationPendingStatus(
            transcriptSidechainId ? sidechainHydration.bySidechainId[transcriptSidechainId]?.status : undefined,
        );
    const showSidechainHydrationStatus =
        isSubAgentTranscriptTool &&
        shouldShowSidechainHydrationInlineStatus({
            messageCount: messages.length,
            sidechainId: transcriptSidechainId,
            status: sidechainHydrationStatus,
        });

    // Check if there's a specialized content view for this tool.
    // ToolFullView always renders the same tool renderer in `detailLevel="full"` mode.
    const SpecializedFullView = getToolViewComponent(normalizedToolName);
    const screenWidth = useWindowDimensions().width;
    const toolViewShowDebugByDefault = useSetting('toolViewShowDebugByDefault');
    const permissionPromptSurface = useSetting('permissionPromptSurface');
    const [showDebug, setShowDebug] = React.useState<boolean>(toolViewShowDebugByDefault);
    const isWaitingForPermission =
        toolForRendering.permission?.status === 'pending' && toolForRendering.state !== 'completed';

    const normalizedSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
    const sidechainId = transcriptSidechainId;
    const normalizedOwningMessageId = owningMessageId.trim();
    if (normalizedOwningMessageId.length === 0) {
        throw new Error('ToolFullView requires a non-empty owningMessageId');
    }
    const transcriptDatasetIdentity = sidechainId ?? normalizedOwningMessageId;
    const transcriptSessionAddress = normalizeSessionAddress(serverId, normalizedSessionId);
    const transcriptDatasetScope = transcriptSessionAddress
        ? sessionAddressKey(transcriptSessionAddress)
        : normalizedSessionId;
    const sidechainDatasetKey = React.useMemo(
        () => JSON.stringify([transcriptDatasetScope, transcriptDatasetIdentity]),
        [transcriptDatasetIdentity, transcriptDatasetScope],
    );
    const canRenderTaskTranscript =
        normalizedSessionId !== null &&
        isSubAgentTranscriptTool &&
        (sidechainId !== null || messages.length > 0);
    const resolvedPermissionPromptSurface =
        forcePermissionFooterInTranscript
            ? 'transcript'
            : resolvePermissionPromptSurface(permissionPromptSurface);

    const transcriptInteraction = interaction;
    const loadOlderSidechain = React.useMemo(
        () => createAppSidechainHistoryLoader(source.sessionId, sidechainId),
        [source.sessionId, sidechainId],
    );

    const showPermissionPromptsInTranscript = resolvedPermissionPromptSurface === 'transcript';

    const permissionFooter =
        isWaitingForPermission &&
        toolForRendering.permission &&
        normalizedSessionId &&
        showPermissionPromptsInTranscript &&
        shouldShowGenericPermissionPromptForRequest({ toolName: toolForRendering.name, requestKind: toolForRendering.permission.kind }) ? (
            <PermissionFooter
                permission={toolForRendering.permission}
                sessionId={normalizedSessionId}
                toolName={normalizedToolName}
                toolInput={toolForRendering.input}
                metadata={metadata || null}
                canApprovePermissions={interaction.canApprovePermissions}
                disabledReason={interaction?.permissionDisabledReason}
            />
        ) : null;

    const debugSection = (
        <View style={styles.section}>
            <View style={styles.sectionHeader}>
                <Icon name="code" size={20} color={theme.colors.accent.orange} />
                <Text style={styles.sectionTitle}>{t('tools.fullView.debug')}</Text>
                <Text
                    style={[styles.toolId, { marginLeft: theme.space.s8 }]}
                    onPress={() => setShowDebug((v) => !v)}
                >
                    {showDebug ? t('tools.fullView.hide') : t('tools.fullView.show')}
                </Text>
            </View>
            {showDebug && (
                <CodeView
                    code={JSON.stringify({
                        name: tool.name,
                        normalizedName: normalizedToolName,
                        state: toolForRendering.state,
                        description: toolForRendering.description,
                        input: toolForRendering.input,
                        result: toolForRendering.result,
                        createdAt: toolForRendering.createdAt,
                        startedAt: toolForRendering.startedAt,
                        completedAt: toolForRendering.completedAt,
                        permission: toolForRendering.permission,
                        messages,
                        jumpChildId: normalizedJumpChildId,
                    }, null, 2)}
                />
            )}
        </View>
    );

    if (canRenderTaskTranscript && normalizedSessionId) {
        const transcriptHeader =
            (messages.length === 0 || normalizedToolName === 'SubAgentRun' && toolForRendering.state !== 'running')
                && (SpecializedFullView || showSidechainHydrationStatus) ? (
                <TextSelectabilityScope selectable>
                    <>
                        {SpecializedFullView ? (
                            <SpecializedFullView
                                tool={toolForRendering}
                                metadata={metadata || null}
                                messages={messages}
                                sessionId={sessionId}
                                detailLevel="full"
                                interaction={interaction}
                            />
                        ) : null}
                        {showSidechainHydrationStatus ? (
                            <SidechainHydrationInlineStatus
                                testID="tool-sidechain-loading"
                                status={sidechainHydrationStatus}
                            />
                        ) : null}
                    </>
                </TextSelectabilityScope>
            ) : null;

        return (
            <View style={[styles.container, { paddingHorizontal: screenWidth > 700 ? 16 : 0 }]}>
                <View style={[styles.contentWrapper, contentMaxWidthStyle, { flex: 1, minHeight: 0 }]}>
                    <View style={styles.transcriptSection}>
                        <ChainTranscriptList
                            key={sidechainDatasetKey}
                            sessionId={normalizedSessionId}
                            serverId={serverId ?? null}
                            datasetKey={sidechainDatasetKey}
                            messages={messages}
                            metadata={metadata || null}
                            interaction={transcriptInteraction}
                            forcePermissionPromptsInTranscript={forcePermissionFooterInTranscript}
                            pendingMessages={pendingMessages}
                            discardedMessages={discardedMessages}
                            pendingRecipient={pendingRecipient}
                            isInitialLoadInFlight={showSidechainLoading}
                            loadOlder={sidechainId ? loadOlderSidechain : undefined}
                            jumpToMessageId={normalizedJumpChildId}
                            header={transcriptHeader}
                            footer={
                                <>
                                    {permissionTerminalError}
                                    {permissionFooter}
                                    {debugSection}
                                </>
                            }
                            messageWrapperTestIdPrefix="tool-fullview-transcript-message"
                        />
                    </View>
                </View>
            </View>
        );
    }

    return (
        <ScrollView style={[styles.container, { paddingHorizontal: screenWidth > 700 ? 16 : 0 }]}>
            <View style={[styles.contentWrapper, contentMaxWidthStyle]}>
                {/* Tool-specific content or generic fallback */}
                {SpecializedFullView ? (
                    <TextSelectabilityScope selectable>
                        <SpecializedFullView
                            tool={toolForRendering}
                            metadata={metadata || null}
                            messages={messages}
                            sessionId={sessionId}
                            detailLevel="full"
                            interaction={interaction}
                        />
                    </TextSelectabilityScope>
                ) : (
                    <TextSelectabilityScope selectable>
                        <>
                            {/* Generic fallback for tools without specialized views */}
                            {/* Tool Description */}
                            {toolForRendering.description && (
                                <View style={styles.section}>
                                    <View style={styles.sectionHeader}>
                                        <Icon name="info" size={20} color={theme.colors.accent.indigo} />
                                        <Text style={styles.sectionTitle}>{t('tools.fullView.description')}</Text>
                                    </View>
                                    <Text style={styles.description}>{toolForRendering.description}</Text>
                                </View>
                            )}
                            {/* Input Parameters */}
                            {toolForRendering.input && (
                                <View style={styles.section}>
                                    <View style={styles.sectionHeader}>
                                        <Icon name="sign-in" size={20} color={theme.colors.accent.indigo} />
                                        <Text style={styles.sectionTitle}>{t('tools.fullView.inputParams')}</Text>
                                    </View>
                                    <CodeView code={JSON.stringify(toolForRendering.input, null, 2)} />
                                </View>
                            )}

                            {/* Result/Output */}
                            {toolForRendering.state === 'completed' && toolForRendering.result && (
                                <View style={styles.section}>
                                    <View style={styles.sectionHeader}>
                                        <Icon name="sign-out" size={20} color={theme.colors.state.success.foreground} />
                                        <Text style={styles.sectionTitle}>{t('tools.fullView.output')}</Text>
                                    </View>
                                    <CodeView
                                        code={typeof toolForRendering.result === 'string' ? toolForRendering.result : JSON.stringify(toolForRendering.result, null, 2)}
                                    />
                                </View>
                            )}

                            {toolForRendering.state === 'running' && toolForRendering.result && (
                                <View style={styles.section}>
                                    <View style={styles.sectionHeader}>
                                        <Icon name="sign-out" size={20} color={theme.colors.state.success.foreground} />
                                        <Text style={styles.sectionTitle}>{t('tools.fullView.output')}</Text>
                                    </View>
                                    <StructuredResultView tool={toolForRendering} metadata={metadata || null} messages={messages} sessionId={sessionId} />
                                </View>
                            )}

                            {/* Error Details */}
                            {toolForRendering.state === 'error' && toolForRendering.result && (
                                <View style={styles.section}>
                                    <View style={styles.sectionHeader}>
                                        <Icon name="x-circle" size={20} color={theme.colors.state.danger.foreground} />
                                        <Text style={styles.sectionTitle}>{t('tools.fullView.error')}</Text>
                                    </View>
                                    <View style={styles.errorContainer}>
                                        <Text style={styles.errorText}>
                                            {typeof toolForRendering.result === 'string'
                                                ? toolForRendering.result
                                                : JSON.stringify(toolForRendering.result, null, 2)}
                                        </Text>
                                    </View>
                                </View>
                            )}

                            {/* No Output Message */}
                            {toolForRendering.state === 'completed' && !toolForRendering.result && (
                                <View style={styles.section}>
                                    <View style={styles.emptyOutputContainer}>
                                        <Icon name="check-circle" size={48} color={theme.colors.state.success.foreground} />
                                        <Text style={styles.emptyOutputText}>{t('tools.fullView.completed')}</Text>
                                        <Text style={styles.emptyOutputSubtext}>{t('tools.fullView.noOutput')}</Text>
                                    </View>
                                </View>
                            )}
                        </>
                    </TextSelectabilityScope>
                )}

                {permissionTerminalError}
                {permissionFooter}
                {debugSection}
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
        paddingTop: theme.space.s12,
    },
    contentWrapper: {
        alignSelf: 'center',
        width: '100%',
    },
    section: {
        marginBottom: 28,
        paddingHorizontal: theme.space.s4,
    },
    sectionFullWidth: {
        marginBottom: 28,
        paddingHorizontal: 0,
    },
    transcriptSection: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: 0,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: theme.space.s12,
        gap: theme.space.s8,
    },
    sectionTitle: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    description: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    toolId: {
        fontSize: 12,
        fontFamily: resolveCodeMonoFontFamily(),
        color: theme.colors.text.secondary,
    },
    errorContainer: {
        backgroundColor: theme.colors.state.danger.background,
        borderRadius: 8,
        padding: theme.space.s16,
        borderWidth: 1,
        borderColor: theme.colors.state.danger.border,
    },
    errorText: {
        fontSize: 14,
        color: theme.colors.state.danger.foreground,
        lineHeight: 20,
    },
    emptyOutputContainer: {
        alignItems: 'center',
        paddingVertical: theme.space.s48,
        gap: theme.space.s12,
    },
    emptyOutputText: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    emptyOutputSubtext: {
        fontSize: 14,
        color: theme.colors.text.secondary,
    },
}));

// Export styles for use in specialized views
export const toolFullViewStyles = styles;
