import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { PaneArrangement } from '@/components/ui/panels/paneBreakpoints';

/**
 * A miniature of the window in one arrangement (lab ade-shell SET), painted from the theme's own
 * roles so the tile shows where things go rather than naming it: Session first puts the chat in the
 * middle with the editor beside it; Editor first puts Files and the editor in the middle with the
 * session at the right. Static: no subscriptions.
 */
export const PaneArrangementPreview = React.memo(function PaneArrangementPreview(props: Readonly<{ arrangement: PaneArrangement }>) {
    const editorFirst = props.arrangement === 'editor';
    const chat = (
        <View key="chat" style={[styles.column, editorFirst ? styles.chatNarrow : styles.flex]}>
            <View style={[styles.bubble, styles.bubbleMine]} />
            <View style={[styles.line, styles.lineLong]} />
            <View style={[styles.line, styles.lineMid]} />
            <View style={[styles.line, styles.lineShort]} />
            <View style={styles.grow} />
            <View style={styles.composer} />
        </View>
    );
    const editor = (
        <View key="editor" style={[styles.column, styles.editor, editorFirst ? styles.flex : styles.editorSide]}>
            {[0.7, 0.5, 0.85, 0.6, 0.4, 0.75, 0.55].map((width, index) => (
                <View key={index} style={[styles.code, index === 3 ? styles.codeAdded : null, { width: `${width * 100}%` }]} />
            ))}
        </View>
    );
    const files = (
        <View key="files" style={[styles.column, styles.files]}>
            {[0.8, 0.6, 0.7, 0.5, 0.65].map((width, index) => <View key={index} style={[styles.line, { width: `${width * 100}%` }]} />)}
        </View>
    );
    return (
        <View style={styles.frame}>
            <View style={styles.rail} />
            {editorFirst ? [files, editor, chat] : [<View key="sidebar" style={[styles.column, styles.files]}>
                {[0.8, 0.7, 0.75, 0.6].map((width, index) => <View key={index} style={[styles.line, { width: `${width * 100}%` }]} />)}
            </View>, chat, editor]}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    frame: {
        flex: 1, flexDirection: 'row', overflow: 'hidden', backgroundColor: theme.colors.surface.base,
    },
    rail: { width: 8, backgroundColor: theme.colors.background.canvas },
    column: { paddingHorizontal: 5, paddingVertical: 6, gap: 3, minWidth: 0 },
    flex: { flex: 1 },
    grow: { flex: 1 },
    files: { width: '22%', backgroundColor: theme.colors.background.canvas, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.colors.border.subtle },
    chatNarrow: { width: '30%', borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.subtle },
    editor: { gap: 3 },
    editorSide: { width: '40%', borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.subtle },
    line: { height: 3, borderRadius: 1.5, backgroundColor: theme.colors.text.tertiary, opacity: 0.4 },
    lineLong: { width: '90%' },
    lineMid: { width: '70%' },
    lineShort: { width: '45%' },
    bubble: { height: 8, borderRadius: 3, marginBottom: 2 },
    bubbleMine: { alignSelf: 'flex-end', width: '55%', backgroundColor: theme.colors.text.tertiary, opacity: 0.25 },
    composer: { height: 9, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.strong },
    code: { height: 3, borderRadius: 1.5, backgroundColor: theme.colors.text.secondary, opacity: 0.5 },
    codeAdded: { backgroundColor: theme.colors.diff.added.border, opacity: 0.9 },
}));
