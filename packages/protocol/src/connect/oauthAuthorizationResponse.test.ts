import { describe, expect, it } from 'vitest';
import { parseOauthAuthorizationResponse } from './oauthAuthorizationResponse.js';

describe('OAuth authorization response issuer', () => {
  it.each(['?code=code&state=attempt.random&iss=https%3A%2F%2Fissuer.example', '#code=code&state=attempt.random&iss=https%3A%2F%2Fissuer.example'])(
    'preserves issuer from the callback %s', (query) => {
      expect(parseOauthAuthorizationResponse({ input: `https://app.happier.dev/oauth/mcp/callback${query}` })).toEqual({
        kind: 'callback', code: 'code', state: 'attempt.random', iss: 'https://issuer.example',
      });
    },
  );
  it('preserves issuer on error responses for admission before displaying provider errors', () => {
    expect(parseOauthAuthorizationResponse({ input: 'https://app.happier.dev/oauth/mcp/callback?error=access_denied&iss=https%3A%2F%2Fevil.example' }))
      .toEqual({ kind: 'callback', error: 'access_denied', iss: 'https://evil.example' });
  });
  it('does not reinterpret a present empty issuer as omission', () => {
    expect(parseOauthAuthorizationResponse({ input: 'https://app.happier.dev/oauth/mcp/callback?code=code&state=state&iss=' }))
      .toEqual({ kind: 'callback', code: 'code', state: 'state', iss: '' });
  });
});
