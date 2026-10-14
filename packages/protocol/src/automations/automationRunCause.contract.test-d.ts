import type { $brand } from 'zod/mini';

import type {
  AutomationRunCause,
  AutomationRunCauseDeclarationV1,
} from './automationRunCause.js';

type Assert<Condition extends true> = Condition;
type IsExactly<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left] ? true : false
  : false;

/**
 * Mechanical brand-free projection of one canonical cause value. It exists only
 * to hold the published declaration in lockstep with the parsed union: an added,
 * removed, or retyped field makes the assertion below stop being `true`.
 */
type BrandFreeProjection<TValue> =
  TValue extends string & $brand ? string
    : TValue extends number & $brand ? number
      : TValue extends object
        ? { readonly [TKey in keyof TValue]: BrandFreeProjection<TValue[TKey]> }
        : TValue;

// The published author declaration is exactly the canonical union without
// Protocol's identity brands. It is spelled out rather than derived because a
// public SDK signature must close over author-visible names only, so this is
// the guard that keeps the two spellings from drifting.
type _AutomationRunCauseDeclarationMatchesCanonicalUnion = Assert<
  IsExactly<AutomationRunCauseDeclarationV1, BrandFreeProjection<AutomationRunCause>>
>;

// The parsed, branded value stays assignable to the published declaration, so a
// host may hand a parsed cause straight to a plugin author's typed surface.
type _ParsedCauseSatisfiesPublishedDeclaration = Assert<
  AutomationRunCause extends AutomationRunCauseDeclarationV1 ? true : false
>;
