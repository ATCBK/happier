type Input = Readonly<{ sliceBytes: number; signal: AbortSignal; source: { getSize(): Promise<number>; readBase64(offset: number, length: number): Promise<string> }; injectJavaScript(script: string): void }>;
export async function transferPdfToWebView(input: Input): Promise<void> {
    if (!Number.isSafeInteger(input.sliceBytes) || input.sliceBytes <= 0) throw new Error('PDF slice size must come from transport measurements');
    input.signal.throwIfAborted();
    const size = await input.source.getSize();
    input.signal.throwIfAborted();
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid PDF file size');
    input.injectJavaScript(`window.__pdfBegin(${size});true;`);
    for (let offset = 0; offset < size; offset += input.sliceBytes) {
        input.signal.throwIfAborted();
        const length = Math.min(input.sliceBytes, size - offset);
        const encoded = await input.source.readBase64(offset, length);
        input.signal.throwIfAborted();
        if (atob(encoded).length !== length || await input.source.getSize() !== size) throw new Error('PDF file changed during download');
        input.signal.throwIfAborted();
        input.injectJavaScript(`window.__pdfAppend(${JSON.stringify(encoded)});true;`);
    }
    if (await input.source.getSize() !== size) throw new Error('PDF file changed during download');
    input.signal.throwIfAborted();
    input.injectJavaScript('window.__pdfOpen();true;');
}
