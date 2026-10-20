import { describe, expect, it } from 'vitest';
import { createPdfBridgeFindModel } from './pdfBridgeFindModel';
import { parsePdfWebViewMessage } from './pdfNativeBridge';

describe('native PDF Find projection', () => {
    it('publishes before synchronous WebView answers and forwards safe query/step commands', () => {
        const calls: unknown[] = [];
        const page = { __pdfFind: (query: string, matchCase: boolean) => {
            calls.push([query, matchCase]);
            const result = parsePdfWebViewMessage(JSON.stringify({ type: 'find', current: 3, total: 9, complete: false }));
            if (result) model.acceptMessage(result);
        }, __pdfStep: (direction: number) => calls.push(direction) };
        const model = createPdfBridgeFindModel(script => { Function('window', script)(page); });
        model.setQuery('retry"</script>');
        expect(model.status).toEqual({ kind: 'searching', current: 3, total: 9 });
        model.step(-1);
        expect(calls).toEqual([['retry"</script>', false], -1]);
        model.close();
        expect(model.status).toEqual({ kind: 'idle' });
    });
});
