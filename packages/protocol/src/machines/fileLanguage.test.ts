import { describe, expect, it } from 'vitest';
import { getFileLanguageFromPath } from './fileLanguage.js';

describe('file language', () => {
    it('classifies native separators and the existing language variants', () => {
        expect(getFileLanguageFromPath('C:\\work\\component.tsx')).toBe('tsx');
        expect(getFileLanguageFromPath('src/component.jsx')).toBe('jsx');
        expect(getFileLanguageFromPath('package/module.mts')).toBe('typescript');
        expect(getFileLanguageFromPath('/home/user/.ssh/config')).toBe('ssh-config');
    });
    it('does not interpret inherited object names as language declarations', () => {
        for (const path of ['constructor', '__proto__', 'toString', 'src/a.constructor', 'src/a.__proto__']) {
            expect(getFileLanguageFromPath(path)).toBe(null);
        }
    });
});
