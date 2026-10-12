import { Buffer } from "node:buffer";

import { SESSION_SYSTEM_RECORD_VERSION_MAX, type ParsedSessionSystemRecordRevision } from "@happier-dev/protocol/sessions/system/records/sessionSystemRecordRevision";

export { parseSessionSystemRecordRevision, isSessionSystemRecordRevisionAtLeastAcknowledged,
    type ParsedSessionSystemRecordRevision } from "@happier-dev/protocol/sessions/system/records/sessionSystemRecordRevision";

const MAX_RECORD_ID_UTF8_BYTES = 512;

export function encodeSessionSystemRecordRevision(input: ParsedSessionSystemRecordRevision): string {
    const idBytes = Buffer.from(input.id, "utf8");
    if (idBytes.byteLength === 0 || idBytes.byteLength > MAX_RECORD_ID_UTF8_BYTES) throw new Error("Invalid record id");
    if (!Number.isInteger(input.version) || input.version < 1 || input.version > SESSION_SYSTEM_RECORD_VERSION_MAX) {
        throw new Error("Invalid record version");
    }
    const bytes = Buffer.allocUnsafe(4 + idBytes.byteLength + 4);
    bytes.writeUInt32BE(idBytes.byteLength, 0);
    idBytes.copy(bytes, 4);
    bytes.writeUInt32BE(input.version, 4 + idBytes.byteLength);
    return `ssr1.${bytes.toString("base64url")}`;
}
