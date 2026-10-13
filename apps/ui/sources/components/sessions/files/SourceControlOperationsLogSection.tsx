import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import { t } from '@/text';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';

type SourceControlOperationsLogSectionProps = Readonly<{
    theme: any;
    currentSessionId: string;
    operationLog: ScmProjectOperationLogEntry[];
    formatOperationActor: (sessionId: string) => string;
}>;

export function SourceControlOperationsLogSection(props: SourceControlOperationsLogSectionProps) {
    const { theme, currentSessionId, operationLog, formatOperationActor } = props;
    const [operationLogScope, setOperationLogScope] = React.useState<'all' | 'session'>('all');

    const hasCrossSessionLogEntries = React.useMemo(
        () => operationLog.some((entry) => entry.sessionId !== currentSessionId),
        [currentSessionId, operationLog]
    );

    const visibleOperationLog = React.useMemo(() => {
        const entries = operationLogScope === 'session'
            ? operationLog.filter((entry) => entry.sessionId === currentSessionId)
            : operationLog;
        return [...entries]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 5);
    }, [currentSessionId, operationLog, operationLogScope]);

    if (operationLog.length === 0) {
        return null;
    }

    return (
        <View style={{ marginTop: theme.space.s10 }}>
            <Text
                style={{
                    ...Typography.variant('meta', 'semiBold'),
                    color: theme.colors.text.secondary,
                    marginBottom: theme.space.s6,
                }}
            >
                {t('files.sourceControlOperationsLog.title')}
            </Text>
            {hasCrossSessionLogEntries && (
                <View style={{ flexDirection: 'row', gap: theme.space.s8, marginBottom: theme.space.s8 }}>
                    <ToolbarButton
                        onPress={() => setOperationLogScope('all')}
                        active={operationLogScope === 'all'}
                        label={t('files.sourceControlOperationsLog.allSessions')}
                    />
                    <ToolbarButton
                        onPress={() => setOperationLogScope('session')}
                        active={operationLogScope === 'session'}
                        label={t('files.sourceControlOperationsLog.thisSession')}
                    />
                </View>
            )}
            {visibleOperationLog.length === 0 ? (
                <Text
                    style={{
                        ...Typography.variant('micro'),
                        color: theme.colors.text.secondary,
                        marginBottom: theme.space.s4,
                    }}
                >
                    {t('files.sourceControlOperationsLog.emptyThisSession')}
                </Text>
            ) : (
                visibleOperationLog.map((entry) => (
                    <View
                        key={entry.id}
                        style={{
                            borderWidth: 1,
                            borderColor: theme.colors.border.default,
                            borderRadius: 10,
                            backgroundColor: theme.colors.surface.inset ?? theme.colors.input.background,
                            paddingHorizontal: theme.space.s10,
                            paddingVertical: theme.space.s8,
                            marginBottom: theme.space.s6,
                        }}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.s10 }}>
                            <Text style={{ flex: 1, ...Typography.variant('micro', 'semiBold'), color: theme.colors.text.primary,  }}>
                                {entry.operation} · {formatOperationActor(entry.sessionId)}
                            </Text>
                            <View
                                style={{
                                    paddingHorizontal: theme.space.s6,
                                    paddingVertical: theme.space.s2,
                                    borderRadius: 999,
                                    backgroundColor: entry.status === 'success' ? theme.colors.state.success.foreground : theme.colors.state.neutral.foreground,
                                }}
                            >
                                <Text style={{ ...Typography.variant('micro', 'semiBold'), color: 'white' }}>
                                    {entry.status.toUpperCase()}
                                </Text>
                            </View>
                        </View>
                        <Text style={{ ...Typography.variant('micro'), color: theme.colors.text.secondary, marginTop: theme.space.s2,  }}>
                            {new Date(entry.timestamp).toLocaleTimeString()}
                            {entry.detail ? ` · ${entry.detail}` : ''}
                        </Text>
                    </View>
                ))
            )}
        </View>
    );
}
