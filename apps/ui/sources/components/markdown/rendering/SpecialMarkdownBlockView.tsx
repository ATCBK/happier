import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import { MarkdownBlockView, type Option, type OptionLongPressHandler } from '../MarkdownBlockView';
import type { MarkdownBlock } from '../parseMarkdown';
import { parseMarkdownTableSources, type MarkdownTableCellSource } from '../parseMarkdownBlock';
import { projectLeafRanges } from './MarkdownFindDecorationContext';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import { markdownProfileToLegacyVariant, type MarkdownRenderingProfile } from './MarkdownRenderingProfile';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { sliceFindRanges } from '@/components/ui/text/FindHighlightedText';

type SpecialMarkdownBlockViewProps = Readonly<{
    blocks: readonly MarkdownBlock[];
    first: boolean;
    last: boolean;
    selectable: boolean;
    onOptionPress?: (option: Option) => void;
    onOptionLongPress?: OptionLongPressHandler;
    onLinkPress?: (url: string) => boolean | void;
    textStyle?: StyleProp<TextStyle>;
    profile: MarkdownRenderingProfile;
    streamingReveal: boolean;
    streamingRevealPreset?: StreamingTextRevealPreset;
    agentTexMath: boolean;
    findSourceRanges?: readonly FindTextRange[];
    sourceStart?: number;
    markdown?: string;
}>;

export const SpecialMarkdownBlockView = React.memo((props: SpecialMarkdownBlockViewProps) => {
    const variant = markdownProfileToLegacyVariant(props.profile);
    let cursor = 0;
    const hasTableFindRanges = Boolean(props.findSourceRanges?.length)
        && props.blocks.some((block) => block.type === 'table');
    const tableSources = React.useMemo(
        () => hasTableFindRanges && props.markdown ? parseMarkdownTableSources(props.markdown) : null,
        [hasTableFindRanges, props.markdown],
    );
    const tableRanges = React.useMemo(() => {
        if (!tableSources || !props.findSourceRanges) return undefined;
        const projectCell = (cell: MarkdownTableCellSource) =>
            projectLeafRanges(cell, props.sourceStart ?? 0, props.findSourceRanges!);
        return new Map([...tableSources].map(([blockIndex, table]) => [blockIndex, {
            headers: table.headers.map(projectCell),
            rows: table.rows.map((row) => row.map(projectCell)),
        }]));
    }, [props.findSourceRanges, props.sourceStart, tableSources]);

    return (
        <>
            {props.blocks.map((block, index) => {
                let ranges: readonly FindTextRange[] | undefined;
                const locateRanges = (text: string) => {
                    const start = props.markdown?.indexOf(text, cursor) ?? -1;
                    if (start < 0) return [];
                    cursor = start + text.length;
                    return sliceFindRanges(props.findSourceRanges, (props.sourceStart ?? 0) + start, text.length) ?? [];
                };
                const optionRanges = block.type === 'options' && props.findSourceRanges?.length ? block.items.map(locateRanges) : undefined;
                if (block.type === 'table') cursor = tableSources?.get(index)?.sourceEnd ?? cursor;
                if (block.type === 'code-block' && props.markdown && props.findSourceRanges?.length) {
                    cursor = props.markdown.indexOf('\n', cursor) + 1;
                    const start = props.markdown.indexOf(block.content, cursor);
                    if (start >= 0) ranges = sliceFindRanges(props.findSourceRanges, (props.sourceStart ?? 0) + start, block.content.length);
                    cursor = Math.max(cursor, start + block.content.length);
                }
                return (
                <MarkdownBlockView
                    key={`${block.type}:${index}`}
                    block={block}
                    first={props.first && index === 0}
                    last={props.last && index === props.blocks.length - 1}
                    selectable={props.selectable}
                    onOptionPress={props.onOptionPress}
                    onOptionLongPress={props.onOptionLongPress}
                    onLinkPress={props.onLinkPress}
                    textStyle={props.textStyle}
                    variant={variant}
                    profile={props.profile}
                    streamingReveal={props.streamingReveal}
                    streamingRevealPreset={props.streamingRevealPreset}
                    agentTexMath={props.agentTexMath}
                    findRanges={ranges}
                    findOptionRanges={optionRanges}
                    findTableRanges={block.type === 'table' ? tableRanges?.get(index) : undefined}
                />
            ); })}
        </>
    );
});
