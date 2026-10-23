import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { createDeferred } from '@/dev/testkit';

const nativeAlert = vi.hoisted(() => vi.fn<typeof import('react-native')['Alert']['alert']>());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
  { platformOS: 'ios' }, { Alert: { alert: nativeAlert } },
));
const { Modal } = await import('@/modal/ModalManager');
const { fetchAccountEncryptionMode } = await import('@/sync/api/account/apiAccountEncryptionMode');
const { confirmAccountVoiceCredentialWrite } = await import('./confirmAccountVoiceCredentialWrite');

const credentials = { token: 'synthetic-account-token' };
function resolveAccountMode(mode: 'plain' | 'e2ee') {
  return async () => (await fetchAccountEncryptionMode(credentials, { request: async (path, init) => {
    expect(path).toBe('/v1/account/encryption');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + credentials.token);
    return Response.json(AccountEncryptionModeResponseSchema.parse({ mode, updatedAt: 1 }));
  } })).mode;
}
const confirm = () => Modal.confirm('Save credential', 'This Account stores the credential in plaintext.');

describe('confirmAccountVoiceCredentialWrite', () => {
  beforeEach(() => nativeAlert.mockClear());

  it.each([false, true])('requires the actual user decision %s before saving to a plain Account', async accepted => {
    const presented = createDeferred<void>();
    nativeAlert.mockImplementationOnce(() => { presented.resolve(); });
    const pending = confirmAccountVoiceCredentialWrite({
      disclosePlainStorage: true, resolveAccountMode: resolveAccountMode('plain'), confirm,
    });
    await presented.promise;
    expect(nativeAlert).toHaveBeenCalledOnce();
    const buttons = nativeAlert.mock.calls[0]![2]!;
    const button = buttons.find(candidate => accepted ? candidate.style !== 'cancel' : candidate.style === 'cancel');
    expect(button?.onPress).toBeTypeOf('function');
    button!.onPress!();
    await expect(pending).resolves.toBe(accepted);
  });

  it('skips the user decision for E2EE or credentials explicitly exempted from disclosure', async () => {
    await expect(confirmAccountVoiceCredentialWrite({
      disclosePlainStorage: true, resolveAccountMode: resolveAccountMode('e2ee'), confirm,
    })).resolves.toBe(true);
    await expect(confirmAccountVoiceCredentialWrite({
      disclosePlainStorage: false, resolveAccountMode: resolveAccountMode('plain'), confirm,
    })).resolves.toBe(true);
    expect(nativeAlert).not.toHaveBeenCalled();
  });
});
