import { describe, expect, it } from 'vitest';
import { presentCapabilityStatus } from './capabilityStatusPresentation';

// The decisions (silence, tone, fix, blocking order) are owned and tested in `@happier-dev/plugin-ui`
// (`presentation/capabilities/capabilityStatus.test.ts`); this proves Happier's words reach them.
describe('presentCapabilityStatus', () => {
    it('speaks Happier’s words for statuses, machines and fixes', () => {
        const signin = presentCapabilityStatus({ kind: 'more_access' });
        expect(signin.pill?.label).toBe('Needs more access');
        expect(signin.fixLabel).toBe('Grant access');
        expect(presentCapabilityStatus({ kind: 'error', machineName: 'nl2' }).pill?.label).toBe('Stopped on nl2');
        expect(presentCapabilityStatus({ kind: 'unused' }).pill?.label).toBe('Not used recently');
        expect(presentCapabilityStatus({ kind: 'off' }, 'header').pill?.label).toBe('Off');
    });
});
