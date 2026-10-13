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
