import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { run as runRipgrep } from '@/integrations/ripgrep/index';
import { computeFileReplacement, decodeReplaceFileText } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import { applyInverseEdits } from '@happier-dev/protocol/diff/hunks';
import { isFilesystemWriteGuardErrorCode } from '@happier-dev/protocol/actions';
import { DaemonWorkspaceFileReplacePreviewRequestSchema, DaemonWorkspaceFileReplaceApplyRequestSchema,
  WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES,
  type DaemonWorkspaceFileReplacePreviewResponse, type DaemonWorkspaceFileReplaceApplyResponse } from '@happier-dev/protocol/machines/workspaceFiles';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath, authorizeFilesystemPathWithinRoot } from './fileSystem/accessPolicy/filesystemPathAuthorization';
import { isSafeRelativeWorkspacePath, workspaceFileExclusionArguments } from './workspaceFilePaths';
import { commitGuardedFileReplace } from './fileSystem/commitGuardedFileReplace';

const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const responseBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
type ApplySuccess = Extract<DaemonWorkspaceFileReplaceApplyResponse, { ok: true }>;
type FileResult = ApplySuccess['results'][number];
type PreviewSuccess = Extract<DaemonWorkspaceFileReplacePreviewResponse, { ok: true }>;

function readErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function fileResultBytes(result: FileResult): number {
  if (!result.edits) return responseBytes(result);
  let size = responseBytes({ ...result, edits: [] });
  for (let index = 0; index < result.edits.length; index++) {
    const edit = result.edits[index];
    if (edit.insertText.length + edit.originalText.length > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) return WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES + 1;
    size += responseBytes(edit) + (index ? 1 : 0);
    if (size > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) break;
  }
  return size;
}

export function registerWorkspaceFileReplaceHandlers(
  registrar: RpcHandlerRegistrar,
  workingDirectory: string,
  opts?: Readonly<{ accessPolicy?: FilesystemAccessPolicy }>,
): void {
  const accessPolicy = opts?.accessPolicy ?? { kind: 'osUser' as const };
  registrar.registerHandler<unknown, DaemonWorkspaceFileReplacePreviewResponse>(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW, async (raw, context) => {
    const parsed = DaemonWorkspaceFileReplacePreviewRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'invalid_pattern' };
    const request = parsed.data;
    const root = authorizeFilesystemPath({ targetPath: request.rootPath, defaultDirectory: workingDirectory, accessPolicy });
    if (!root.valid) return { ok: false, code: 'root_not_allowed' };
    const matcher = { query: request.query, replacement: request.replacement, matchCase: request.matchCase ?? false, regex: request.regex ?? false };
    const files: PreviewSuccess['files'] = [];
    const skipped = { notText: 0 };
    let coverage: PreviewSuccess['coverage'] = 'complete';
    let lastPath = request.cursor?.path;
    try {
      // Validate even an empty corpus through the one JavaScript matcher.
      computeFileReplacement(new Uint8Array(), matcher);
      // Rust and JavaScript regexes can disagree even when both compile (for
      // example Unicode word boundaries), and rg omits empty files from queried
      // results. Inventory regex candidates so the JS owner alone decides hits.
      const discovery = await runRipgrep(['--no-config', '--null',
        ...(request.includeHidden ? ['--hidden'] : []), ...workspaceFileExclusionArguments(),
        ...(matcher.regex ? ['--files', '--', '.'] : ['--files-with-matches', '--binary', '--fixed-strings',
          ...(!matcher.matchCase ? ['--ignore-case'] : []), '--', request.query, '.'])], {
        cwd: root.resolvedPath, signal: context?.signal, maxStderrBytes: WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES,
      });
      if (discovery.exitCode === 127) return { ok: false, code: 'ripgrep_unavailable' };
      if (discovery.exitCode !== 0 && discovery.exitCode !== 1) {
        if (discovery.exitCode !== 2 || !discovery.stdout) return { ok: false, code: 'ripgrep_failed' };
        coverage = 'partial';
      }
      const paths = [...new Set(discovery.stdout.split('\0').filter(Boolean).map(path => path.replace(/\\/g, '/').replace(/^\.\//u, '')))].sort();
      const longestCursor = paths.reduce((longest, path) => responseBytes(path) > responseBytes(longest) ? path : longest, '');
      // Reserve the largest envelope produced by this scan. Measure each
      // bounded match once, never stringify an oversized repeated-line page.
      const envelopeBytes = responseBytes({ ok: true, files: [], skipped: { notText: paths.length }, hasMore: false, coverage: 'complete', cursor: { path: longestCursor } });
      let filesBytes = 0;
      for (const path of paths) {
        context?.signal.throwIfAborted();
        if (request.cursor && path <= request.cursor.path) continue;
        const authorization = isSafeRelativeWorkspacePath(path)
          ? authorizeFilesystemPathWithinRoot({ targetPath: path, rootPath: root.resolvedPath, defaultDirectory: workingDirectory, accessPolicy })
          : { valid: false as const };
        if (!authorization.valid) { coverage = 'partial'; lastPath = path; continue; }
        let bytes: Buffer;
        try { bytes = await readFile(authorization.resolvedPath); } catch { coverage = 'partial'; lastPath = path; continue; }
        const replacement = computeFileReplacement(bytes, matcher);
        if (replacement.kind === 'skip') { skipped.notText++; coverage = 'partial'; lastPath = path; continue; }
        if (!replacement.matches.length) { lastPath = path; continue; }
        const count = request.contextLines ?? 2;
        const file: PreviewSuccess['files'][number] = { path, hash: hashBytes(bytes), matchCount: replacement.matches.length, matches: [] };
        let fileBytes = responseBytes(file);
        for (const match of replacement.matches) {
          const projected = { ...match, before: count ? match.before.slice(-count) : [], after: match.after.slice(0, count) };
          // Every UTF-16 unit needs at least one UTF-8/JSON byte. This cheap
          // lower bound avoids constructing enormous single-match JSON too.
          if ([projected.text, projected.replacedText, ...projected.before, ...projected.after].reduce((sum, text) => sum + text.length, 0) > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
            fileBytes = WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES + 1; break;
          }
          fileBytes += responseBytes(projected) + (file.matches.length ? 1 : 0);
          if (envelopeBytes + fileBytes > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) break;
          file.matches.push(projected);
        }
        if (envelopeBytes + fileBytes > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
          // An indivisible file cannot travel in this RPC's response; preserve
          // explicit incomplete coverage rather than select unloaded matches.
          coverage = 'partial'; lastPath = path; continue;
        }
        const additionBytes = fileBytes + (files.length ? 1 : 0);
        if (envelopeBytes + filesBytes + additionBytes > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
          return { ok: true, files, skipped, hasMore: true, coverage: 'partial', cursor: { path: lastPath! } };
        }
        files.push(file); filesBytes += additionBytes; lastPath = path;
      }
      return { ok: true, files, skipped, hasMore: false, coverage };
    } catch (error) {
      if (context?.signal.aborted || error instanceof Error && error.name === 'AbortError') throw error;
      if (readErrorCode(error) === 'WORKSPACE_ROOT_NOT_FOUND') return { ok: false, code: 'root_not_found' };
      return { ok: false, code: error instanceof SyntaxError ? 'invalid_pattern' : 'ripgrep_failed' };
    }
  });
  registrar.registerHandler<unknown, DaemonWorkspaceFileReplaceApplyResponse>(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY, async (raw, context) => {
    const parsed = DaemonWorkspaceFileReplaceApplyRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { rootPath, operation } = parsed.data;
    const root = authorizeFilesystemPath({ targetPath: rootPath, defaultDirectory: workingDirectory, accessPolicy });
    if (!root.valid) return { ok: false, code: 'root_not_allowed' };
    if (operation.kind === 'replace') {
      try { computeFileReplacement(new Uint8Array(), { ...operation.matcher, matchCase: operation.matcher.matchCase ?? false, regex: operation.matcher.regex ?? false }); }
      catch (error) { if (error instanceof SyntaxError) return { ok: false, code: 'invalid_pattern' }; throw error; }
    }
    const results: FileResult[] = [];
    for (let index = 0; index < operation.files.length; index++) {
      if (context?.signal.aborted) return { ok: true, results, cancelled: operation.files.slice(index).map(file => file.path) };
      const file = operation.files[index];
      const authorization = authorizeFilesystemPathWithinRoot({ targetPath: file.path, rootPath: root.resolvedPath, defaultDirectory: workingDirectory, accessPolicy });
      if (!authorization.valid) { results.push({ path: file.path, status: 'failed', reason: 'path_not_allowed' }); continue; }
      try {
        const bytes = await readFile(authorization.resolvedPath);
        if (hashBytes(bytes) !== file.expectedHash) { results.push({ path: file.path, status: 'changed' }); continue; }
        let newBytes: Uint8Array;
        let result: FileResult;
        if (operation.kind === 'replace') {
          const selected = operation.files[index];
          const replacement = computeFileReplacement(bytes, { ...operation.matcher, matchCase: operation.matcher.matchCase ?? false, regex: operation.matcher.regex ?? false }, selected.excludedMatches);
          if (replacement.kind === 'skip') { results.push({ path: file.path, status: 'skipped', reason: replacement.reason }); continue; }
          if (!replacement.matches.length) { results.push({ path: file.path, status: 'changed' }); continue; }
          newBytes = replacement.newBytes;
          result = { path: file.path, status: 'replaced', hash: hashBytes(newBytes), matchCount: replacement.matches.length, edits: [...replacement.edits] };
        } else {
          const decoded = decodeReplaceFileText(bytes);
          if (decoded.kind === 'skip') { results.push({ path: file.path, status: 'skipped', reason: decoded.reason }); continue; }
          const restored = applyInverseEdits(decoded.text, operation.files[index].edits);
          if (!restored.ok) { results.push({ path: file.path, status: 'changed', reason: restored.reason }); continue; }
          newBytes = new TextEncoder().encode(restored.text);
          result = { path: file.path, status: 'restored', hash: hashBytes(newBytes) };
        }
        const remaining = operation.files.slice(index + 1).map(next => ({ path: next.path, status: 'failed', reason: 'transport_ceiling' }));
        const otherResultsBytes = responseBytes({ ok: true, results: [...results, ...remaining] });
        if (otherResultsBytes + fileResultBytes(result) + (results.length + remaining.length ? 1 : 0) > WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES) {
          results.push({ path: file.path, status: 'failed', reason: 'transport_ceiling' }); continue;
        }
        const write = await commitGuardedFileReplace({ destPath: authorization.resolvedPath, expectation: file.expectedHash, source: { kind: 'bytes', bytes: newBytes } });
        if (write.success) results.push({ ...result, hash: write.hash });
        else results.push({ path: file.path, status: isFilesystemWriteGuardErrorCode(write.errorCode) ? 'changed' : 'failed', reason: write.errorCode ?? 'write_failed' });
      } catch (error) {
        results.push({ path: file.path, status: ['ENOENT', 'ENOTDIR'].includes(readErrorCode(error) ?? '') ? 'changed' : 'failed',
          reason: error instanceof SyntaxError ? 'invalid_pattern' : readErrorCode(error) ?? 'read_failed' });
      }
    }
    return { ok: true, results };
  });
}
