import { chmod, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Install a real executable at the managed tool boundary without a download. */
export async function writeManagedJavaScriptRuntimeFixture(homeDir: string): Promise<string> {
  const binDir = join(homeDir, 'tools', 'js-runtime', 'current', 'bin');
  const runtimeDir = join(homeDir, 'tools', 'js-runtime', 'current', 'runtime');
  const wrapperPath = join(binDir, process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime');
  const runtimePath = process.platform === 'win32'
    ? join(runtimeDir, 'node.exe')
    : join(runtimeDir, 'bin', 'node');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(runtimePath, '..'), { recursive: true });
  if (process.platform === 'win32') {
    await copyFile(process.execPath, runtimePath);
    await writeFile(wrapperPath, '@echo off\r\n"%~dp0..\\runtime\\node.exe" %*\r\n', 'utf8');
  } else {
    await symlink(process.execPath, runtimePath);
    await writeFile(wrapperPath, '#!/bin/sh\nexec "${0%/*}/../runtime/bin/node" "$@"\n', 'utf8');
    await chmod(wrapperPath, 0o755);
  }
  return wrapperPath;
}
