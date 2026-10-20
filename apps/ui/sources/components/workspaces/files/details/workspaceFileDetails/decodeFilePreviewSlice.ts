/** Decode the text bytes selected by the workspace preview budget. */
export function decodeFilePreviewSlice(bytes: Uint8Array, range: Readonly<{ offset: number; totalBytes: number }>): string {
    let start = 0;
    let end = bytes.length;
    const continuation = (byte: number) => (byte & 0xc0) === 0x80;
    if (range.offset > 0) {
        while (start < end && continuation(bytes[start])) start += 1;
    }
    if (range.offset + bytes.length < range.totalBytes && end > start) {
        let lead = end - 1;
        while (lead > start && continuation(bytes[lead])) lead -= 1;
        const byte = bytes[lead];
        const length = byte >= 0xc2 && byte <= 0xdf ? 2
            : byte >= 0xe0 && byte <= 0xef ? 3
                : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;
        if (end - lead < length) end = lead;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start, end));
}
