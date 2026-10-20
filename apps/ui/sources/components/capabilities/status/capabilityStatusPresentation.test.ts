import { describe, expect, it } from 'vitest';
import { pickMostBlockingCapabilityStatus, presentCapabilityStatus, type CapabilityStatus } from './capabilityStatusPresentation';

const status = (kind: CapabilityStatus['kind'], extra: Partial<CapabilityStatus> = {}): CapabilityStatus => ({ kind, ...extra });

describe('presentCapabilityStatus', () => {
    it('keeps healthy silent and names the one fix for a problem', () => {
        expect(presentCapabilityStatus(status('ready')).pill).toBeNull();
        const signin = presentCapabilityStatus(status('signin'));
        expect(signin.pill).toMatchObject({ variant: 'attention', label: 'Needs sign-in' });
        expect(signin.tone).toBe('needs_you');
        expect(signin.fixLabel).toBe('Sign in');
        const access = presentCapabilityStatus(status('more_access'));
        expect(access.pill).toMatchObject({ variant: 'attention', label: 'Needs more access' });
        expect(access.fixLabel).toBe('Grant access');
        expect(access.blockingRank).toBe(signin.blockingRank);
        expect(presentCapabilityStatus(status('error', { machineName: 'nl2' })).pill?.label).toBe('Stopped on nl2');
    });

    it('keeps the pill short and hands a stop or a blocked run its reason to say on its own line', () => {
        const reason = "its sign-in couldn't be passed to this session";
        const stopped = presentCapabilityStatus(status('error', { machineName: 'nl2', detail: reason }));
        expect(stopped.pill).toMatchObject({ label: 'Stopped on nl2' });
        expect(stopped.pill?.detail).toBeUndefined();
        expect(stopped.reason).toBe(reason);
        expect(presentCapabilityStatus(status('cantrun', { machineName: 'nl2', detail: 'node is missing' })).reason).toBe('node is missing');
        // A quiet suffix (a time, a key name) stays on the pill's line.
        const expired = presentCapabilityStatus(status('expired', { detail: 'Oct 10' }));
        expect(expired.pill?.detail).toBe('Oct 10');
        expect(expired.reason).toBeUndefined();
    });

    it('is silent for Off in rows and plain in headers', () => {
        expect(presentCapabilityStatus(status('off')).pill).toBeNull();
        expect(presentCapabilityStatus(status('off'), 'header').pill).toMatchObject({ chrome: 'plain', label: 'Off' });
    });
});

describe('pickMostBlockingCapabilityStatus', () => {
    it('lets the most blocking drawn status win at each placement', () => {
        expect(pickMostBlockingCapabilityStatus([status('offline'), status('error')])?.kind).toBe('error');
        expect(pickMostBlockingCapabilityStatus([status('unused'), status('update')])?.kind).toBe('update');
        expect(pickMostBlockingCapabilityStatus([status('off'), status('unused')], 'row')?.kind).toBe('unused');
        expect(presentCapabilityStatus(status('unused')).pill).toMatchObject({ chrome: 'plain', label: 'Not used recently' });
        expect(pickMostBlockingCapabilityStatus([status('off'), status('unused')], 'header')?.kind).toBe('off');
        expect(pickMostBlockingCapabilityStatus([status('ready'), status('off')], 'row')).toBeNull();
    });
});
