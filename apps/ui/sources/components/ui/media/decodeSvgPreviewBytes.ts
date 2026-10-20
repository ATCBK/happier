export function requireSvgPreviewText(text: string): string {
    if (!/<svg(?:\s|\/?>)/.test(text)) throw new Error('svg_preview_invalid_content');
    return text;
}

export function decodeSvgPreviewBytes(bytes: Uint8Array): string {
    return requireSvgPreviewText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
