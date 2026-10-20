import type { RegexEngine } from 'shiki';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

export async function createShikiRegexEngine(): Promise<RegexEngine> {
    return createOnigurumaEngine(import('shiki/wasm'));
}
