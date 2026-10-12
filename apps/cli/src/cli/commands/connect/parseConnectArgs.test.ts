import { describe, expect, it } from 'vitest';

import { parseConnectArgs } from './parseConnectArgs';

describe('parseConnectArgs', () => {
  it('parses explicit native import acquisition without treating source as a target', () => {
    const parsed = parseConnectArgs(['codex', '--import', '--source', 'native']);
    expect(parsed.subcommand).toBe('codex');
    expect(parsed.options).toMatchObject({ import: true, source: 'native' });
  });
  it('refuses native import into an existing opaque account target', () => {
    expect(() => parseConnectArgs(['codex', '--import', '--account', 'account-7'])).toThrow();
    expect(() => parseConnectArgs(['codex', '--import', '--profile', 'work'])).toThrow();
  });
  it('refuses ambiguous native and interactive authentication choices', () => {
    expect(() => parseConnectArgs(['codex', '--source', 'native'])).toThrow();
    expect(() => parseConnectArgs(['codex', '--import', '--mode', 'oauth'])).toThrow();
    expect(() => parseConnectArgs(['codex', '--import', '--source'])).toThrow();
  });
  it('parses --device and --profile and a subcommand', () => {
    const res = parseConnectArgs(['codex', '--device', '--profile', 'work']);
    expect(res.subcommand).toBe('codex');
    expect(res.options.profileId).toBe('work');
    expect(res.options.device).toBe(true);
  });

  it('defaults profile to default', () => {
    const res = parseConnectArgs(['codex']);
    expect(res.options.profileId).toBe('default');
  });

  it('parses --oauth', () => {
    const res = parseConnectArgs(['claude', '--oauth']);
    expect(res.options.oauth).toBe(true);
  });

  it('parses --api-key', () => {
    const res = parseConnectArgs(['claude', '--api-key']);
    expect(res.options.apiKey).toBe(true);
  });

  it('parses --token', () => {
    const res = parseConnectArgs(['github', '--token']);
    expect(res.subcommand).toBe('github');
    expect(res.options.token).toBe(true);
  });

  it('parses an exact reconnect account and an explicit authentication mode', () => {
    const res = parseConnectArgs([
      'happier.plugin/service',
      '--account',
      'account-7',
      '--mode',
      'service-account',
    ]);
    expect(res.subcommand).toBe('happier.plugin/service');
    expect(res.options.accountId).toBe('account-7');
    expect(res.options.modeId).toBe('service-account');
  });
});
