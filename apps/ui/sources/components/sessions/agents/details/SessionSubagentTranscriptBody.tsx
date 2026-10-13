import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionMessageDetailsView } from '@/components/sessions/transcript/details/SessionMessageDetailsView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { resolveSessionSubagentDetailsDescriptor } from './descriptors/resolveSessionSubagentDetailsDescriptor';
import type { SessionSubagentTranscriptBodyProps } from './descriptors/types';

const stylesheet = StyleSheet.create((theme) => ({
    empty: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.space.s20,
        paddingVertical: theme.space.s24,
    },
    emptyText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        textAlign: 'center',
    },
}));

export const SessionSubagentTranscriptBody = React.memo((props: SessionSubagentTranscriptBodyProps) => {
    // Body composition for Agent-team and tool participants only. An execution-run
    // participant is delegated by its host to the canonical Run Details surface before
    // reaching here, because nesting that surface inside this body's overview +
    // composer shell put two independent composers on one run.
    const styles = stylesheet;
    const descriptor = resolveSessionSubagentDetailsDescriptor({
        subagent: props.subagent,
        message: props.message,
    });

    if (descriptor.id === 'tool_transcript' && props.message?.kind === 'tool-call') {
        return (
            <SessionMessageDetailsView
                sessionId={props.sessionId}
                session={props.session}
                message={props.message}
                showComposer={false}
            />
        );
    }

    return (
        <View style={styles.empty}>
            <Text style={styles.emptyText}>{t('session.subagents.details.unavailable')}</Text>
        </View>
    );
});
