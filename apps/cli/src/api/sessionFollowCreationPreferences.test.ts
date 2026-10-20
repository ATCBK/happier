import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { bindRequesterSessionCredentialScope, type StoredCredentials } from '@/persistence';
import { createSessionRunReportPolicyReader } from './sessionFollowCreationPreferences';

const accountToken = (id: string) => `header.${Buffer.from(JSON.stringify({ sub: id, session: 'terminal-session' })).toString('base64url')}.signature`;
const credentialsFor = (id = 'owner', serverId = 'home', serverHttpBaseUrl = 'https://home.test') =>
  bindRequesterSessionCredentialScope({ token: accountToken(id), encryption: null }, { serverId, serverHttpBaseUrl });
afterEach(() => { vi.restoreAllMocks(); });

describe('Session-owned Run creation policy Account boundary', () => {
  it('reads the exact captured Home with keyless Account credentials and refuses a later Account switch', async () => {
    let credentials: StoredCredentials = credentialsFor();
    const read = createSessionRunReportPolicyReader({ serverId: 'home', serverHttpBaseUrl: 'https://home.test/', accountId: 'owner',
      readCredentials: async () => credentials, isCurrent: () => true });
    // HTTP is the boundary; schema validation and Account/Home admission stay real.
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, ...DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1,
      runReportPolicy: { preset: 'quiet' },
    } });
    expect(await read()).toEqual({ preset: 'quiet' });
    expect(get).toHaveBeenCalledWith('https://home.test/v2/account/session-follow-preferences', expect.objectContaining({
      headers: { Authorization: `Bearer ${credentials.token}` },
    }));
    get.mockImplementationOnce(async () => {
      credentials = credentialsFor('other');
      return { status: 200, data: { ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1,
        ...DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } };
    });
    await expect(read()).rejects.toMatchObject({ code: 'execution_run_not_allowed' });
  });

  it('refuses another Account or Home before sending its credentials', async () => {
    const get = vi.spyOn(axios, 'get');
    for (const credentials of [credentialsFor('other'), credentialsFor('owner', 'other'),
      credentialsFor('owner', 'home', 'https://other.test')]) {
      const read = createSessionRunReportPolicyReader({ serverId: 'home', serverHttpBaseUrl: 'https://home.test', accountId: 'owner',
        readCredentials: async () => credentials, isCurrent: () => true });
      await expect(read()).rejects.toMatchObject({ code: 'execution_run_not_allowed' });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('does not turn failed or predecessor preference reads into Important', async () => {
    const get = vi.spyOn(axios, 'get');
    const read = createSessionRunReportPolicyReader({ serverId: 'home', serverHttpBaseUrl: 'https://home.test', accountId: 'owner',
      readCredentials: async () => credentialsFor(), isCurrent: () => true });
    for (const response of [{ status: 503, data: {} }, { status: 200, data: DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1 }]) {
      get.mockResolvedValueOnce(response);
      await expect(read()).rejects.toMatchObject({ code: 'execution_run_not_allowed' });
    }
  });
});
