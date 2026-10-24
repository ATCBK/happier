import { getStorage } from '@/sync/domains/state/storageStore';
import { fileEditorAiSuggestionUsageState } from '@/sync/domains/state/filePaneUiState';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { appendFileEditorAiSuggestionUsage, selectFileEditorAiSuggestionUsage, type FileEditorAiSuggestionUsageEvent } from '@/sync/domains/workspaces/languageIntelligence/fileEditorAiSuggestionUsage';

export function recordFileEditorAiSuggestionUsage(scope: ServerAccountScope, event: FileEditorAiSuggestionUsageEvent): void {
    const state = getStorage().getState();
    if (!areServerAccountScopesEqual(scope, state.settingsScope)) return;
    const key = serverAccountScopeKeySuffix(scope);
    const previous = fileEditorAiSuggestionUsageState.read(key);
    fileEditorAiSuggestionUsageState.set(key, appendFileEditorAiSuggestionUsage(previous ? { [key]: previous } : {}, key, event)[key]);
}

export function readFileEditorAiSuggestionUsage(scope: ServerAccountScope) {
    const key = serverAccountScopeKeySuffix(scope);
    const value = fileEditorAiSuggestionUsageState.read(key);
    return selectFileEditorAiSuggestionUsage(value ? { [key]: value } : {}, key);
}
