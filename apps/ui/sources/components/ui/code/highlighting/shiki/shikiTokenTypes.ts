/** Grammar segments retain their UTF-16 column even when color tokens merge. */
export type ShikiScopeToken = Readonly<{
    text: string;
    column: number;
    scopes: readonly string[];
}>;
