import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';

import type { VoiceInferenceRuntimeTranscribeInput } from './voiceInferenceRuntimeTypes';

function createMonoPcm16WavBuffer(sampleCount = 4, sampleRate = 16_000): Buffer {
    const dataSize = sampleCount * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);
    for (let index = 0; index < sampleCount; index += 1) {
        buffer.writeInt16LE(index * 128, 44 + (index * 2));
    }
    return buffer;
}

describe('loadDefaultVoiceInferenceRuntime', () => {
    const envKeys = ['HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE', 'HAPPIER_HOME_DIR'] as const;
    let envScope = createEnvKeyScope(envKeys);
    const tempDirs: string[] = [];
    const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath')!;

    // The executable's physical location is the OS boundary. Asset and installable
    // decisions remain with their real owners, using only files in the test home.
    async function pointExecutableAt(runtimeRoot: string): Promise<void> {
        // The native runtime loader also imports the shipped process supervisor.
        // Preserve that real support owner beneath the temporary install root.
        const processTreeOwner = resolveCliRuntimeAssetPath('scripts', 'process_tree.cjs');
        await mkdir(join(runtimeRoot, 'scripts'), { recursive: true });
        await copyFile(processTreeOwner, join(runtimeRoot, 'scripts', 'process_tree.cjs'));
        Object.defineProperty(process, 'execPath', { ...originalExecPath, value: join(runtimeRoot, 'happier-fixture') });
    }

    async function createTempDir(): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), 'happier-load-default-voice-runtime-'));
        tempDirs.push(dir);
        return dir;
    }

    async function createRuntimeModule(params: Readonly<{
        filePath: string;
        transcribeText: string;
    }>): Promise<void> {
        await mkdir(dirname(params.filePath), { recursive: true });
        await writeFile(
            params.filePath,
            [
                `const transcribeText = ${JSON.stringify(params.transcribeText)};`,
                'export const configurePackagedVoiceInferenceRuntime = ({ sherpaOnnxImportSpecifier }) => { globalThis.__voiceInferenceSherpaSpecifier = sherpaOnnxImportSpecifier; };',
                'export const voiceInferenceRuntimeEngine = {',
                '    warmModel: async () => {},',
                "    synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'unused.wav' }),",
                '    transcribeAudio: async () => ({ text: transcribeText, language: "en" }),',
                '};',
                '',
            ].join('\n'),
            'utf8',
        );
    }

    async function importLoaderModule() {
        vi.resetModules();
        const { reloadConfiguration } = await import('@/configuration');
        reloadConfiguration();
        return await import('./loadDefaultVoiceInferenceRuntime');
    }

    beforeEach(async () => {
        const happyHomeDir = await createTempDir();
        envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE: undefined });
        const { reloadConfiguration } = await import('@/configuration');
        reloadConfiguration();
    });

    async function createInputFixture(rootDir: string): Promise<VoiceInferenceRuntimeTranscribeInput> {
        const filePath = join(rootDir, 'input.wav');
        await writeFile(filePath, createMonoPcm16WavBuffer());
        return {
            requestId: 'stt-1',
            filePath,
            inputMimeType: 'audio/wav',
            packId: 'sherpa-stt-en-v1',
            packDir: rootDir,
            manifest: {
                packId: 'sherpa-stt-en-v1',
                kind: 'stt_sherpa',
                model: 'sherpa',
                version: '2026-04-17',
                files: [],
            },
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'ui_pretranscoded_pcm16_fallback',
                systemFfmpegAllowed: false,
            },
        };
    }

    afterEach(async () => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        Object.defineProperty(process, 'execPath', originalExecPath);
        delete (globalThis as { __voiceInferenceSherpaSpecifier?: string }).__voiceInferenceSherpaSpecifier;
        vi.resetModules();
        const { reloadConfiguration } = await import('@/configuration');
        reloadConfiguration();
        await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    });

    it('prefers the env override module before the packaged runtime asset loader when explicitly configured', async () => {
        const runtimeRoot = await createTempDir();
        const overrideRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'package-dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs');
        const overrideModulePath = join(overrideRoot, 'voiceInferenceOverride.mjs');

        await createRuntimeModule({ filePath: packagedModulePath, transcribeText: 'packaged-runtime' });
        await createRuntimeModule({ filePath: overrideModulePath, transcribeText: 'env-override-runtime' });
        process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = pathToFileURL(overrideModulePath).href;
        await pointExecutableAt(runtimeRoot);

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();
        const input = await createInputFixture(runtimeRoot);

        await expect(runtime?.transcribeAudio(input)).resolves.toMatchObject({
            text: 'env-override-runtime',
            language: 'en',
        });
        expect((globalThis as { __voiceInferenceSherpaSpecifier?: string }).__voiceInferenceSherpaSpecifier).toBeUndefined();
    });

    it('falls back to the env override module when the packaged runtime asset is absent', async () => {
        const runtimeRoot = await createTempDir();
        const overrideRoot = await createTempDir();
        const overrideModulePath = join(overrideRoot, 'voiceInferenceOverride.mjs');

        await createRuntimeModule({ filePath: overrideModulePath, transcribeText: 'env-override-runtime' });
        process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = pathToFileURL(overrideModulePath).href;
        await pointExecutableAt(runtimeRoot);

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();
        const input = await createInputFixture(overrideRoot);

        await expect(runtime?.transcribeAudio(input)).resolves.toMatchObject({
            text: 'env-override-runtime',
            language: 'en',
        });
    });

    it('falls back to the packaged runtime when the configured override module is missing', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'package-dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs');

        await createRuntimeModule({ filePath: packagedModulePath, transcribeText: 'packaged-runtime' });
        process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = pathToFileURL(
            join(runtimeRoot, 'missing', 'voiceInferenceOverride.mjs'),
        ).href;
        await pointExecutableAt(runtimeRoot);

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();
        const input = await createInputFixture(runtimeRoot);

        await expect(runtime?.transcribeAudio(input)).resolves.toMatchObject({
            text: 'packaged-runtime',
            language: 'en',
        });
    });

    it('forwards releaseModel through the default runtime engine wrapper', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'package-dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs');

        await mkdir(dirname(packagedModulePath), { recursive: true });
        await writeFile(
            packagedModulePath,
            [
                'globalThis.__voiceInferenceReleasedPackIds = [];',
                'export const configurePackagedVoiceInferenceRuntime = () => {};',
                'export const voiceInferenceRuntimeEngine = {',
                '    warmModel: async () => {},',
                '    releaseModel: async ({ packId }) => {',
                '        globalThis.__voiceInferenceReleasedPackIds.push(packId);',
                '    },',
                "    synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'unused.wav' }),",
                '    transcribeAudio: async () => ({ text: "packaged-runtime", language: "en" }),',
                '};',
                '',
            ].join('\n'),
            'utf8',
        );
        await pointExecutableAt(runtimeRoot);

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();

        await runtime?.releaseModel?.({
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            packDir: runtimeRoot,
            manifest: {
                packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                kind: 'tts_sherpa',
                model: 'kokoro',
                version: '2026-04-17',
                files: [],
            },
        });

        expect((globalThis as { __voiceInferenceReleasedPackIds?: string[] }).__voiceInferenceReleasedPackIds).toEqual([
            'kokoro-82m-v1.0-onnx-q8-wasm',
        ]);
    });

    it('forwards optional streaming transcription sessions through the default runtime engine wrapper', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'package-dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs');

        await mkdir(dirname(packagedModulePath), { recursive: true });
        await writeFile(
            packagedModulePath,
            [
                'globalThis.__voiceInferenceStreamingSessionInputs = [];',
                'export const configurePackagedVoiceInferenceRuntime = () => {};',
                'export const voiceInferenceRuntimeEngine = {',
                '    warmModel: async () => {},',
                "    synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'unused.wav' }),",
                '    transcribeAudio: async () => ({ text: "packaged-runtime", language: "en" }),',
                '    createStreamingTranscriptionSession: async (input) => {',
                '        globalThis.__voiceInferenceStreamingSessionInputs.push(input);',
                '        return {',
                "            appendPcm16: async ({ seq }) => ({ events: [{ type: 'partial', seq, text: 'hel', isEndpoint: false, confidence: null }] }),",
                "            finish: async ({ finalSeq }) => ({ text: 'hello', language: input.language, events: [{ type: 'final', seq: finalSeq, text: 'hello', language: input.language, modelPackId: input.packId }] }),",
                '            cancel: async () => {},',
                '            close: async () => {},',
                '        };',
                '    },',
                '};',
                '',
            ].join('\n'),
            'utf8',
        );
        await pointExecutableAt(runtimeRoot);

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();
        const session = await runtime?.createStreamingTranscriptionSession?.({
            requestId: 'stt-stream-1',
            packId: 'sherpa-stt-en-v1',
            packDir: runtimeRoot,
            manifest: {
                packId: 'sherpa-stt-en-v1',
                kind: 'stt_sherpa',
                model: 'sherpa',
                version: '2026-04-17',
                files: [],
            },
            language: 'en',
            format: {
                sampleRateHz: 16_000,
                channelCount: 1,
                bitsPerSample: 16,
                ffmpegCodec: 'pcm_s16le',
            },
        });

        await expect(session?.appendPcm16({ seq: 0, pcm16Bytes: new Uint8Array([0, 0]) })).resolves.toEqual({
            events: [{ type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null }],
        });
        await expect(session?.finish({ finalSeq: 0 })).resolves.toEqual({
            text: 'hello',
            language: 'en',
            events: [{ type: 'final', seq: 0, text: 'hello', language: 'en', modelPackId: 'sherpa-stt-en-v1' }],
        });
        expect((globalThis as { __voiceInferenceStreamingSessionInputs?: Array<{ requestId: string }> }).__voiceInferenceStreamingSessionInputs).toEqual([
            expect.objectContaining({ requestId: 'stt-stream-1' }),
        ]);
    });

    it('deletes decoded temp files when daemon decode validation fails after the runtime facade decodes audio', async () => {
        const runtimeRoot = await createTempDir();
        const overrideModulePath = join(runtimeRoot, 'voiceInferenceOverride.mjs');
        const inputFilePath = join(runtimeRoot, 'input.webm');
        await writeFile(inputFilePath, Buffer.from('compressed-audio'));
        const input: VoiceInferenceRuntimeTranscribeInput = {
            requestId: 'stt-leak',
            filePath: inputFilePath,
            inputMimeType: 'audio/webm;codecs=opus',
            packId: 'sherpa-stt-en-v1',
            packDir: runtimeRoot,
            manifest: {
                packId: 'sherpa-stt-en-v1',
                kind: 'stt_sherpa',
                model: 'sherpa',
                version: '2026-04-17',
                files: [],
            },
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        };
        const decodedFilePath = `${input.filePath}.decoded.wav`;

        await writeFile(
            overrideModulePath,
            [
                "import { writeFile } from 'node:fs/promises';",
                'export const voiceInferenceRuntimeEngine = {',
                '    warmModel: async () => {},',
                "    synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'unused.wav' }),",
                '    decodeAudioInput: async ({ filePath }) => {',
                "        const decodedFilePath = `${filePath}.decoded.wav`;",
                "        await writeFile(decodedFilePath, 'not-a-wav', 'utf8');",
                "        return { filePath: decodedFilePath, inputMimeType: 'audio/wav' };",
                '    },',
                "    transcribeAudio: async () => ({ text: 'unreachable', language: 'en' }),",
                '};',
                '',
            ].join('\n'),
            'utf8',
        );
        process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = pathToFileURL(overrideModulePath).href;
        await pointExecutableAt(runtimeRoot);

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();

        await expect(runtime?.transcribeAudio(input)).rejects.toMatchObject({
            code: 'invalid_audio_input',
        });
        await expect(readFile(decodedFilePath)).rejects.toThrow();
    });

    it('reports runtime_unavailable when the packaged runtime asset exists but its native closure is broken', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'package-dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs');

        await mkdir(dirname(packagedModulePath), { recursive: true });
        await writeFile(
            packagedModulePath,
            [
                "const error = Object.assign(new Error('native runtime missing'), { code: 'ERR_DLOPEN_FAILED' });",
                'throw error;',
                '',
            ].join('\n'),
            'utf8',
        );
        await pointExecutableAt(runtimeRoot);

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();

        await expect(loadDefaultVoiceInferenceRuntime()).rejects.toMatchObject({
            code: 'runtime_unavailable',
        });
    });

    it('projects the source native dependency entrypoint into the packaged engine', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'package-dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs');
        await createRuntimeModule({
            filePath: packagedModulePath,
            transcribeText: 'packaged-runtime',
        });
        await pointExecutableAt(runtimeRoot);

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();
        const input = await createInputFixture(runtimeRoot);

        await expect(runtime?.transcribeAudio(input)).resolves.toMatchObject({ text: 'packaged-runtime' });
        expect((globalThis as { __voiceInferenceSherpaSpecifier?: string }).__voiceInferenceSherpaSpecifier).toBe(
            pathToFileURL(createRequire(import.meta.url).resolve('sherpa-onnx-node/sherpa-onnx.js')).href,
        );
    });

});
