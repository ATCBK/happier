import * as React from 'react';
import { Platform, type StyleProp, type TextStyle } from 'react-native';

import { Text } from '@/components/ui/text/Text';

const ROW_STYLE = { display: 'flex', flexDirection: 'row', overflow: 'hidden', minWidth: 0 } as const;
const HEAD_STYLE = { flexShrink: 1, minWidth: 0 } as const;
const TAIL_STYLE = { flexShrink: 0 } as const;

/**
 * Where a middle ellipsis keeps the end: a path's last segment, a name's disambiguating suffix
 * ("devbox · 3ad2"), otherwise the last two fifths. The tail is a run of its own and a browser drops a
 * space at the start of a run, so a suffix keeps its " · " through a no-break space.
 */
export function splitForWebMiddleEllipsis(value: string): Readonly<{ head: string; tail: string }> | null {
    const slash = value.lastIndexOf('/');
    if (slash > 0 && slash < value.length - 1) return { head: value.slice(0, slash), tail: value.slice(slash) };
    const suffix = value.lastIndexOf(' · ');
    if (suffix > 0 && suffix < value.length - 3) return { head: value.slice(0, suffix), tail: ` ${value.slice(suffix + 1)}` };
    if (value.length < 8) return null;
    const cut = Math.ceil(value.length * 0.6);
    return { head: value.slice(0, cut), tail: value.slice(cut) };
}

/**
 * One line of text that gives up its middle, never its end: the web draws only a tail ellipsis, so there
 * the head shrinks with its own ellipsis and the end stays whole; native uses the platform's middle mode.
 */
export function MiddleEllipsisText(props: Readonly<{
    value: string;
    style?: StyleProp<TextStyle>;
    testID?: string;
    accessibilityRole?: 'header';
}>): React.ReactElement {
    const split = Platform.OS === 'web' ? splitForWebMiddleEllipsis(props.value) : null;
    if (!split) {
        return (
            <Text testID={props.testID} style={props.style} numberOfLines={1} ellipsizeMode="middle" accessibilityRole={props.accessibilityRole}>
                {props.value}
            </Text>
        );
    }
    return (
        <Text testID={props.testID} style={[props.style, ROW_STYLE]} accessibilityRole={props.accessibilityRole}>
            <Text style={HEAD_STYLE} numberOfLines={1} ellipsizeMode="tail">{split.head}</Text>
            <Text style={TAIL_STYLE} numberOfLines={1}>{split.tail}</Text>
        </Text>
    );
}
