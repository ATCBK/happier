import { describe, expect, it } from 'vitest';
import { getToolViewComponent } from './_registry';
import { BashView } from '../system/BashView';

describe('toolViewRegistry (execute/codexbash)', () => {
    it('maps execute and CodexBash to the generic Bash renderer', () => {
        expect(getToolViewComponent('execute')).toBe(BashView);
        expect(getToolViewComponent('CodexBash')).toBe(BashView);
        expect(getToolViewComponent('Bash')).toBe(BashView);
    });
});
