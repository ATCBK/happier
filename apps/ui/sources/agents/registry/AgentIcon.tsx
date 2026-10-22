import * as React from 'react';
import type { StyleProp, ImageStyle } from 'react-native';
import { View } from 'react-native';
import * as ReactNativeSvg from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

import {
    getAgentIconSource,
    getAgentIconSvgXml,
    getAgentIconTintColor,
} from '@/agents/catalog/catalog';
import { Icon } from '@/components/ui/icons/Icon';
import { SafeExpoImage } from '@/components/ui/media/SafeExpoImage';

type AgentIconProps = Readonly<{
    agentId: string | null;
    size: number;
    color?: string;
    style?: StyleProp<ImageStyle>;
    testID?: string;
}>;

const SVG_COLOR_ATTRIBUTE_PATTERN = /\s(fill|stroke)="(?!none\b)[^"]*"/g;

function escapeSvgAttributeValue(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
}

function applySvgIconColor(svgXml: string, color: string): string {
    const escapedColor = escapeSvgAttributeValue(color);
    return svgXml.replace(
        SVG_COLOR_ATTRIBUTE_PATTERN,
        (_match, attribute: string) => ` ${attribute}="${escapedColor}"`,
    );
}

/**
 * The agent's mark as a `data:` SVG in one colour, for surfaces painted by CSS (the web diff's agent caret);
 * null when the agent's mark is not an SVG.
 */
export function resolveAgentIconSvgDataUri(agentId: string, theme: Parameters<typeof getAgentIconSvgXml>[1], color: string): string | null {
    const svgXml = getAgentIconSvgXml(agentId, theme);
    return svgXml ? `data:image/svg+xml;utf8,${encodeURIComponent(applySvgIconColor(svgXml, color))}` : null;
}

export const AgentIcon = React.memo(function AgentIcon(props: AgentIconProps) {
    const { agentId, size, color, style, testID } = props;
    const { theme, rt } = useUnistyles();
    // Raw SVG XML is resolved in JS, so subscribe it to adaptive appearance changes explicitly.
    void rt.colorScheme;

    if (agentId === null) {
        return <Icon name="stack-simple" size={size} color={color ?? theme.colors.text.secondary} style={style} testID={testID} />;
    }

    const svgXml = getAgentIconSvgXml(agentId, theme);
    if (svgXml) {
        const resolvedSvgXml = color ? applySvgIconColor(svgXml, color) : svgXml;
        const SvgXml = (ReactNativeSvg as unknown as { SvgXml?: React.ComponentType<any> }).SvgXml;
        if (!SvgXml) {
            const uri = `data:image/svg+xml;utf8,${encodeURIComponent(resolvedSvgXml)}`;
            return (
                <SafeExpoImage
                    source={{ uri }}
                    style={[{ width: size, height: size }, style]}
                    contentFit="contain"
                    testID={testID}
                />
            );
        }
        return (
            // The mark is boxed rather than dropped in bare.
            //
            // `SvgXml` renders a raw DOM `<svg>` on web — the one leaf in this app that
            // is not a React-Native-Web view, and so the only one that is statically
            // positioned. CSS paints static content BENEATH positioned siblings, and
            // React-Native-Web positions every view it renders, so an Agent mark placed
            // on a filled control whose background is an absolutely positioned layer
            // (`GradientSurface`, inside `PrimaryCircleIconButton` and `RoundButton`) was
            // painted over by that background: the composer's armed
            // "Continue with {Agent}" send control drew as an empty filled circle with
            // the mark hidden underneath it.
            //
            // Every other icon in the app already renders inside a view — `Icon` does,
            // and so does the image branch below — so the box makes the Agent mark behave
            // like the rest, rather than special-casing each control that hosts one.
            //
            // The box is only that: the caller's `style` and `testID` stay on the mark
            // itself, so nothing about the icon's public shape changes.
            <View style={{ width: size, height: size }}>
                <SvgXml
                    xml={resolvedSvgXml}
                    width={size}
                    height={size}
                    style={style as ImageStyle}
                    testID={testID}
                />
            </View>
        );
    }

    const source = getAgentIconSource(agentId);
    if (!source) {
        return null;
    }

    return (
        <SafeExpoImage
            source={source}
            style={[{ width: size, height: size }, style]}
            tintColor={color ?? getAgentIconTintColor(agentId, theme)}
            contentFit="contain"
            testID={testID}
        />
    );
});
