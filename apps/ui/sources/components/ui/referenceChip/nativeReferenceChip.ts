import { parseThemeColor } from '@/theme/parseThemeColor';
import { resolveReferenceChipIconName } from './referenceChipIcon';

const symbols: Readonly<Record<string, readonly [string, string]>> = {
        file: ['doc', '▤'], folder: ['folder', '▱'], 'chat-circle': ['bubble.left', '▤'],
        sparkle: ['sparkle', '✦'], 'puzzle-piece': ['puzzlepiece', '✧'],
        'git-branch': ['arrow.triangle.branch', '⇢'], 'flow-arrow': ['arrow.triangle.branch', '⇢'],
        'tree-structure': ['arrow.triangle.branch', '⇢'],
        'git-pull-request': ['arrow.triangle.pull', '⑂'], 'git-merge': ['arrow.triangle.merge', '⋈'],
        'circle-dot': ['circle.inset.filled', '⊙'], bug: ['ladybug', '◇'],
        'squares-four': ['square.grid.2x2', '⊞'], image: ['photo', '▧'], at: ['at', '@'],
        'chats-circle': ['bubble.left.and.bubble.right', '▤'], 'radio-button': ['circle.inset.filled', '⊙'],
};

/** Native text drawing uses platform glyphs for the concept chosen by the icon registry. */
export function nativeReferenceChipGlyph(ref: string, glyph: string | null | undefined, platform: string, image = false): string {
    const icon = resolveReferenceChipIconName({ ref, glyph });
    const pair = image ? symbols.image : icon ? symbols[icon] : undefined;
    return (pair ?? symbols.file!)[platform === 'ios' ? 0 : 1];
}

/** JSON transports concrete ARGB ink, avoiding a second native theme-colour parser. */
export function nativeReferenceChipColor(ink: string): number {
    const color = parseThemeColor(ink);
    if (!color) return 0;
    const [r, g, b] = color.rgb().array();
    return ((Math.round(color.alpha() * 255) << 24) | (Math.round(r!) << 16) | (Math.round(g!) << 8) | Math.round(b!)) >>> 0;
}
