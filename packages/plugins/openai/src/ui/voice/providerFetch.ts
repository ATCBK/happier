import { Platform } from 'react-native';

export const openAiProviderFetch: typeof globalThis.fetch = async (input, init) => {
  if (Platform.OS === 'web') return globalThis.fetch(input, init);
  // Native signaling keeps Expo's redirect/cancellation behavior. Its native
  // module must not be evaluated by the portable artifact on the web.
  const { fetch } = await import('expo/fetch');
  return fetch(input, init);
};
