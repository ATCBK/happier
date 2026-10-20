import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import type { CodeIntelligenceController } from './createCodeIntelligenceController';

export function bindCodeIntelligenceEditor(controller: CodeIntelligenceController, editor: Pick<CodeEditorHandle, 'onPointerPosition' | 'onActivatePosition'>): () => void {
    const stopPointer = editor.onPointerPosition?.(position => controller.inspect(position ? { line: position.line - 1, character: position.character, anchor: position.rect } : null));
    const stopActivation = editor.onActivatePosition?.(position => { void controller.definition({ line: position.line - 1, character: position.character }); });
    return () => { stopPointer?.(); stopActivation?.(); };
}
