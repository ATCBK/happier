import { describe, expect, it } from 'vitest';

import { mapMarkdownSourceToRenderedRange, mapRenderedSelectionToMarkdownSource } from './markdownSelectionSource';

const markdown = [
  '# Runbook',
  '',
  'A replay shows one row. A replay shows **one** row.',
  '',
  '- **Retrying…** Pending retries show “Retrying…”.',
  '1. Check the dashboard.',
].join('\n');

/** What a browser puts in the body's text: no block separators, list marks drawn as glyphs. */
const rendered =
  'RunbookA replay shows one row. A replay shows one row.•Retrying… Pending retries show “Retrying…”.1.Check the dashboard.';

function select(text: string, occurrence = 0) {
  let start = -1;
  for (let index = 0; index <= occurrence; index++)
    start = rendered.indexOf(text, start + 1);
  return { start, end: start + text.length };
}

describe('mapRenderedSelectionToMarkdownSource', () => {
  it('maps a selection by its position, so a repeated phrase resolves to the one selected', () => {
    const second = mapRenderedSelectionToMarkdownSource({
      markdown,
      rendered,
      ...select('A replay shows one row.', 1),
    });
    expect(second).toEqual({
      start: markdown.lastIndexOf('A replay shows'),
      end: markdown.lastIndexOf('row.') + 4,
    });
    expect(markdown.slice(second!.start, second!.end)).toBe(
      'A replay shows **one** row.',
    );
    const first = mapRenderedSelectionToMarkdownSource({
      markdown,
      rendered,
      ...select('A replay shows one row.', 0),
    });
    expect(markdown.slice(first!.start, first!.end)).toBe(
      'A replay shows one row.',
    );
  });

  it('skips glyphs the renderer draws but the source does not have', () => {
    const range = mapRenderedSelectionToMarkdownSource({
      markdown,
      rendered,
      ...select('Check the dashboard'),
    });
    expect(markdown.slice(range!.start, range!.end)).toBe(
      'Check the dashboard',
    );
  });

  it('keeps inline markup a selection crosses inside the source range', () => {
    const range = mapRenderedSelectionToMarkdownSource({
      markdown,
      rendered,
      ...select('Retrying… Pending'),
    });
    expect(markdown.slice(range!.start, range!.end)).toBe(
      'Retrying…** Pending',
    );
  });

  it('refuses a selection it cannot place exactly', () => {
    expect(
      mapRenderedSelectionToMarkdownSource({
        markdown,
        rendered: 'Something else entirely',
        start: 0,
        end: 9,
      }),
    ).toBeNull();
    expect(
      mapRenderedSelectionToMarkdownSource({
        markdown,
        rendered,
        start: 4,
        end: 4,
      }),
    ).toBeNull();
    expect(
      mapRenderedSelectionToMarkdownSource({
        markdown,
        rendered,
        start: 8,
        end: 9,
      }),
    ).toBeNull();
  });
});
describe('native block selections within the full Doc grammar', () => {
  it('maps the second reference label in its admitted source window without losing document link definitions', () => {
    const markdown = '# Earlier\n\n[shown][ref] and [shown][ref].\n\n[ref]: https://example.test';
    const rendered = '\nshown and shown.\n';
    const start = rendered.lastIndexOf('shown');
    const input = { markdown, rendered, start, end: start + 5,
      sourceRange: { start: markdown.indexOf('[shown]'), end: markdown.indexOf('\n\n[ref]') } };
    expect(mapRenderedSelectionToMarkdownSource(input)).toEqual({ start: markdown.lastIndexOf('[shown]') + 1, end: markdown.lastIndexOf('[shown]') + 6 });
  });
});

describe('mapMarkdownSourceToRenderedRange', () => {
  it('places a stored source passage on the rendered occurrence it came from, never a repeated phrase', () => {
    const start = markdown.lastIndexOf('A replay shows');
    const end = markdown.lastIndexOf('row.') + 4;
    expect(mapMarkdownSourceToRenderedRange({ markdown, rendered, start, end })).toEqual(select('A replay shows one row.', 1));
    const first = markdown.indexOf('A replay shows');
    expect(mapMarkdownSourceToRenderedRange({ markdown, rendered, start: first, end: first + 'A replay shows one row.'.length }))
      .toEqual(select('A replay shows one row.', 0));
  });

  it('round-trips a selection, including inline markup it crosses', () => {
    const range = mapRenderedSelectionToMarkdownSource({ markdown, rendered, ...select('Retrying… Pending') })!;
    expect(mapMarkdownSourceToRenderedRange({ markdown, rendered, ...range })).toEqual(select('Retrying… Pending'));
  });

  it('reports nothing when the rendered text does not carry the passage', () => {
    expect(mapMarkdownSourceToRenderedRange({ markdown, rendered: 'Something else entirely', start: 10, end: 20 })).toBeNull();
    expect(mapMarkdownSourceToRenderedRange({ markdown, rendered, start: 3, end: 3 })).toBeNull();
  });
});
