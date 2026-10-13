import { expect, it } from 'vitest';
import { decodeBase64 } from '../../../crypto/base64.js';
import { exportSkillBundlesAsZipV1, readSkillZipFilesV1 } from './skillZipV1.js';

it('exports Agent Skills folders with exact bytes and executable mode readable by the real ZIP consumer', async () => {
  const archive = await exportSkillBundlesAsZipV1([{ name: 'sample', files: [
    { path: 'SKILL.md', contentBase64: 'eA==', contentKind: 'utf8' },
    { path: 'scripts/run', contentBase64: 'eQ==', contentKind: 'utf8', unixMode: 0o755 },
  ] }]);
  expect(archive.fileName).toBe('sample.zip');
  expect(await readSkillZipFilesV1(decodeBase64(archive.bytes))).toEqual([
    { path: 'sample/SKILL.md', contentBase64: 'eA==', contentKind: 'utf8', unixMode: 0o644 },
    { path: 'sample/scripts/run', contentBase64: 'eQ==', contentKind: 'utf8', unixMode: 0o755 },
  ]);
});
