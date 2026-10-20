import type { RegexEngine } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/** Hermes supports match indices; ES2018 avoids the newer RegExp v flag. */
export async function createShikiRegexEngine(): Promise<RegexEngine> {
    return createJavaScriptRegexEngine({ target: 'ES2018' });
}
