import { describe, expect, it } from 'vitest';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';

import { buildMonacoEditorThemeData, resolveCodeEditorTheme } from './editorTheme';

const colors = {
    accent: { blue: '#0a84ff' },
    border: { default: 'rgba(0, 0, 0, 0.08)' },
    surface: { inset: '#f6f8fa', elevated: '#ffffff' },
    syntax: {
        default: '#24292f', keyword: '#cf222e', string: '#0a3069',
        comment: '#6e7781', number: '#0550ae', function: '#8250df',
    },
    text: { primary: '#1c1c1e', tertiary: 'rgba(60, 60, 67, 0.6)' },
};

describe('buildMonacoEditorThemeData', () => {
    it('hands Monaco hex colors only, because it paints any other expression solid red', () => {
        const theme = buildMonacoEditorThemeData(resolveCodeEditorTheme(createThemeFixture({ dark: false, colors })));

        expect(theme.colors['editorIndentGuide.background1']).toBe('#00000014');
        expect(theme.colors['editorLineNumber.foreground']).toBe('#3c3c4399');
        for (const value of Object.values(theme.colors)) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/u);
    });
});
