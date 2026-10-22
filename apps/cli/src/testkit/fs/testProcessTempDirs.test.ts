import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { withTempDirSync } from '@/testkit/fs/tempDir'
import {
  resolveTestProcessTempDir,
  sweepOrphanedTestProcessTempDirs,
} from '@/testkit/fs/testProcessTempDirs'

function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  if (typeof child.pid !== 'number') throw new Error('failed to spawn probe process')
  return child.pid
}

describe('test process temp dirs', () => {
  it('removes per-process dirs whose owner process exited and keeps live or unrelated ones', () => {
    withTempDirSync('happier-cli-test-process-dirs-', (baseDir) => {
      const deadPid = exitedPid()
      const liveHome = resolveTestProcessTempDir('home', process.pid, baseDir)
      const liveBin = resolveTestProcessTempDir('bin', process.pid, baseDir)
      const deadHome = resolveTestProcessTempDir('home', deadPid, baseDir)
      const deadBin = resolveTestProcessTempDir('bin', deadPid, baseDir)
      const unrelated = join(baseDir, 'happier-cli-vitest-build-lock-123456')
      for (const dir of [liveHome, liveBin, deadHome, deadBin, unrelated]) {
        mkdirSync(join(dir, 'nested'), { recursive: true })
      }

      sweepOrphanedTestProcessTempDirs(baseDir)

      expect(existsSync(deadHome)).toBe(false)
      expect(existsSync(deadBin)).toBe(false)
      expect(readdirSync(baseDir).sort()).toEqual(
        [liveBin, liveHome, unrelated].map((dir) => dir.slice(baseDir.length + 1)).sort(),
      )
    })
  })
})
