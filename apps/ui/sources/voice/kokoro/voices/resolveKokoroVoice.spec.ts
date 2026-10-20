import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { KOKORO_WEB_DEFAULT_VOICE_ID, resolveKokoroWebVoiceId } from './resolveKokoroVoice';

describe('resolveKokoroWebVoiceId', () => {
  it('keeps catalog voices and falls back to the kokoro-js default otherwise', () => {
    expect(resolveKokoroWebVoiceId('af_bella', ['af_heart', 'af_bella'])).toBe('af_bella');
    expect(resolveKokoroWebVoiceId('af_maple', ['af_heart', 'af_bella'])).toBe(KOKORO_WEB_DEFAULT_VOICE_ID);
    expect(resolveKokoroWebVoiceId(null, ['af_heart'])).toBe(KOKORO_WEB_DEFAULT_VOICE_ID);
  });

  it('uses the same default voice as the vendored web worker, which cannot import this module', () => {
    const workerSource = fs.readFileSync(new URL('../../../../public/vendor/kokoro/kokoroTtsWorker.js', import.meta.url), 'utf8');
    expect(workerSource).toContain(`const KOKORO_WEB_DEFAULT_VOICE_ID = '${KOKORO_WEB_DEFAULT_VOICE_ID}'`);
  });
});
