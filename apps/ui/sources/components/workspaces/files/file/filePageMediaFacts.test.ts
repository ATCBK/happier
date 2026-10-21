import { describe, expect, it } from 'vitest';

import { resolveFileViewerKind } from '@/scm/utils/filePresentation';

import { formatFilePageBytes } from './FilePageStates';
import { resolveFilePageMediaFacts } from './filePageMediaFacts';

function viewer(path: string) {
  return resolveFileViewerKind({ path });
}

describe('resolveFilePageMediaFacts', () => {
  it('names a recording by its format, then its length once the player knows it (lab FV6a)', () => {
    const before = resolveFilePageMediaFacts({
      viewer: viewer('assets/chime.wav'),
      sizeBytes: 345_970,
    });
    expect(before).toEqual(['WAV audio', formatFilePageBytes(345_970)]);
    const after = resolveFilePageMediaFacts({
      viewer: viewer('assets/chime.wav'),
      sizeBytes: 345_970,
      media: { durationSeconds: 2.4 },
    });
    expect(after).toEqual(['WAV audio', '0:02', formatFilePageBytes(345_970)]);
    expect(
      resolveFilePageMediaFacts({
        viewer: viewer('docs/media/voice-walkthrough.m4a'),
        sizeBytes: null,
        media: { durationSeconds: 198 },
      }),
    ).toEqual(['AAC audio', '3:18']);
  });

  it('gives a video its frame size, format and length (lab FV6)', () => {
    expect(
      resolveFilePageMediaFacts({
        viewer: viewer('assets/intro-loop.mp4'),
        sizeBytes: 55_848,
        media: { durationSeconds: 4, width: 1280, height: 720 },
      }),
    ).toEqual([
      '1280 × 720',
      'MPEG-4 video',
      '0:04',
      formatFilePageBytes(55_848),
    ]);
    // Before the player has loaded it says only what the classifier and the stat know.
    expect(
      resolveFilePageMediaFacts({ viewer: viewer('clip.mov'), sizeBytes: 10 }),
    ).toEqual(['QuickTime video', formatFilePageBytes(10)]);
  });

  it("keeps a picture's facts: its pixels, kind, size and the integer scale it is shown at (lab FV4, FV4s)", () => {
    expect(
      resolveFilePageMediaFacts({
        viewer: viewer('assets/logo-dark.svg'),
        sizeBytes: 1046,
        image: { width: 646, height: 854, displayScale: 1, pixelated: false },
      }),
    ).toEqual(['646 × 854', 'SVG image', formatFilePageBytes(1046)]);
    expect(
      resolveFilePageMediaFacts({
        viewer: viewer('assets/favicon-16.png'),
        sizeBytes: 197,
        image: { width: 16, height: 16, displayScale: 4, pixelated: true },
      }),
    ).toEqual([
      '16 × 16',
      'PNG image',
      formatFilePageBytes(197),
      'Shown at 4×',
    ]);
  });

  it("lets a PDF's page count stand for its kind once the viewer knows it (lab FV5)", () => {
    expect(
      resolveFilePageMediaFacts({
        viewer: viewer('docs/retry-guide.pdf'),
        sizeBytes: 2048,
        pdfPageCount: 14,
      }),
    ).toEqual(['14 pages', formatFilePageBytes(2048)]);
  });
});
