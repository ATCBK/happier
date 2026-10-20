import { definePlugin } from '@happier-dev/plugin-sdk';

// The platform archives retain the adjacent standard-library declarations.
// Digests and layout were measured against the 7.0.2 npm platform archives.
export const LANG_TYPESCRIPT_PLUGIN = definePlugin({
  id: 'happier.language.typescript', version: '0.0.0', displayName: 'TypeScript',
  description: 'TypeScript and JavaScript language intelligence on the workspace Machine.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  languageServers: {
    typescript: {
      title: 'TypeScript',
      languageIds: { typescript: 'typescript', tsx: 'typescriptreact', javascript: 'javascript', jsx: 'javascriptreact' },
      executable: { kind: 'managedDependency', id: 'typescript-native' }, args: ['--lsp', '--stdio'],
      initializationOptions: {
        userPreferences: { tsserver: { automaticTypeAcquisition: { enabled: false } } },
        disablePushDiagnostics: true,
      },
    },
  },
  managedDependencies: {
    'typescript-native': {
      title: 'TypeScript language server', executable: 'tsc',
      platforms: ['linux', 'macos', 'windows'], architectures: ['x64', 'arm64'],
      sources: [{ kind: 'pinnedArchive', installId: 'dep.typescript-native', version: '7.0.2', assetsByPlatform: {
        'linux-x64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-linux-x64/-/typescript-linux-x64-7.0.2.tgz',
          sha256: '7ecad6f67377e831856367ab062ef394f21506a611405bf8ac0ff039348637d3',
          sizeBytes: 9669334, executableSubpath: 'package/lib/tsc',
        },
        'linux-arm64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-linux-arm64/-/typescript-linux-arm64-7.0.2.tgz',
          sha256: 'c83d931ac9dd7549cde6e71246aa9d6a9812843023df3e277fe3b5dcf41dd0ea',
          sizeBytes: 8900516, executableSubpath: 'package/lib/tsc',
        },
        'darwin-x64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-darwin-x64/-/typescript-darwin-x64-7.0.2.tgz',
          sha256: 'eba158cb54050f723d5ff781438f33de5640054440bb4f2bd170cfe9bc2eb551',
          sizeBytes: 10057523, executableSubpath: 'package/lib/tsc',
        },
        'darwin-arm64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-darwin-arm64/-/typescript-darwin-arm64-7.0.2.tgz',
          sha256: '902e2fe1cf0799198ef902c6b8c310a450fef629a6baba41d45641ef75c04ebd',
          sizeBytes: 9270373, executableSubpath: 'package/lib/tsc',
        },
        'win32-x64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-win32-x64/-/typescript-win32-x64-7.0.2.tgz',
          sha256: '61fc4e141d2bc687db580e71bbfa63b9c209f0310645d82ca1b457eb3a24fd19',
          sizeBytes: 9776626, executableSubpath: 'package/lib/tsc.exe',
        },
        'win32-arm64': {
          archiveUrl: 'https://registry.npmjs.org/@typescript/typescript-win32-arm64/-/typescript-win32-arm64-7.0.2.tgz',
          sha256: '0a73534e6ee50cdbb2a29ac48657ca0ad13cf0f424cf63808e4df7baeb87b8be',
          sizeBytes: 8900840, executableSubpath: 'package/lib/tsc.exe',
        },
      } }],
    },
  },
});

export const { manifest: PLUGIN_MANIFEST, activate } = LANG_TYPESCRIPT_PLUGIN;
