import { describe, expect, it } from 'vitest';
import { captureDocPassageV1, locateDocPassageV1, prepareDocEditBodyV1 } from './artifactPassageV1.js';

const ref = { kind: 'doc' as const, artifactId: 'doc', serverId: 'home' };
const revision = { headerVersion: 1, bodyVersion: 2 };
const source = '😀 first **again** / again!';
const start = source.lastIndexOf('again');

describe('revision-qualified Doc source operations', () => {
  it('captures the selected second occurrence from UTF-16 source without searching rendered text', () => {
    expect(captureDocPassageV1({ ref, revision, source, range: { start, end: start + 5 } })).toEqual({
      ref, revision, range: { start, end: start + 5 }, quote: 'again',
    });
    expect(() => captureDocPassageV1({ ref: { kind: 'doc', artifactId: 'doc' }, revision,
      source, range: { start, end: start + 5 } })).toThrow();
    expect(() => captureDocPassageV1({ ref, revision, source, range: { start: 0, end: source.length + 1 } })).toThrow();
  });

  it('never picks the first duplicate when displaying a changed revision', () => {
    const target = captureDocPassageV1({ ref, revision, source, range: { start, end: start + 5 } });
    expect(locateDocPassageV1({ target, source, revision })).toEqual({ state: 'exact', range: target.range });
    const later = { headerVersion: 2, bodyVersion: 3 };
    expect(locateDocPassageV1({ target, source: `intro ${source}`, revision: later })).toEqual({ state: 'detached' });
    expect(locateDocPassageV1({ target: { ...target, prefix: ' / ', suffix: '!' },
      source: `intro ${source}`, revision: later })).toEqual({ state: 'relocated', range: { start: start + 6, end: start + 11 } });
    expect(locateDocPassageV1({ target, source: 'gone', revision: later })).toEqual({ state: 'detached' });
  });

  it('replaces exactly the reviewed source occurrence and refuses either version mismatch', () => {
    const target = captureDocPassageV1({ ref, revision, source, range: { start, end: start + 5 } });
    const proposal = { target, baseRevision: revision, before: 'again', after: 'once', reason: 'Avoid repetition' };
    expect(prepareDocEditBodyV1({ proposal, ref, revision, source })).toBe('😀 first **again** / once!');
    for (const changed of [{ ...revision, headerVersion: 2 }, { ...revision, bodyVersion: 3 }]) {
      expect(() => prepareDocEditBodyV1({ proposal, ref, revision: changed, source })).toThrow('version_mismatch');
    }
    expect(() => prepareDocEditBodyV1({ proposal, ref: { ...ref, serverId: 'other' }, revision, source })).toThrow('server_target_mismatch');
    expect(() => prepareDocEditBodyV1({ proposal, ref, revision, source: source.replace(/again/g, 'other') })).toThrow('doc_passage_mismatch');
  });
});
