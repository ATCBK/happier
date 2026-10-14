import { z } from 'zod/mini';
import { LocalNeuralExecutionSchema } from '../../daemon/voiceInference.js';

import {
  migrateLegacyGoogleSttSettings,
  normalizeLegacySpeechProviderSelection,
} from './migrations/speechProviders.js';
import { VoiceLocalSpeechProviderIdSchema } from './speechProvider.js';

export const VoiceLocalSttProviderSchema = VoiceLocalSpeechProviderIdSchema;
export type VoiceLocalSttProvider = z.infer<typeof VoiceLocalSttProviderSchema>;

const VoiceLocalSttLocalNeuralSchema = z.prefault(z
  .object({
    assetId: z._default(z.nullable(z.string()), 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17'),
    language: z._default(z.nullable(z.string()), null),
    execution: z._default(LocalNeuralExecutionSchema, 'auto'),
  }), {});

const VoiceLocalSttSchemaV3 = z.object({
  provider: z._default(VoiceLocalSttProviderSchema, 'device'),
  localNeural: VoiceLocalSttLocalNeuralSchema,
});

type VoiceLocalSttV3 = z.infer<typeof VoiceLocalSttSchemaV3>;

function migrateLegacyLocalStt(input: Record<string, unknown>): VoiceLocalSttV3 {
  const useDeviceStt = input.useDeviceStt === true;

  return {
    provider: useDeviceStt ? 'device' : 'happier.voice.openai-compat/stt',
    localNeural: { assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17', language: null, execution: 'auto' },
  };
}

export const VoiceLocalSttSchema = z.pipe(z.transform((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = migrateLegacyGoogleSttSettings(raw as Record<string, unknown>);

  // Released predecessor rows may still carry inline provider configuration.
  // Current role settings retain only selection and local-neural/device fields;
  // the root Voice settings ingress migrates provider configuration separately.
  if ('provider' in obj || 'localNeural' in obj) {
    return {
      ...obj,
      ...(typeof obj.provider === 'string'
        ? { provider: normalizeLegacySpeechProviderSelection('stt', obj.provider) }
        : {}),
    };
  }

  // Legacy shape (flat openai-compat fields + `useDeviceStt` toggle).
  if ('baseUrl' in obj || 'useDeviceStt' in obj || 'model' in obj || 'apiKey' in obj) {
    return migrateLegacyLocalStt(obj);
  }

  return obj;
}), VoiceLocalSttSchemaV3);

export type VoiceLocalSttSettings = z.infer<typeof VoiceLocalSttSchema>;
