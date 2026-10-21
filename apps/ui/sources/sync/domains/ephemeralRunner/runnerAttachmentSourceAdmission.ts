import type { AttachmentUploadSource, AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';

/** Runner's reviewed manifest/custody contract admits single files, not directory trees. */
export function admitRunnerAttachmentSource(source: AttachmentUploadSource):
    | Readonly<{ ok: true; source: AttachmentsUploadFileSource }>
    | Readonly<{ ok: false; code: 'runner_attachment_unavailable'; reason: 'folder' }> {
    return source.kind === 'folder'
        ? { ok: false, code: 'runner_attachment_unavailable', reason: 'folder' }
        : { ok: true, source };
}
