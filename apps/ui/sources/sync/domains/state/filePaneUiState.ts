import { z } from 'zod/mini';
import { createPersistentUiState } from './persistentUiState';
import { PersistedPaneScopeSchema } from '@/components/appShell/panes/model/paneScopePersistenceSchema';
import { parseRecentWorkspaceFiles } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';
import { FileEditorAiSuggestionDailyUsageSchema, EMPTY_FILE_EDITOR_AI_SUGGESTION_USAGE } from '@/sync/domains/workspaces/languageIntelligence/fileEditorAiSuggestionUsage';

export const paneUiState = createPersistentUiState('pane-scopes-v1', value => PersistedPaneScopeSchema.parse(value));
// Keep the retained bytes until the workspace owner's reader admits them. A
// removed destination can still restore as its tombstone rather than disappear.
export const workspaceLayoutsState = createPersistentUiState<unknown>('workspace-layouts-v1', value => value);
export const recentWorkspaceFilesState = createPersistentUiState('recent-workspace-files-v1', value => parseRecentWorkspaceFiles({ paths: value }).paths ?? []);
export const fileEditorAiSuggestionUsageState = createPersistentUiState('editor-ai-usage-v1', value => z.catch(FileEditorAiSuggestionDailyUsageSchema, EMPTY_FILE_EDITOR_AI_SUGGESTION_USAGE).parse(value));
