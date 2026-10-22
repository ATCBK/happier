import { describe, expect, it } from 'vitest';

import {
  decodeCodexExternalForwardCursor,
  encodeCodexExternalForwardCursor,
} from './transcript.js';

describe('Codex external-session transcript helpers', () => {
  it('round-trips the anchored generation-fenced rollout stream vector cursor', () => {
    const cursor = encodeCodexExternalForwardCursor({
      v: 7,
      kind: 'codexForwardStreamVector',
      sourceGeneration: ['home-generation', 'sessions-generation'],
      streams: [{
        fileRelPath: 'sessions/2026/07/23/rollout-session.jsonl',
        physicalGeneration: '1:2:3',
        nextOffsetBytes: 42,
        subIndex: 1,
        fingerprintOffsetBytes: 84,
        contentFingerprint: 'a'.repeat(64),
      }],
    });

    expect(decodeCodexExternalForwardCursor(cursor)).toEqual({
      v: 7,
      kind: 'codexForwardStreamVector',
      sourceGeneration: ['home-generation', 'sessions-generation'],
      streams: [{
        fileRelPath: 'sessions/2026/07/23/rollout-session.jsonl',
        physicalGeneration: '1:2:3',
        nextOffsetBytes: 42,
        subIndex: 1,
        fingerprintOffsetBytes: 84,
        contentFingerprint: 'a'.repeat(64),
      }],
    });
  });

  it('rejects empty anchored forward vectors', () => {
    const encodeRaw = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

    expect(decodeCodexExternalForwardCursor(encodeRaw({
      v: 7,
      kind: 'codexForwardStreamVector',
      sourceGeneration: ['home-generation', 'sessions-generation'],
      streams: [],
    }))).toBeNull();
  });

  it('rejects semantic row references beyond the acknowledged stream watermark', () => {
    const cursor = { v: 7, kind: 'codexForwardStreamVector', sourceGeneration: ['home-generation'], streams: [{
      fileRelPath: 'sessions/rollout.jsonl', physicalGeneration: '1:2:3', nextOffsetBytes: 42, subIndex: 0,
      fingerprintOffsetBytes: 42, contentFingerprint: 'a'.repeat(64), semanticState: { precedingTimestampMs: 0,
        locations: { assistant: { startOffsetBytes: 30, endOffsetBytes: 43 }, pending: [], startedThreadIds: [], completedThreadIds: [] } },
    }] };
    expect(decodeCodexExternalForwardCursor(Buffer.from(JSON.stringify(cursor)).toString('base64url'))).toBeNull();
  });

  it('rejects writer-impossible whole-line forward offsets', () => {
    const encodeRaw = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

    expect(decodeCodexExternalForwardCursor(encodeRaw({
      v: 7,
      kind: 'codexForwardStreamVector',
      sourceGeneration: ['home-generation', 'sessions-generation'],
      streams: [{
        fileRelPath: 'sessions/2026/07/23/rollout-session.jsonl',
        physicalGeneration: '1:2:3',
        nextOffsetBytes: 42,
        subIndex: 0,
        fingerprintOffsetBytes: 84,
        contentFingerprint: 'a'.repeat(64),
      }],
    }))).toBeNull();
  });

  it('refuses to reuse provenance-pinned released forward cursor offsets', () => {
    // Golden vectors from released cli-v0.2.1 (b1d15a8),
    // apps/cli/src/backends/codex/directSessions/codexDirectForwardCursor.ts.
    // v1/v3 carry no rollout generation or content anchor, so this decoder
    // must never hand their byte offsets back to the reader: it rejects them
    // and the caller resets against current rollout bytes instead.
    expect(decodeCodexExternalForwardCursor(
      'eyJ2IjoxLCJraW5kIjoiY29kZXhGb3J3YXJkIiwiZmlsZVJlbFBhdGgiOiJzZXNzaW9ucy8yMDI2LzAyLzE4L3JvbGxvdXQtMjAyNi0wMi0xOFQwOC0yOC0wNS01NTU1NTU1NS01NTU1LTU1NTUtNTU1NS01NTU1NTU1NTU1NTUuanNvbmwiLCJvZmZzZXRCeXRlcyI6MTIzfQ',
    )).toBeNull();
    expect(decodeCodexExternalForwardCursor(
      'eyJ2IjozLCJraW5kIjoiY29kZXhGb3J3YXJkTWVyZ2VkIiwibGFzdENyZWF0ZWRBdE1zIjoxNzcxNDAzMjg1MDAwLCJsYXN0SWQiOiJjb2RleDpzZXNzaW9ucy8yMDI2LzAyLzE4L3JvbGxvdXQtMjAyNi0wMi0xOFQwOC0yOC0wNS01NTU1NTU1NS01NTU1LTU1NTUtNTU1NS01NTU1NTU1NTU1NTUuanNvbmw6MDAwMDAwMDAwMDAwOjAwMCJ9',
    )).toBeNull();
    // v2 is still the cursor the current app-server path writes, so it keeps
    // decoding to its exact released shape.
    expect(decodeCodexExternalForwardCursor(
      'eyJ2IjoyLCJraW5kIjoiY29kZXhGb3J3YXJkQXBwU2VydmVyIiwidXBkYXRlZEF0TXMiOjE3MzYwMDAxMDAwMDAsInByZXZpZXdUZXh0IjoiUmVsZWFzZWQgcHJldmlldyJ9',
    )).toEqual({
      v: 2,
      kind: 'codexForwardAppServer',
      updatedAtMs: 1_736_000_100_000,
      previewText: 'Released preview',
    });
  });

});
