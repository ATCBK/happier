import { _default, core, globalRegistry, lazy, toJSONSchema, ZodType } from 'zod';

const SCHEMA_METHODS = new Set([
  'check', 'with', 'clone', 'refine', 'superRefine', 'overwrite', 'optional',
  'exactOptional', 'nullable', 'nullish', 'nonoptional', 'array', 'or', 'and',
  'transform', 'default', 'prefault', 'catch', 'pipe', 'readonly', 'describe',
  'extend', 'safeExtend', 'merge', 'pick', 'omit', 'partial', 'required',
  'strict', 'strip', 'passthrough', 'loose', 'catchall',
  'trim', 'min', 'max', 'regex', 'keyof',
]);
const PARSE_METHODS = new Set([
  'parse', 'safeParse', 'parseAsync', 'safeParseAsync', 'spa', 'encode', 'decode',
  'encodeAsync', 'decodeAsync', 'safeEncode', 'safeDecode', 'safeEncodeAsync', 'safeDecodeAsync',
]);
type DefinitionLifetime = {
  readonly resolve: () => object;
  readonly canonicalZodIdentity: boolean;
  readonly deferZodMethods: boolean;
  readonly nativeZodSchema: boolean;
  parserSchema?: core.$ZodType;
};
const definitionLifetimes = new WeakMap<object, DefinitionLifetime>();
const resolvedDefinitionSources = new WeakMap<object, object>();

/** @internal Fluent composition may retain the concrete identity of this same definition. */
export function getResolvedLazyDefinitionSource<TDefinition extends object>(definition: TDefinition): TDefinition | undefined {
  return resolvedDefinitionSources.get(definition) as TDefinition | undefined;
}

/** Internal native-parser handle; framework reflection must not admit a definition. */
export function deferZodSchemaForParser(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return schema;
  const lifetime = definitionLifetimes.get(schema);
  if (!lifetime?.nativeZodSchema) return schema;
  // One handle belongs to the existing definition lifetime, not each route,
  // registration or request. Native and non-schema values pass through intact.
  return lifetime.parserSchema ??= lazy(() => schema as core.$ZodType);
}

/** Keeps the concrete Zod contract while admitting construction on demand. */
export function lazyZodSchema<TSchema extends ZodType>(create: () => TSchema): TSchema {
  return createLazyDefinition(create, true);
}

/** A catalog's derived artifact is admitted by the same definition lifetime. */
export function lazyDefinition<TDefinition extends object>(create: () => TDefinition): TDefinition;
export function lazyDefinition<TSchema extends core.$ZodType>(
  create: () => TSchema,
  schemaSource: core.$ZodType,
  preserveSourceClass?: boolean,
): TSchema;
export function lazyDefinition<TDefinition extends object>(
  create: () => TDefinition,
  schemaSource?: core.$ZodType,
  preserveSourceClass = true,
): TDefinition {
  // Derived Classic readers keep their fluent composition cold without
  // assuming that genuine Mini/Core definitions expose Classic methods.
  const sourceLifetime = schemaSource === undefined ? undefined : definitionLifetimes.get(schemaSource);
  const deferZodMethods = schemaSource !== undefined && preserveSourceClass
    && (sourceLifetime ? sourceLifetime.deferZodMethods : schemaSource instanceof ZodType);
  return createLazyDefinition(create, false, deferZodMethods, schemaSource !== undefined);
}

function createLazyDefinition<TSchema extends object>(
  create: () => TSchema,
  canonicalZodIdentity: boolean,
  deferZodMethods = canonicalZodIdentity,
  nativeZodSchema = canonicalZodIdentity,
): TSchema {
  const target = {} as TSchema;
  let schema: TSchema | undefined;
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const resolve = (): TSchema => {
    if (!schema) {
      const created = create();
      // A deferred composition may return another facade from this owner.
      // Flatten it before copying internals: otherwise native parent identity
      // can refer to an intermediate facade instead of the actual schema.
      const createdLifetime = definitionLifetimes.get(created);
      const concrete = (canonicalZodIdentity && createdLifetime?.canonicalZodIdentity
        ? createdLifetime.resolve() : created) as TSchema;
      Object.setPrototypeOf(target, Object.getPrototypeOf(concrete));
      const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(concrete);
      const concreteSchema = concrete instanceof core.$ZodType ? concrete : undefined;
      if (concreteSchema && canonicalZodIdentity && !resolvedDefinitionSources.has(concreteSchema)) {
        resolvedDefinitionSources.set(concreteSchema, definition);
      }
      if (concreteSchema) {
        // Projection processors close over the concrete instance. Construction
        // deferral is not a new schema wrapper: share its traversal identity so
        // recursive definitions and refinements do not gain extra references.
        // Inherit all other internals, including lazy getters and the parser.
        const processJSONSchema: NonNullable<core.$ZodType['_zod']['processJSONSchema']> = (context, json, params) => {
          if (!canonicalZodIdentity) {
            context.seen.delete(definition as unknown as core.$ZodType);
            core.process(concreteSchema, context, {
              ...params,
              schemaPath: params.schemaPath.map(item => item === definition ? concreteSchema : item),
            });
            context.seen.set(definition as unknown as core.$ZodType, context.seen.get(concreteSchema)!);
            return;
          }
          // Native callbacks refer to their concrete constructor instance.
          // Give that callback the facade's existing record, rather than
          // traversing a second wrapper or processing its parent twice.
          const facade = definition as unknown as core.$ZodType;
          const seen = context.seen.get(facade)!;
          const existing = context.seen.get(concreteSchema);
          if (existing) {
            core.process(concreteSchema, context, params);
            context.seen.set(facade, existing);
            return;
          }
          context.seen.set(concreteSchema, seen);
          const processor = concreteSchema._zod.processJSONSchema;
          const callbackParams = { ...params, schemaPath: [...params.schemaPath, concreteSchema] };
          if (processor) processor(context, json, callbackParams);
          else {
            const fallback = context.processors[concreteSchema._zod.def.type];
            if (!fallback) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${concreteSchema._zod.def.type}`);
            fallback(concreteSchema, context, json, callbackParams);
          }
        };
        descriptors._zod = {
          ...descriptors._zod,
          value: Object.create(concreteSchema._zod, {
            processJSONSchema: { value: processJSONSchema },
          }),
        };
      }
      if (canonicalZodIdentity && concrete instanceof ZodType) {
        // Keep the concrete root's projection identity while using Zod's
        // native processors for genuine Core/Mini child definitions.
        descriptors.toJSONSchema = {
          ...descriptors.toJSONSchema,
          value: (params?: core.ToJSONSchemaParams) => toJSONSchema(concrete, params),
        };
      }
      Object.defineProperties(target, descriptors);
      schema = concrete;
      if (concreteSchema && canonicalZodIdentity) {
        // Zod stores annotations by instance identity, outside the definition.
        // The public facade must carry those annotations as well as its fields.
        const metadata = globalRegistry.get(concreteSchema);
        if (metadata) globalRegistry.add(definition as unknown as core.$ZodType, metadata);
      }
    }
    return schema;
  };
  const invoke = (key: PropertyKey, args: unknown[]): unknown => {
    if (deferZodMethods && key === 'default') {
      // Native defaults can admit absent input without inspecting their base.
      // Compose around the facade so that short circuit stays construction-cold.
      return _default(definition as unknown as ZodType, args[0] as Parameters<typeof _default>[1]);
    }
    const concrete = resolve();
    const method: unknown = Reflect.get(concrete, key);
    if (typeof method !== 'function') throw new TypeError(`Invalid Zod method: ${String(key)}`);
    return Reflect.apply(method, concrete, args);
  };
  const definition = new Proxy(target, {
    get(_target, key) {
      if (schema) return Reflect.get(target, key);
      if (deferZodMethods && typeof key === 'string' && (SCHEMA_METHODS.has(key) || PARSE_METHODS.has(key))) {
        let method = methods.get(key);
        if (!method) {
          method = SCHEMA_METHODS.has(key)
            ? (...args) => lazyZodSchema(() => invoke(key, args) as ZodType)
            : (...args) => invoke(key, args);
          methods.set(key, method);
        }
        return method;
      }
      resolve();
      return Reflect.get(target, key);
    },
    getPrototypeOf() { resolve(); return Reflect.getPrototypeOf(target); },
    ownKeys() { resolve(); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(_target, key) { resolve(); return Reflect.getOwnPropertyDescriptor(target, key); },
    has(_target, key) { resolve(); return Reflect.has(target, key); },
    set(_target, key, value) { resolve(); return Reflect.set(target, key, value); },
    defineProperty(_target, key, descriptor) { resolve(); return Reflect.defineProperty(target, key, descriptor); },
    deleteProperty(_target, key) { resolve(); return Reflect.deleteProperty(target, key); },
    preventExtensions() { resolve(); return Reflect.preventExtensions(target); },
  });
  definitionLifetimes.set(definition, { resolve, canonicalZodIdentity, deferZodMethods, nativeZodSchema });
  return definition;
}
