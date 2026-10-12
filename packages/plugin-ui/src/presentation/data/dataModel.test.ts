import { describe, expect, it } from 'vitest';

import {
  describeHappierDataChart,
  formatHappierDataBytes,
  formatHappierDataBytesParts,
  formatHappierDataShare,
  formatHappierDataValue,
  resolveHappierDataShares,
  resolveHappierDataTableColumns,
  resolveHappierSeriesGeometry,
} from './dataModel.js';

describe('shared data presentation rules', () => {
  it('normalizes stacked observations without treating a comparison overlay as another part', () => {
    const geometry = resolveHappierSeriesGeometry([
      { id: 'observed', label: 'Mean', points: [{ id: 'a', x: 0, y: 20 }] },
      { id: 'maximum', label: 'Maximum', overlay: true, points: [{ id: 'a', x: 0, y: 80 }] },
    ], { width: 100, height: 100, variant: 'area', normalized: true });
    expect(geometry.buckets[0]!.values).toMatchObject([
      { value: 20, lower: 0, upper: 1 }, { value: 80, lower: 0, upper: 4 },
    ]);
  });
  it('reads numbers in the reader locale and shares against the largest value shown', () => {
    expect(formatHappierDataValue(1284, 'en-US')).toBe('1,284');
    expect(formatHappierDataValue(1284, 'de-DE')).toBe('1.284');
    expect(formatHappierDataValue('Team')).toBe('Team');
    expect(resolveHappierDataShares([1284, 812, 0, -3])).toEqual([1, 812 / 1284, 0, 0]);
    expect(resolveHappierDataShares([0, 0])).toEqual([0, 0]);
    expect(formatHappierDataShare(812 / 1284, 'en-US')).toBe('63%');
  });

  it('drops secondary columns first on a narrow table, never the name, and keeps every column before measuring', () => {
    const columns = [{ label: 'Person' }, { label: 'Plan', priority: 'secondary' as const }, { label: 'Got to' }, { label: 'Joined' }];
    const rows = [['Mira Kovač', 'Team', 'Paired 2 machines', '10:38']];
    const input = { columns, rows, characterWidth: 7, gap: 8 };
    expect(resolveHappierDataTableColumns({ ...input, availableWidth: null })).toEqual([0, 1, 2, 3]);
    expect(resolveHappierDataTableColumns({ ...input, availableWidth: 600 })).toEqual([0, 1, 2, 3]);
    expect(resolveHappierDataTableColumns({ ...input, availableWidth: 260 })).toEqual([0, 2, 3]);
    expect(resolveHappierDataTableColumns({ ...input, availableWidth: 40 })).toEqual([0]);
  });

  it('names every point through the retained public chart-description helper', () => {
    expect(describeHappierDataChart('Signups per day', [{ x: 'Tue', y: 236 }, { x: 'Wed', y: 1183 }], 'en-US'))
      .toBe('Signups per day: Tue 236, Wed 1,183');
  });

  it('reads bytes in the base the quantity kind sets: storage decimal, memory binary', () => {
    // A 1 TB drive is "1 TB" and a 128 GiB machine is "128 GB", as the OS and drive vendor show them.
    expect(formatHappierDataBytes(1_000_000_000_000, { kind: 'storage', locale: 'en-US' })).toBe('1 TB');
    expect(formatHappierDataBytes(128 * 1024 ** 3, { kind: 'memory', locale: 'en-US' })).toBe('128 GB');
    expect(formatHappierDataBytes(128 * 1024 ** 3, { kind: 'storage', locale: 'en-US' })).toBe('137 GB');
    // Three significant figures at and above one unit; a whole value drops trailing zeroes.
    expect(formatHappierDataBytes(58_400_000_000, { kind: 'storage', locale: 'en-US' })).toBe('58.4 GB');
    expect(formatHappierDataBytes(17_640_000_000, { kind: 'storage', locale: 'en-US' })).toBe('17.6 GB');
    expect(formatHappierDataBytes(71.26 * 1024 ** 3, { kind: 'memory', locale: 'en-US' })).toBe('71.3 GB');
    expect(formatHappierDataBytes(99.97 * 1024 ** 2, { kind: 'memory', locale: 'en-US' })).toBe('100 MB');
    expect(formatHappierDataBytes(3.84 * 1024 ** 3, { kind: 'memory', locale: 'en-US' })).toBe('3.84 GB');
    expect(formatHappierDataBytes(2 * 1024 ** 3, { kind: 'memory', locale: 'en-US' })).toBe('2 GB');
    expect(formatHappierDataBytes(412_400_000_000, { kind: 'storage', locale: 'en-US' })).toBe('412 GB');
    expect(formatHappierDataBytes(1_240_000_000_000, { kind: 'storage', locale: 'de-DE' })).toBe('1,24 TB');
    expect(formatHappierDataBytes(9_960, { kind: 'storage', locale: 'en-US' })).toBe('9.96 KB');
    expect(formatHappierDataBytes(999_600, { kind: 'storage', locale: 'en-US' })).toBe('1 MB');
    expect(formatHappierDataBytes(1023.6 * 1024, { kind: 'memory', locale: 'en-US' })).toBe('1,020 KB');
    expect(formatHappierDataBytesParts(1_236, { kind: 'storage', locale: 'en-US' })).toEqual({ value: '1.24', unit: 'KB' });
    expect(formatHappierDataBytesParts(1_236, { kind: 'storage', locale: 'invalid_locale' })).toEqual({ value: '1.24', unit: 'KB' });
    expect(formatHappierDataBytes(-1, { kind: 'storage', locale: 'en-US' })).toBe('0 B');
    expect(formatHappierDataBytes(Number.POSITIVE_INFINITY, { kind: 'memory', locale: 'en-US' })).toBe('0 B');
    expect(formatHappierDataBytes(0, { kind: 'memory', locale: 'en-US' })).toBe('0 B');
    expect(formatHappierDataBytes(812, { kind: 'storage', locale: 'en-US' })).toBe('812 B');
    expect(formatHappierDataBytesParts(180 * 1024 ** 2, { kind: 'memory', locale: 'en-US' })).toEqual({ value: '180', unit: 'MB' });
  });
});
