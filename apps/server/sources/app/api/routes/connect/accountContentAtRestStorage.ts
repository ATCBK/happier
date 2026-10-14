import type { StoredJsonContentEnvelope } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';

import { encodeSensitiveContentForAtRestStorage } from "@/app/encryption/sensitiveContentAtRestStorage";

// Existing Connected Account callers retain their Account-mode contract; the
// neutral owner also supports independently mode-owned sensitive resources.
export {
    decodeSensitiveContentFromAtRestStorage as decodeAccountContentFromAtRestStorage,
    SensitiveContentAtRestStorageError as AccountContentAtRestStorageError,
} from "@/app/encryption/sensitiveContentAtRestStorage";

export function encodeAccountContentForAtRestStorage(params: Readonly<{
    accountMode: "plain" | "e2ee";
    keyPath: string[];
    content: StoredJsonContentEnvelope;
}>): string {
    return encodeSensitiveContentForAtRestStorage({
        contentMode: params.accountMode,
        keyPath: params.keyPath,
        content: params.content,
    });
}
