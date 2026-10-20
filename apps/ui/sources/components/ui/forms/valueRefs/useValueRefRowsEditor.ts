import * as React from 'react';
import { ValueRefV1Schema, type ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

export type ValueRefRowsKind = 'env' | 'header';
export type ValueRefRowsSource = ValueRefV1['t'] | 'machine';
export type ValueRefRowsResult = Readonly<{ ok: true }> | Readonly<{
    ok: false;
    error: 'invalid_key' | 'invalid_value' | 'duplicate_key' | 'missing_entry' | 'no_draft';
}>;

export type ValueRefRowDraft = Readonly<{
    originalKey: string | null;
    key: string;
    source: ValueRefRowsSource;
    literalValue: string;
    secretId: string;
    machineVariable: string;
    valueRef: ValueRefV1;
}>;

export type ValueRefRow = Readonly<{ key: string; valueRef: ValueRefV1 }>;

const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_KEY_REGEX = /^[A-Za-z0-9-]+$/;
const MACHINE_VALUE_REGEX = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

function normalizeKey(kind: ValueRefRowsKind, key: string): string {
    return kind === 'env' ? key.trim().toUpperCase() : key.trim();
}

function validateKey(kind: ValueRefRowsKind, key: string): boolean {
    return (kind === 'env' ? ENV_KEY_REGEX : HEADER_KEY_REGEX).test(key);
}

function createDraft(originalKey: string | null, key: string, valueRef: ValueRefV1): ValueRefRowDraft {
    const machineVariable = valueRef.t === 'literal' ? MACHINE_VALUE_REGEX.exec(valueRef.v)?.[1] ?? '' : '';
    return {
        originalKey, key, valueRef,
        source: machineVariable ? 'machine' : valueRef.t,
        literalValue: valueRef.t === 'literal' ? valueRef.v : '',
        secretId: valueRef.t === 'savedSecret' ? valueRef.secretId : '',
        machineVariable,
    };
}

function draftValueRef(draft: ValueRefRowDraft): ValueRefV1 {
    if (draft.source === 'literal') {
        return draft.valueRef.t === 'literal' && draft.valueRef.v === draft.literalValue
            ? draft.valueRef : { t: 'literal', v: draft.literalValue };
    }
    if (draft.source === 'savedSecret') {
        return draft.valueRef.t === 'savedSecret' && draft.valueRef.secretId === draft.secretId
            ? draft.valueRef : { t: 'savedSecret', secretId: draft.secretId };
    }
    if (draft.source === 'machine') {
        const value = '${' + draft.machineVariable + '}';
        return draft.valueRef.t === 'literal' && draft.valueRef.v === value
            ? draft.valueRef : { t: 'literal', v: value };
    }
    return draft.valueRef;
}

function draftValueValid(draft: ValueRefRowDraft): boolean {
    return (draft.source !== 'machine' || ENV_KEY_REGEX.test(draft.machineVariable))
        && ValueRefV1Schema.safeParse(draftValueRef(draft)).success;
}

/** Shared draft state for the current modal and the inline row composition. */
export function useValueRefEditorDraft(options: Readonly<{
    kind: ValueRefRowsKind;
    initial?: Readonly<{ key: string; valueRef: ValueRefV1 }>;
}>) {
    const [draft, setDraft] = React.useState<ValueRefRowDraft | null>(() => options.initial
        ? createDraft(options.initial.key, options.initial.key, options.initial.valueRef) : null);
    const beginDraft = React.useCallback((originalKey: string | null, key: string, valueRef: ValueRefV1) => {
        setDraft(createDraft(originalKey, key, valueRef));
    }, []);
    const setDraftKey = React.useCallback((key: string) => {
        setDraft((current) => current && current.key !== key ? { ...current, key } : current);
    }, []);
    const setDraftSource = React.useCallback((source: Exclude<ValueRefRowsSource, 'sessionAttested'>) => {
        setDraft((current) => {
            if (!current || current.source === source) return current;
            if (source === 'template') {
                return { ...current, source, valueRef: current.valueRef.t === 'template'
                    ? current.valueRef : { t: 'template', template: '', vars: {} } };
            }
            const machineVariable = source === 'machine' && !current.machineVariable
                ? normalizeKey('env', current.key) : current.machineVariable;
            return { ...current, source, machineVariable };
        });
    }, []);
    const setDraftLiteralValue = React.useCallback((literalValue: string) => {
        setDraft((current) => current && current.literalValue !== literalValue ? { ...current, literalValue } : current);
    }, []);
    const setDraftSecretId = React.useCallback((selection: string | null) => {
        const secretId = selection ?? '';
        setDraft((current) => current && current.secretId !== secretId ? { ...current, secretId } : current);
    }, []);
    const setDraftMachineVariable = React.useCallback((machineVariable: string) => {
        setDraft((current) => current && current.machineVariable !== machineVariable ? { ...current, machineVariable } : current);
    }, []);
    const setDraftValueRef = React.useCallback((valueRef: ValueRefV1) => {
        setDraft((current) => current && current.valueRef !== valueRef
            ? createDraft(current.originalKey, current.key, valueRef) : current);
    }, []);
    const cancelDraft = React.useCallback(() => { setDraft(null); }, []);
    const normalizedKey = draft ? normalizeKey(options.kind, draft.key) : '';
    const keyValid = validateKey(options.kind, normalizedKey);
    return {
        draft, normalizedKey, keyValid,
        canSubmit: Boolean(draft && keyValid && draftValueValid(draft)),
        valueRef: draft ? draftValueRef(draft) : null,
        beginDraft, cancelDraft, setDraftKey, setDraftSource,
        setDraftLiteralValue, setDraftSecretId, setDraftMachineVariable, setDraftValueRef,
    };
}

/** Controlled value-map edits; persistence and presentation remain caller-owned. */
export function useValueRefRowsEditor(options: Readonly<{
    kind: ValueRefRowsKind;
    entries: Readonly<Record<string, ValueRefV1>>;
    onChangeEntries: (next: Record<string, ValueRefV1>) => void;
}>) {
    // Modal callbacks may outlive the render which opened them; read current controlled inputs.
    const optionsRef = React.useRef(options);
    optionsRef.current = options;
    const editor = useValueRefEditorDraft({ kind: options.kind });
    const previousRows = React.useRef<readonly ValueRefRow[]>([]);
    const rows = React.useMemo(() => {
        const previousByKey = new Map(previousRows.current.map((row) => [row.key, row]));
        const next = Object.entries(options.entries)
            .map(([key, valueRef]) => {
                const previous = previousByKey.get(key);
                return previous?.valueRef === valueRef ? previous : { key, valueRef };
            })
            .sort((a, b) => a.key.localeCompare(b.key));
        if (next.length === previousRows.current.length && next.every((row, index) => row === previousRows.current[index])) {
            return previousRows.current;
        }
        previousRows.current = next;
        return next;
    }, [options.entries]);

    const submitEntry = React.useCallback((originalKey: string | null, rawKey: string, valueRef: ValueRefV1): ValueRefRowsResult => {
        const current = optionsRef.current;
        const key = normalizeKey(current.kind, rawKey);
        if (!validateKey(current.kind, key)) return { ok: false, error: 'invalid_key' };
        if (!ValueRefV1Schema.safeParse(valueRef).success) return { ok: false, error: 'invalid_value' };
        if (originalKey !== null && !Object.prototype.hasOwnProperty.call(current.entries, originalKey)) return { ok: false, error: 'missing_entry' };
        if (key !== originalKey && Object.prototype.hasOwnProperty.call(current.entries, key)) return { ok: false, error: 'duplicate_key' };
        if (key === originalKey && current.entries[key] === valueRef) return { ok: true };
        const next = { ...current.entries };
        if (originalKey !== null) delete next[originalKey];
        next[key] = valueRef;
        current.onChangeEntries(next);
        return { ok: true };
    }, []);
    const removeEntry = React.useCallback((key: string): ValueRefRowsResult => {
        const current = optionsRef.current;
        if (!Object.prototype.hasOwnProperty.call(current.entries, key)) return { ok: false, error: 'missing_entry' };
        const next = { ...current.entries };
        delete next[key];
        current.onChangeEntries(next);
        return { ok: true };
    }, []);
    const beginAdd = React.useCallback(() => { editor.beginDraft(null, '', { t: 'literal', v: '' }); }, [editor.beginDraft]);
    const beginEdit = React.useCallback((key: string): ValueRefRowsResult => {
        const current = optionsRef.current;
        if (!Object.prototype.hasOwnProperty.call(current.entries, key)) return { ok: false, error: 'missing_entry' };
        editor.beginDraft(key, key, current.entries[key]);
        return { ok: true };
    }, [editor.beginDraft]);
    const submitDraft = (): ValueRefRowsResult => {
        if (!editor.draft || !editor.valueRef) return { ok: false, error: 'no_draft' };
        if (!editor.keyValid) return { ok: false, error: 'invalid_key' };
        if (!editor.canSubmit) return { ok: false, error: 'invalid_value' };
        const result = submitEntry(editor.draft.originalKey, editor.draft.key, editor.valueRef);
        if (result.ok) editor.cancelDraft();
        return result;
    };
    return { ...editor, rows, beginAdd, beginEdit, submitDraft, submitEntry, removeEntry };
}
