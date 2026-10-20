import { expect, it } from 'vitest';

import { isRequesterLaunchAdmissionCurrent } from './requesterWorkAttribution';

it('preserves transient Home failures instead of interpreting them as a rejected launch principal', async () => {
  await expect(isRequesterLaunchAdmissionCurrent({ verifyRequesterMachineAdmissionCurrent: async () => {
    throw Object.assign(new Error('Home unavailable'), { response: { status: 503 } });
  } })).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
});

it('retains refused launch admission for revoked access, authentication failure and unknown errors', async () => {
  expect(await isRequesterLaunchAdmissionCurrent({ verifyRequesterMachineAdmissionCurrent: async () => false })).toBe(false);
  for (const error of [Object.assign(new Error('Forbidden'), { response: { status: 403 } }),
    new Error('Unexpected admission failure'), Object.assign(new Error('Cancelled'), { name: 'AbortError' })]) {
    expect(await isRequesterLaunchAdmissionCurrent({ verifyRequesterMachineAdmissionCurrent: async () => { throw error; } })).toBe(false);
  }
  expect(await isRequesterLaunchAdmissionCurrent({})).toBe(true);
});
