import { describe, expect, it } from 'vitest';

import { classifyEmailActor, evaluateEmailTrust, type EmailTrustStrategy } from './trust';

const from = 'sales@batiplus.ch';
const exchange: EmailTrustStrategy = { kind: 'exchangeOrganization', authSource: 'tenant.prod.outlook.com' };
const authentication: EmailTrustStrategy = { kind: 'authenticationResults', authservId: 'receiver.example' };

function headers(values: Record<string, readonly string[]>) {
    return new Map(Object.entries(values));
}

function authenticate(results: readonly string[], extra: Record<string, readonly string[]> = {}) {
    return evaluateEmailTrust({
        headers: headers({ 'authentication-results': results, ...extra }), from, sender: null, strategy: authentication,
    });
}

describe('evaluateEmailTrust', () => {
    it('requires the configured Exchange tenant, internal auth, and the same explicit Sender', () => {
        const markers = headers({
            'X-MS-Exchange-Organization-AuthAs': [' Internal '],
            'x-ms-exchange-organization-authsource': ['TENANT.prod.outlook.com'],
        });
        expect(evaluateEmailTrust({ headers: markers, from, sender: 'SALES@batiplus.ch', strategy: exchange }))
            .toEqual({ trusted: true, markersMissing: false });
        expect(evaluateEmailTrust({ headers: markers, from, sender: null, strategy: exchange }))
            .toEqual({ trusted: false, markersMissing: true });
        expect(evaluateEmailTrust({ headers: markers, from, sender: 'other@batiplus.ch', strategy: exchange }).trusted).toBe(false);
        expect(evaluateEmailTrust({ headers: markers, from, sender: from, strategy: { ...exchange, authSource: 'other' } }))
            .toEqual({ trusted: false, markersMissing: false });
    });

    it.each<Record<string, readonly string[]>>([
        { 'x-ms-exchange-organization-authas': ['Internal', 'Internal'], 'x-ms-exchange-organization-authsource': ['tenant.prod.outlook.com'] },
        { 'x-ms-exchange-organization-authas': ['Anonymous'], 'x-ms-exchange-organization-authsource': ['tenant.prod.outlook.com'] },
        { 'x-ms-exchange-organization-authas': ['Internal'], 'x-ms-exchange-organization-authsource': ['tenant.prod.outlook.com\r\nInjected: value'] },
    ])('refuses ambiguous or forged Exchange markers %#', (values) => {
        expect(evaluateEmailTrust({ headers: headers(values), from, sender: from, strategy: exchange }).trusted).toBe(false);
    });

    it.each([
        'receiver.example; dmarc=pass header.from=batiplus.ch',
        'receiver.example 1; dmarc=pass (trusted (nested comment)) header.from="BATIPLUS.CH"',
        'receiver.example; dkim=pass header.d=batiplus.ch',
        'receiver.example; dkim=fail header.d=other.example; dkim=pass header.d=batiplus.ch',
        'receiver.example;\r\n\tdmarc=pass header.from=batiplus.ch',
    ])('accepts a receiving-server pass with a matching author identity: %s', (result) => {
        expect(authenticate([result])).toEqual({ trusted: true, markersMissing: false });
    });

    it.each([
        'sender.example; dmarc=pass header.from=batiplus.ch',
        'receiver.example; dmarc=fail header.from=batiplus.ch',
        'receiver.example; dmarc=pass header.from=other.example',
        'receiver.example; dkim=pass header.d=other.example',
        // DKIM fallback uses strict alignment, never suffix/organizational guesses.
        'receiver.example; dkim=pass header.d=news.batiplus.ch',
        'receiver.example; dkim=pass header.d=batiplus.ch.attacker.example',
        'receiver.example; spf=pass smtp.mailfrom=batiplus.ch',
        'receiver.example; dmarc=fail reason="; dmarc=pass header.from=batiplus.ch"',
        'receiver.example; dmarc=fail (dmarc=pass header.from=batiplus.ch)',
        'receiver.example; "dmarc"=pass header.from=batiplus.ch',
        'receiver.example; dmarc="pass" header.from=batiplus.ch',
        'receiver.example ";" dmarc "=" pass header.from "=" batiplus.ch',
        'receiver.example; dmarc=pass header.from=batiplus.ch header.from=other.example',
        'receiver.example; dmarc=pass header.from=batiplus.ch (unterminated',
        'receiver.example; dmarc=pass header.from=batiplus.ch\r\nAuthentication-Results: receiver.example; dmarc=pass',
        'receiver.example 2; dmarc=pass header.from=batiplus.ch',
    ])('refuses spoofed, failed, unaligned or malformed results: %s', (result) => {
        expect(authenticate([result]).trusted).toBe(false);
    });

    it('never falls back to lower Authentication-Results or forwarded-message headers', () => {
        const good = 'receiver.example; dmarc=pass header.from=batiplus.ch';
        expect(authenticate(['untrusted.example; none', good])).toEqual({ trusted: false, markersMissing: false });
        expect(authenticate(['receiver.example; dmarc=fail header.from=batiplus.ch', good]).trusted).toBe(false);
        expect(authenticate([], { 'resent-authentication-results': [good] })).toEqual({ trusted: false, markersMissing: true });
    });

    it.each(['receiver.example; none', 'receiver.example; dmarc=pass', 'receiver.example; dkim=pass', 'broken'])
    ('reports missing or unusable trust markers for diagnostic attention: %s', (result) => {
        expect(authenticate([result])).toEqual({ trusted: false, markersMissing: true });
    });

    it('refuses repeated or absent From identities even with a passing result', () => {
        const good = 'receiver.example; dmarc=pass header.from=batiplus.ch';
        expect(authenticate([good], { from: [from, from] }).trusted).toBe(false);
        expect(evaluateEmailTrust({ headers: headers({ 'authentication-results': [good] }), from: null, sender: null, strategy: authentication }).trusted).toBe(false);
    });
});

describe('classifyEmailActor', () => {
    const trust = { trusted: true, markersMissing: false };
    const mailbox = 'wilson@batiplus.ch';

    it('projects a verified address for the Channels allowlist owner without deciding admission', () => {
        expect(classifyEmailActor({ headers: headers({}), from: 'SALES@batiplus.ch', mailbox, trust }))
            .toEqual({ principalId: from, kind: 'human', isIntegrationSelf: false });
        expect(classifyEmailActor({ headers: headers({}), from, mailbox, trust: { trusted: false, markersMissing: true } }))
            .toEqual({ principalId: null, kind: 'unknown', isIntegrationSelf: false });
    });

    it.each<Record<string, readonly string[]>>([
        { 'auto-submitted': ['auto-replied'] },
        { precedence: ['bulk'] },
        { precedence: ['JUNK'] },
        { precedence: ['list'] },
        { 'list-id': ['sales.example'] },
        { 'list-unsubscribe': ['<mailto:list@example>'] },
        { 'content-type': ['multipart/report; report-type=delivery-status'] },
        { 'content-type': ['message/disposition-notification'] },
        { 'x-autoreply': ['yes'] },
        { 'x-autorespond': ['yes'] },
        { 'x-ms-exchange-inbox-rules-loop': [mailbox] },
    ])('classifies loop/noise messages as bots %#', (values) => {
        expect(classifyEmailActor({ headers: headers(values), from, mailbox, trust }))
            .toEqual({ principalId: from, kind: 'bot', isIntegrationSelf: false });
    });

    it('allows ordinary mail and receipt requests rather than mistaking them for receipts', () => {
        expect(classifyEmailActor({ headers: headers({
            'auto-submitted': ['no'], 'x-auto-response-suppress': ['All'],
            'disposition-notification-to': [from], 'return-receipt-to': [from],
        }), from, mailbox, trust }).kind).toBe('human');
    });

    it('marks the integration mailbox itself even without trusted sender markers', () => {
        expect(classifyEmailActor({ headers: headers({ 'auto-submitted': ['auto-replied'] }), from: 'WILSON@batiplus.ch', mailbox, trust: { trusted: false, markersMissing: true } }))
            .toEqual({ principalId: null, kind: 'integration', isIntegrationSelf: true });
    });

    it('never gives an unauthenticated bot an asserted principal identity', () => {
        expect(classifyEmailActor({ headers: headers({ 'auto-submitted': ['auto-generated'] }), from, mailbox, trust: { trusted: false, markersMissing: false } }))
            .toEqual({ principalId: null, kind: 'bot', isIntegrationSelf: false });
    });
});
