import { RawIngressStructuredInputV1Schema, HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1, normalizeSessionAttachmentUploadPath, sanitizeHappierStructuredInputV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { buildAttachmentMessageMeta, buildUploadedAttachment, type UploadedAttachment } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';
import type { TransferSessionStore } from '@happier-dev/transfers/node';
import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol';
import { SessionStructuredInputAdmissionError } from '../services/admitSessionStructuredInputV1';
import { inferSessionMediaMimeTypeFromName } from '../media/mime';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Missing issuance alone remains ordinary invalid input until preparation proves no original custody. */
export class SessionAttachmentIssuedRecordMissingError extends SessionStructuredInputAdmissionError {
  constructor() {
    super('session_structured_input_session_attachment_invalid');
    this.name = 'SessionAttachmentIssuedRecordMissingError';
  }
}

/** Resolve only issued records. Authored bytes never select a filesystem path. */
export function projectRawIngressSessionAttachmentsV1(params: Readonly<{
  sessionId: string;
  text: string;
  meta: Record<string, unknown>;
  resolveSessionAttachment: (handle: SessionAttachmentHandleV1) => ReturnType<TransferSessionStore['getIssuedAttachment']>;
}>): Readonly<{ text: string; meta: Record<string, unknown>; allowedLocalImagePaths?: ReadonlySet<string> }> {
  const raw = asRecord(params.meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]);
  if (!raw || !Object.hasOwn(raw, 'sessionAttachments')) return { text: params.text, meta: params.meta };
  const parsed = RawIngressStructuredInputV1Schema.safeParse(raw);
  if (!parsed.success) throw new SessionStructuredInputAdmissionError('session_structured_input_session_attachment_invalid');
  const seen = new Set<string>();
  const selection = parsed.data.sessionAttachments ?? [];
  for (const handle of selection) {
    if (handle.sessionId !== params.sessionId || seen.has(handle.id)) {
      throw new SessionStructuredInputAdmissionError('session_structured_input_session_attachment_invalid');
    }
    seen.add(handle.id);
  }
  const uploaded = selection.map(handle => {
    const issued = params.resolveSessionAttachment(handle);
    if (!issued) throw new SessionAttachmentIssuedRecordMissingError();
    const mimeType = issued.mimeType ?? inferSessionMediaMimeTypeFromName(issued.name);
    return buildUploadedAttachment({ id: issued.handle.id, name: issued.name, path: issued.displayPath,
      sizeBytes: issued.sizeBytes, sha256: issued.sha256, attachmentHandle: { ...issued.handle },
      ...(mimeType ? { mimeType } : {}),
    });
  });
  return projectSessionAttachmentInputV1({ text: params.text, meta: params.meta, uploaded });
}

/** The one projection used for live issued uploads and retained original-input descriptors. */
export function projectSessionAttachmentInputV1(params: Readonly<{
  text: string;
  meta: Record<string, unknown>;
  uploaded: readonly UploadedAttachment[];
}>): Readonly<{ text: string; meta: Record<string, unknown>; allowedLocalImagePaths?: ReadonlySet<string> }> {
  const { sessionAttachments: _discardedSelection, ...envelope } =
    asRecord(params.meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]) ?? {};
  const uploaded = params.uploaded;
  if (uploaded.length === 0) return { text: params.text, meta: {
    ...params.meta, [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: envelope,
  } };
  const attachmentMeta = buildAttachmentMessageMeta(uploaded);
  const primary = asRecord(params.meta.happier);
  const slot = params.meta.happier !== undefined ? 'happierAttachments' : 'happier';
  // One incumbent attachment envelope owns one selection. Never overwrite authored siblings.
  if (params.meta.happierAttachments !== undefined || primary?.kind === 'attachments.v1') {
    throw new SessionStructuredInputAdmissionError('session_structured_input_session_attachment_invalid');
  }
  const allowedLocalImagePaths = new Set(uploaded.flatMap(attachment => {
    const path = attachment.structuredInput ? normalizeSessionAttachmentUploadPath(attachment.path) : null;
    return path ? [path] : [];
  }));
  const images = sanitizeHappierStructuredInputV1(attachmentMeta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1], {
    allowedLocalImagePaths,
  })?.imageInputs ?? [];
  return {
    text: params.text,
    meta: {
      ...params.meta, [slot]: attachmentMeta.happier,
      [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { ...envelope,
        ...(images.length ? { imageInputs: [...(Array.isArray(envelope.imageInputs) ? envelope.imageInputs : []), ...images] } : {}),
      },
    },
    allowedLocalImagePaths,
  };
}
