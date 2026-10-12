import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { Text } from '@/components/ui/text/Text';
import { resolveCodeMonoFontFamily } from '@/components/ui/code/codeTypography';


export function CodeGutter(props: { line: CodeLine; showLineNumbers?: boolean }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { line } = props;
    const showLineNumbers = props.showLineNumbers ?? true;

    if (line.renderIsHeaderLine) {
        return <View style={styles.gutter} />;
    }
    if (!showLineNumbers) {
        return <View style={styles.gutter} />;
    }

    const left = line.oldLine ? String(line.oldLine) : '';
    const right = line.newLine ? String(line.newLine) : '';

    // Diff lines keep two right-aligned number columns (old, new) so "7 8" never reads as "78";
    // a file view has only its own line number.
    return (
        <View style={styles.gutter}>
            {line.kind === 'file' ? null : <Text style={styles.gutterText}>{left}</Text>}
            <Text style={styles.gutterText}>{right}</Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    gutter: {
        flexDirection: 'row',
        columnGap: 6,
        paddingRight: 18,
        paddingLeft: 4,
    },
    gutterText: {
        fontFamily: resolveCodeMonoFontFamily(),
        fontSize: 11,
        minWidth: 24,
        textAlign: 'right',
        fontVariant: ['tabular-nums'],
        color: theme.colors.text.secondary,
    },
}));
