import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { SkillFileInputV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

/** A text file as a `skills.*` file input (the bundle's base64 carrier). */
export function skillTextFile(path: string, text: string, unixMode?: number | null): SkillFileInputV1 {
    return { path, contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode(text)),
        ...(unixMode != null ? { unixMode } : {}) };
}

export function readSkillText(contentBase64: string): string {
    return new TextDecoder().decode(decodeBase64(contentBase64));
}

/** A file whose mode carries an exec bit runs as a script (IR-7, the bundle's one carrier). */
export function isSkillScript(unixMode: number | undefined | null): boolean {
    return unixMode != null && (unixMode & 0o111) !== 0;
}
