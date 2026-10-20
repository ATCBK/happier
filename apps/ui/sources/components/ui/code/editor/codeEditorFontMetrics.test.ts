import { describe, expect, it } from 'vitest';

import { resolveCodeEditorFontMetrics } from './codeEditorFontMetrics';
import { resolveCodeEditorGutterMetrics, resolveCodeEditorLineNumberDigits } from './codeEditorFontMetrics';

describe('resolveCodeEditorFontMetrics', () => {
    it('applies uiFontScale and osFontScale', () => {
        const m = resolveCodeEditorFontMetrics({ uiFontScale: 2, osFontScale: 1.25 });
        expect(m.fontSize).toBe(33);
        expect(m.lineHeight).toBe(55);
        expect(m.scale).toBeCloseTo(2.5, 5);
        expect(m.lineNumberFontSize).toBe(28);
    });
    it('keeps one file-wide text origin for 1–5 digit rows, scaled glyphs and a review lane', () => {
        for (const digits of [1, 2, 3, 4, 5]) {
            for (const digitWidth of [7.8, 15.6, 19.5]) {
                const numberWidth = Math.max(24, Math.round(digits * digitWidth));
                expect(resolveCodeEditorGutterMetrics({ lineNumberDigits: digits, digitWidth, reviewLaneWidth: 32 })).toMatchObject({
                    numberWidth, textOffset: 8 + 32 + 4 + numberWidth + 18,
                });
            }
        }
        expect(resolveCodeEditorGutterMetrics({ lineNumberDigits: 5, digitWidth: 7.8, showLineNumbers: false }).textOffset).toBe(30);
        expect(resolveCodeEditorGutterMetrics({ lineNumberDigits: 5, digitWidth: 7.8, showLineNumbers: false, columns: 2 }).textOffset).toBe(30);
    });
    it('counts CRLF as one line boundary when crossing a digit boundary', () => {
        const text = Array.from({ length: 9 }, () => 'line').join('\r\n');
        expect(resolveCodeEditorLineNumberDigits(text)).toBe(1);
        expect(resolveCodeEditorLineNumberDigits(`${text}\nlast`)).toBe(2);
    });
});

