import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

describe('resolveLocalSttProvider', () => {
  function settingsWithStt(stt: unknown) {
    return { voice: { providerId: 'local_direct', adapters: { local_direct: { stt } } } };
  }

  it('keeps the chosen provider when an unrelated provider sub-config is malformed', async () => {
    const { resolveLocalSttProvider } = await import('./localVoiceSettings');

    expect(resolveLocalSttProvider(settingsWithStt({ provider: 'local_neural', openaiCompat: { baseUrl: 42 } }))).toBe('local_neural');
  });

  it('maps the legacy device toggle through the settings schema migration', async () => {
    const { resolveLocalSttProvider } = await import('./localVoiceSettings');

    expect(resolveLocalSttProvider(settingsWithStt({ baseUrl: 'http://x', useDeviceStt: true }))).toBe('device');
  });
});
