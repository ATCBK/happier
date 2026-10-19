import type { UsageQueryBatchResult } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';

export type UsageByteRange = Readonly<{ offset: number; length: number }>;

// Count the serialized scalar's UTF-8 bytes without allocating its encoded
// buffer. JSON.stringify has already escaped control characters/lone surrogates.
function utf8Length(text: string): number {
    let length = 0;
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        if (unit < 0x80) length++;
        else if (unit < 0x800) length += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff
            && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
            length += 4;
            index++;
        } else length += 3;
    }
    return length;
}

/** Exact Resource bytes; reuse ranges only from the same admitted immutable revision. */
export function encodeUsageQueryResource(value: UsageQueryBatchResult, previous?: Readonly<{
    bytes: Uint8Array;
    ranges?: ReadonlyMap<object, UsageByteRange>;
}>) {
    const encoder = new TextEncoder();
    const previousRanges = previous?.ranges;
    const ranges = new Map<object, UsageByteRange>();
    // Measure admitted JSON first, then fill its one required contiguous buffer.
    // Never stringify/encode a whole accounting field into a growing temporary
    // buffer. The same retained nested object can reuse its existing byte range.
    const lengths = new Map<object, number>();
    const size = (value: unknown): number => {
        if (value === null || typeof value !== 'object') return utf8Length(JSON.stringify(value));
        const prior = previousRanges?.get(value);
        const known = prior?.length ?? lengths.get(value);
        if (known !== undefined) return known;
        const length = Array.isArray(value)
            ? 2 + value.reduce((total, member, index) => total + (index ? 1 : 0) + size(member ?? null), 0)
            : 2 + Object.entries(value).filter(([, member]) => member !== undefined)
                .reduce((total, [key, member], index) => total + (index ? 1 : 0) + size(key) + 1 + size(member), 0);
        lengths.set(value, length);
        return length;
    };
    const bytes = new Uint8Array(size(value));
    const copied: { offset: number; length: number; nextOffset: number }[] = [];
    let offset = 0;
    const text = (value: string) => {
        // encodeInto is native on web. Some native TextEncoder polyfills expose
        // only encode; that fallback allocates a scalar/key, never a subtree.
        if (typeof encoder.encodeInto === 'function') offset += encoder.encodeInto(value, bytes.subarray(offset)).written;
        else { const encoded = encoder.encode(value); bytes.set(encoded, offset); offset += encoded.length; }
    };
    const write = (value: unknown): void => {
        if (value === null || typeof value !== 'object') { text(JSON.stringify(value)); return; }
        const start = offset;
        const prior = previousRanges?.get(value);
        const current = ranges.get(value);
        if (prior && previous) {
            bytes.set(previous.bytes.subarray(prior.offset, prior.offset + prior.length), offset);
            copied.push({ ...prior, nextOffset: offset });
            offset += prior.length;
        } else if (current) {
            bytes.copyWithin(offset, current.offset, current.offset + current.length);
            offset += current.length;
        } else if (Array.isArray(value)) {
            text('[');
            value.forEach((member, index) => { if (index) text(','); write(member ?? null); });
            text(']');
        } else {
            text('{');
            let first = true;
            for (const [key, member] of Object.entries(value)) {
                if (member === undefined) continue;
                if (!first) text(',');
                first = false;
                text(JSON.stringify(key) + ':');
                write(member);
            }
            text('}');
        }
        ranges.set(value, { offset: start, length: offset - start });
    };
    write(value);
    // Keep the nested range index when a whole retained parent was copied. It
    // points only into the new output; no superseded byte buffer is retained.
    copied.sort((left, right) => left.offset - right.offset);
    for (const [object, prior] of previousRanges ?? []) {
        if (ranges.has(object)) continue;
        let left = 0, right = copied.length;
        while (left < right) {
            const middle = (left + right) >>> 1;
            if (copied[middle]!.offset <= prior.offset) left = middle + 1;
            else right = middle;
        }
        const parent = copied[left - 1];
        if (parent && prior.offset + prior.length <= parent.offset + parent.length) {
            ranges.set(object, { offset: parent.nextOffset + prior.offset - parent.offset, length: prior.length });
        }
    }
    return { bytes, ranges };
}
