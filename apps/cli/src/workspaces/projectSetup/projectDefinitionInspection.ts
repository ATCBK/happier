import type { ProjectDefinitionDetectionV1, ProjectManifestV1, ProjectToolInspectionV1, ProjectToolRequirementV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { inspectProjectImportCandidates, readProjectExecutionInputs, resolveProjectEnvironmentSelection } from './projectNativeResolution';
import type { ProjectImportCandidate, ProjectNativeCommandIo } from './projectNativeResolution';

import { inspectProjectDefinitionFiles } from './nativeDefinitionInspection';
export { inspectProjectDefinitions, inspectProjectDefinitionFiles, inspectProjectDefinitionFacts } from './nativeDefinitionInspection';

export { readProjectDefinitionFile } from './nativeDefinitionFiles';
export { inspectProjectImportCandidates, resolveProjectNativeCommand, resolveProjectEnvironmentSelection, resolveProjectDevcontainerSelection } from './projectNativeResolution';

/** Host-installed facts only, not selected-toolchain satisfaction or a prerequisite health check. */
export async function inspectProjectToolFacts(input: Readonly<{
    root: string; detection: ProjectDefinitionDetectionV1; candidates: readonly ProjectImportCandidate[];
    io: ProjectNativeCommandIo; signal?: AbortSignal;
}>): Promise<ProjectToolInspectionV1[]> {
    const requirements: ProjectToolRequirementV1[] = [...(input.detection.tools ?? [])];
    for (const selection of input.detection.environments) if (selection.kind === 'toolchain' && selection.configPath) {
        requirements.push({ tool: selection.tool === 'nix_flake' ? 'nix' : selection.tool, file: selection.configPath });
    }
    for (const candidate of input.candidates) if (candidate.invocation) requirements.push({ tool: candidate.invocation.tool,
        file: candidate.source.file, ...(candidate.invocation.requestedVersion ? { requestedVersion: candidate.invocation.requestedVersion } : {}) });
    const facts: ProjectToolInspectionV1[] = [];
    const seen = new Set<string>();
    // Every requirement asks the same unversioned installed-tool question at
    // this root. Resolve the distinct tools once, retaining all file/version
    // requirements. Observations belong only to this inspection, never the next.
    const observations = new Map<string, Pick<ProjectToolInspectionV1, 'availability' | 'version'>>();
    for (const requirement of requirements) {
        const key = JSON.stringify(requirement);
        if (seen.has(key)) continue;
        seen.add(key);
        input.signal?.throwIfAborted();
        let observation = observations.get(requirement.tool);
        if (!observation) {
            try {
                const installed = await input.io.resolveTool(requirement.tool, { cwd: input.root, ...(input.signal ? { signal: input.signal } : {}) });
                input.signal?.throwIfAborted();
                observation = { availability: installed ? 'available' : 'unavailable', ...(installed?.version ? { version: installed.version } : {}) };
            } catch {
                input.signal?.throwIfAborted();
                observation = { availability: 'unresolved' };
            }
            observations.set(requirement.tool, observation);
        }
        facts.push({ ...requirement, ...observation });
    }
    return facts;
}

/** One passive projection for named commands, import offers and installed tools; transport does not reconstruct native semantics. */
export async function inspectProjectDefinitionExecutionFacts(input: Readonly<{
    root: string; manifest?: ProjectManifestV1; detection: ProjectDefinitionDetectionV1; io: ProjectNativeCommandIo; signal?: AbortSignal;
}>) {
    const { root, manifest, detection, io, signal } = input;
    const named: (ProjectDefinitionDetectionV1['entries'][number] & { name: string })[] = [];
    if (manifest) {
        for (const usage of ['script', 'service'] as const) for (const [name, entry] of Object.entries(usage === 'script' ? manifest.scripts ?? {} : manifest.services ?? {})) {
            if (entry.source.kind !== 'command') named.push({ name, source: entry.source, usage });
        }
        for (const phase of ['setup', 'teardown'] as const) manifest.workspace?.[phase]?.forEach((source, index) => {
            if (source.kind !== 'command') named.push({ name: `${phase}.${index}`, source, usage: 'setup' });
        });
        const selection = manifest.environment;
        if (selection?.kind === 'toolchain' && selection.configPath && !detection.environments.some(candidate => candidate.kind === 'toolchain' && candidate.tool === selection.tool && candidate.configPath === selection.configPath)) {
            const selected = await inspectProjectDefinitionFiles(root, [{ file: selection.configPath, format: selection.tool }]);
            detection.environments.push(...selected.environments);
            if (selected.tools) (detection.tools ??= []).push(...selected.tools);
            detection.diagnostics.push(...selected.diagnostics);
            if (selected.coverage === 'partial') detection.coverage = 'partial';
        }
    }
    const importCandidates = await inspectProjectImportCandidates({ root, detection, io, ...(signal ? { signal } : {}) });
    const commands: (Omit<ProjectImportCandidate, 'preselected'> & { name: string })[] = [];
    for (const entry of named) {
        const [candidate] = await inspectProjectImportCandidates({ root, detection: { ...detection, entries: [entry] }, io, ...(signal ? { signal } : {}) });
        if (candidate) { const { preselected: _preselected, ...preview } = candidate; commands.push({ ...preview, name: entry.name }); }
    }
    const tools = await inspectProjectToolFacts({ root, detection, candidates: [...importCandidates, ...commands.map(command => ({ ...command, preselected: false }))], io, ...(signal ? { signal } : {}) });
    const environment = await resolveProjectEnvironmentSelection({ root, selection: manifest?.environment ?? { kind: 'host' } });
    let environmentExecutionInputs: Awaited<ReturnType<typeof readProjectExecutionInputs>>;
    if (environment.kind === 'selected') {
        try {
            const installed = environment.selection.kind === 'toolchain'
                ? await io.resolveTool(environment.selection.tool === 'nix_flake' ? 'nix' : environment.selection.tool,
                    { cwd: root, ...(signal ? { signal } : {}) }) : null;
            signal?.throwIfAborted();
            environmentExecutionInputs = await readProjectExecutionInputs(root, environment.file ? [environment.file] : [], installed?.executablePath);
        } catch { signal?.throwIfAborted(); }
    }
    signal?.throwIfAborted();
    return { importCandidates, commands, tools, ...(environmentExecutionInputs ? { environmentExecutionInputs } : {}) };
}
