import type { ToolCall } from "@happier-dev/session-core/messages";
import { describe, expect, it, vi } from 'vitest';

import { resolveToolStatusIndicatorKind } from './resolveToolStatusIndicatorKind';

function createCompletedTool(result: unknown): ToolCall {
    return {
        name: 'Bash',
        state: 'completed',
        input: {},
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
        result,
    };
}

describe('resolveToolStatusIndicatorKind', () => {
    it('parses an unchanged structured result once and recomputes after the result root changes', () => {
        const tool = createCompletedTool({
            content: [{
                type: 'text',
                text: '{"v":1,"ok":true,"kind":"tools_call","data":{"results":[{"ok":true}]}}',
            }],
        });
        const parseSpy = vi.spyOn(JSON, 'parse');

        expect(resolveToolStatusIndicatorKind(tool)).toBe('completed');
        expect(resolveToolStatusIndicatorKind(tool)).toBe('completed');
        expect(parseSpy).toHaveBeenCalledTimes(1);

        tool.result = {
            content: [{
                type: 'text',
                text: '{"v":1,"ok":false,"kind":"tools_call","error":{"message":"failed"}}',
            }],
        };

        expect(resolveToolStatusIndicatorKind(tool)).toBe('error');
        expect(parseSpy).toHaveBeenCalledTimes(2);

        parseSpy.mockRestore();
    });

    it('reads a completed call whose matched Action approval was declined as blocked, never as completed', () => {
        const tool = createCompletedTool({ content: [{ type: 'text', text: '' }] });
        expect(resolveToolStatusIndicatorKind(tool)).toBe('completed');
        expect(resolveToolStatusIndicatorKind(tool, 'rejected')).toBe('permission_blocked');
        expect(resolveToolStatusIndicatorKind(tool, 'canceled')).toBe('permission_blocked');
    });

    it('keeps a real execution failure an error even when its approval was declined', () => {
        const failed = createCompletedTool({ tool_use_result: 'Error: spawn failed' });
        expect(resolveToolStatusIndicatorKind(failed, 'rejected')).toBe('error');
        expect(resolveToolStatusIndicatorKind({ ...failed, state: 'error' }, 'canceled')).toBe('error');
    });
});
