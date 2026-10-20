import { readFenceLayout, type FenceLayout, type FenceSpan } from '@/voice/output/codeFences';

export type TtsChunker = Readonly<{
    push: (textDelta: string) => string[];
    flush: () => string[];
}>;

function clampChunkChars(raw: unknown): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 200;
    return Math.max(32, Math.min(2000, n));
}

export function resolveStreamingTtsChunkChars(raw: unknown): number {
    return clampChunkChars(raw);
}

type Span = FenceSpan;

function spanContaining(spans: readonly Span[], index: number): Span | null {
    return spans.find((span) => index > span.start && index < span.end) ?? null;
}

function isTerminalPunctuation(c: string | undefined): boolean {
    return c === '.' || c === '!' || c === '?';
}

/** CJK full-width terminators end a sentence without needing whitespace after them. */
function isFullWidthTerminator(c: string | undefined): boolean {
    return c === '。' || c === '！' || c === '？';
}

/**
 * True when a sentence ends right after `text[i]`. ASCII terminal punctuation only ends a sentence
 * when whitespace follows (or the text ends and `atEnd` is set), so decimals (`3.14`) and file
 * names (`file.ts`) stay intact. Dotted abbreviations such as `e.g.` / `i.e.` / `U.S.` are not
 * boundaries.
 */
function isSentenceEndAt(text: string, i: number, atEnd: boolean): boolean {
    const c = text[i];
    if (c === '\n' || isFullWidthTerminator(c)) return true;
    if (!isTerminalPunctuation(c)) return false;

    const next = text[i + 1];
    if (next === undefined) {
        if (!atEnd) return false;
    } else if (!/\s/.test(next)) {
        return false;
    }

    if (c !== '.') return true;
    let wordStart = i;
    while (wordStart > 0 && !/\s/.test(text[wordStart - 1] ?? '')) wordStart -= 1;
    const word = text.slice(wordStart, i);
    // `e.g` / `i.e` / `U.S` style abbreviations contain an inner dot between single letters.
    return !/^(?:[A-Za-z]\.)+[A-Za-z]$/.test(word);
}

/** Moves a cut index back so it never separates a UTF-16 surrogate pair. */
function avoidSurrogateSplit(text: string, index: number): number {
    if (index <= 0 || index >= text.length) return index;
    const code = text.charCodeAt(index);
    return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

function isCuttable(text: string, index: number, fences: FenceLayout): boolean {
    if (fences.openStart !== null && index > fences.openStart) return false;
    return spanContaining(fences.closed, index) === null;
}

function lastBoundaryIndex(text: string, maxChars: number, fences: FenceLayout, atEnd: boolean): number {
    const limit = Math.min(text.length, maxChars);

    for (let i = limit - 1; i >= 0; i -= 1) {
        if (isSentenceEndAt(text, i, atEnd && i === text.length - 1) && isCuttable(text, i + 1, fences)) {
            return i + 1;
        }
    }

    for (let i = limit - 1; i >= 0; i -= 1) {
        if (/\s/.test(text[i] ?? '') && isCuttable(text, i + 1, fences)) {
            return i + 1;
        }
    }

    const fence = spanContaining(fences.closed, limit);
    if (fence) return fence.start > 0 ? fence.start : fence.end;
    const cut = avoidSurrogateSplit(text, limit);
    return cut > 0 ? cut : limit + 1;
}

function firstSentenceEndIndex(text: string, maxChars: number, fences: FenceLayout): number | null {
    const limit = Math.min(text.length, maxChars);
    for (let i = 0; i < limit; i += 1) {
        if (isSentenceEndAt(text, i, true) && isCuttable(text, i + 1, fences)) {
            return i + 1;
        }
    }
    return null;
}

/**
 * Streaming chunker for assistant text deltas. Chunks end at sentence boundaries when possible and
 * never split a fenced code block, so the per-chunk speech normalizer sees complete fences.
 */
export function createTtsChunker(chunkChars: number): TtsChunker {
    const bounded = clampChunkChars(chunkChars);
    let buffer = '';

    const drain = (force: boolean): string[] => {
        const chunks: string[] = [];

        while (buffer.trim().length > 0) {
            const fences = readFenceLayout(buffer);
            // While a fence is open, only the prose before it can be emitted.
            const readyLength = !force && fences.openStart !== null ? fences.openStart : buffer.length;
            if (!force && readyLength < bounded) {
                break;
            }

            const isFinalSmallChunk = force && buffer.length <= bounded;
            const cut = isFinalSmallChunk ? buffer.length : lastBoundaryIndex(buffer, Math.min(bounded, readyLength), fences, force);
            if (cut <= 0) break;
            const nextChunk = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut).trimStart();

            if (nextChunk) {
                chunks.push(nextChunk);
            }
        }

        return chunks;
    };

    return {
        push: (textDelta: string) => {
            if (typeof textDelta !== 'string' || textDelta.length === 0) {
                return [];
            }
            buffer += textDelta;
            return drain(false);
        },
        flush: () => drain(true),
    };
}

/**
 * Splits complete text into sentence-sized parts (each at most `maxChars`, except an unsplittable
 * code fence) so synthesis can start speaking after the first sentence.
 */
export function splitSpeechSentences(text: string, maxChars: number): string[] {
    const bounded = clampChunkChars(maxChars);
    const parts: string[] = [];
    let rest = text.trim();

    while (rest.length > 0) {
        const fences = readFenceLayout(rest);
        const cut = firstSentenceEndIndex(rest, bounded, fences)
            ?? (rest.length <= bounded ? rest.length : lastBoundaryIndex(rest, bounded, fences, true));
        const part = rest.slice(0, cut).trim();
        rest = rest.slice(cut).trim();
        if (part) parts.push(part);
    }

    return parts;
}
