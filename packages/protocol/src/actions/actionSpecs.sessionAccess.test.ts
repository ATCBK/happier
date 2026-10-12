import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { projectSessionPublicLinkActionResultV1, projectSessionPublicLinkCreateActionResultV1 } from '../sessions/access/sessionAccessActionsV1.js';
import { bindSessionAccessActionHttpRequestV1 } from './sessionAccessActionFamily.js';

describe('Session access Action contracts', () => {
  it('creates current Session publications only through the generalized owner, never the legacy token writer', () => {
    expect(bindSessionAccessActionHttpRequestV1('session.public_link.create', {
      sessionId: 's/id', maxUses: 3, isConsentRequired: true,
    })).toEqual({ method: 'POST', path: '/v1/public-shares', body: {
      subject: { kind: 'session', id: 's/id' }, maxUses: 3, isConsentRequired: true,
    } });
  });
  it('preserves the default publication wire shape and requires confirmation of a requested network-off policy', () => {
    const input = { sessionId: 's/id', isConsentRequired: false };
    expect(bindSessionAccessActionHttpRequestV1('session.public_link.create', { ...input, networkOff: false }))
      .toEqual(bindSessionAccessActionHttpRequestV1('session.public_link.create', input));
    expect(bindSessionAccessActionHttpRequestV1('session.public_link.create', { ...input, networkOff: true }).body)
      .toMatchObject({ networkOff: true });
    const response = { viewerOrigin: 'https://home.example', publicShare: {
      id: 'publication', updatedAt: 1, expiresAt: null, maxUses: null, useCount: 0,
      isConsentRequired: false, keyDerivation: 'fragment_v1',
    } };
    const material = { lookupId: 'A'.repeat(43), secret: 'B'.repeat(43) };
    expect(() => projectSessionPublicLinkCreateActionResultV1(response, material, true)).toThrow();
    expect(() => projectSessionPublicLinkCreateActionResultV1({ ...response,
      publicShare: { ...response.publicShare, networkOff: false } }, material, true)).toThrow();
    expect(projectSessionPublicLinkCreateActionResultV1(response, material, false)).toMatchObject({
      id: 'publication', viewerOrigin: 'https://home.example', url: `https://home.example/s/${material.lookupId}#k=${material.secret}`,
    });
    expect(projectSessionPublicLinkCreateActionResultV1({ ...response,
      publicShare: { ...response.publicShare, networkOff: true } }, material, true)).toMatchObject({ networkOff: true });
  });
  it('admits logical desired-state grants and excludes host encryption material', () => {
    const id = ActionIdSchema.parse('session.access.grant.set');
    const spec = getActionSpec(id);
    const input = { sessionId: 's', subject: { kind: 'account', accountId: 'a' }, accessLevel: 'edit', canApprovePermissions: false };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, accountEnvelopeInput: {} }).success).toBe(false);
    expect(spec.serverTransport).toEqual({ method: 'POST', path: '/v2/sessions/access-grants/set' });
    expect(spec.requiredAuthority).toBe('account_automation');
    expect(spec.safety).toBe('danger');
  });
  it('keeps publication results free of bearer material', () => {
    const spec = getActionSpec(ActionIdSchema.parse('session.public_link.get'));
    const settings = {
      id: 'publication', updatedAt: 7,
      expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false,
    };
    expect(spec.outputSchema?.safeParse(settings).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ ...settings, token: 'bearer' }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ ...settings, encryptedDataKey: 'key' }).success).toBe(false);
  });
  it('carries the non-secret publication identity a trusted host needs to prove a change', () => {
    // An ambiguous create can only be settled by observing that the
    // authoritative publication is a different row or a later revision than
    // the pre-mutation snapshot. Those two facts are publication metadata,
    // not bearer material, so they belong in the one canonical result.
    const spec = getActionSpec(ActionIdSchema.parse('session.public_link.create'));
    const settings = { expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false };
    expect(spec.outputSchema?.safeParse(settings).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ ...settings, id: 'publication', updatedAt: 7 }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ ...settings, id: 'publication', updatedAt: 7, url: 'https://public.example/s/lookup#k=secret' }).success).toBe(true);
  });
  it('projects publication identity from the released owner response without its bearer', () => {
    const projected = projectSessionPublicLinkActionResultV1({
      publicShare: {
        id: 'publication', sessionId: 's', token: 'bearer',
        expiresAt: 5, maxUses: 3, useCount: 1, isConsentRequired: true,
        createdAt: 1, updatedAt: 9,
      },
    });
    expect(projected).toEqual({
      id: 'publication', updatedAt: 9,
      expiresAt: 5, maxUses: 3, useCount: 1, isConsentRequired: true,
    });
    expect(projectSessionPublicLinkActionResultV1({ publicShare: null })).toBeNull();
  });
});
