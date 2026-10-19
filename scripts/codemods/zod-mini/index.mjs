// Development-only Zod Classic to Mini migration. An unresolved operation
// prevents every edit in its file, including the import change.
import { Project, ts } from 'ts-morph';
import * as mini from 'zod/mini';
import { analyzeTransformContexts } from './transformContexts.mjs';

const classicModules = new Set(['zod', 'zod/v4']);
const zodModules = new Set([...classicModules, 'zod/mini']);
const factories = new Set('string number bigint boolean date object strictObject looseObject extend safeExtend merge pick omit partial required catchall keyof array tuple record partialRecord set map file enum nativeEnum literal union discriminatedUnion intersection lazy optional nullable nullish nonoptional _default prefault catch readonly pipe transform preprocess custom instanceof unknown any never null undefined void nan int email url uuid datetime json base64 base64url hex promise templateLiteral'.split(' '));
const keep = new Set('parse safeParse parseAsync safeParseAsync check with clone brand register apply'.split(' '));
const wrappers = new Map([['default', '_default'], ...'optional nullable nullish nonoptional prefault catch readonly array extend safeExtend merge pick omit partial required keyof catchall pipe'.split(' ').map(x => [x, x])]);
const checks = new Set('trim toLowerCase toUpperCase regex refine superRefine describe meta multipleOf positive negative nonpositive nonnegative startsWith endsWith includes lowercase uppercase overwrite base64 base64url hex'.split(' '));
const formats = new Map([['email', 'email'], ['url', 'url'], ['uuid', 'uuid'], ['datetime', 'iso.datetime']]);
const types = new Map([['ZodType', 'ZodMiniType'], ['ZodTypeAny', 'ZodMiniType'], ['ZodObject', 'ZodMiniObject'], ['ZodArray', 'ZodMiniArray'], ['ZodString', 'ZodMiniString'], ['ZodNumber', 'ZodMiniNumber'], ['ZodIssue', 'core.$ZodIssue'], ['ZodError', 'core.$ZodError'], ['ZodRawShape', 'core.$ZodShape'], ['ZodSafeParseResult', 'core.util.SafeParseResult'], ['ZodSafeParseSuccess', 'core.util.SafeParseSuccess'], ['ZodSafeParseError', 'core.util.SafeParseError'], ['RefinementCtx', 'core.$RefinementCtx']]);
const classicScalarInputs = new Map([['ZodString', 'string'], ['ZodNumber', 'number'], ['ZodBoolean', 'boolean'], ['ZodBigInt', 'bigint'], ['ZodDate', 'Date']]);
const miniTypeName = name => types.get(name) ?? (/^Zod[A-Z]/.test(name) && `ZodMini${name.slice(3)}` in mini.z ? `ZodMini${name.slice(3)}` : null);
const reflective = new Set('extend safeExtend merge pick omit partial required keyof catchall check refine superRefine strict strip passthrough loose extract exclude'.split(' '));
const possible = new Set('optional nullable nullish nonoptional default prefault catch readonly brand array or and pipe transform refine superRefine min max length size nonempty int safe finite gt gte lt lte step nonnegative positive nonpositive negative multipleOf safeExtend extend merge pick omit partial required strict passthrough loose strip catchall keyof trim toLowerCase toUpperCase regex email url uuid datetime base64 base64url hex describe meta unwrap removeDefault removeCatch toJSONSchema format flatten extract exclude options rest startsWith endsWith includes lowercase uppercase overwrite'.split(' '));
const wrapperMethods = new Set(['optional', 'nullable', 'nullish', 'nonoptional', 'default', '_default', 'prefault', 'catch', 'readonly', 'lazy']);
const zeroArgMethods = new Set('optional nullable nullish readonly array keyof strict passthrough loose strip unwrap removeDefault removeCatch'.split(' '));
const singleArgMethods = new Set('or and pipe transform rest merge'.split(' '));
const unwrap = node => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node);

/** Convert one file from current bytes. No project files are written here. */
export function transformSource(source, fileName = 'source.ts', options = {}) {
  const factoryOnly = options.factoryOnly === true;
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const ast = project.createSourceFile(fileName, source).compilerNode;
  const imports = [], unresolved = [], edits = [];
  let needsLazyHelper = false;
  const namespaces = new Set(), staticNamespaces = new Set(), dynamicNamespaces = new Set(), dynamicBindings = new Set(), sameSourceDynamicBindings = new Set(), staticNamedImports = new Map(), miniNamespaces = new Set(), namedSchemaTypes = new Set(), namedCoreAliases = new Map(), vars = new Map(), bindings = new Map(), localFunctions = new Map(), localFunctionDeclarationCount = new Map(), occupiedTopLevel = new Set(), api = Object.create(null);
  let coreAliasIndex = 0;
  const nextCoreAlias = () => {
    let alias;
    do alias = `zodMiniCore${coreAliasIndex++}`; while (source.includes(alias));
    return alias;
  };
  const importedSchemas = options.importedSchemas ?? new Set();
  const importedSchemaFactories = options.importedSchemaFactories ?? new Set();
  const importedNeutralSchemas = options.importedNeutralSchemas ?? new Set();
  const importedLiteralObjects = options.importedLiteralObjects ?? new Map();
  const importedPureTransforms = options.importedPureTransforms ?? new Set();
  const importedNativePayloadContexts = options.importedNativePayloadContexts ?? new Map();
  const transformIssueCalls = new Map();
  const transformRawIssuePushes = new Set();
  const seenUnresolved = new Set();
  const hasLazyHelper = ast.statements.some(statement => ts.isImportDeclaration(statement)
    && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some(element => element.name.text === 'lazyZodSchema')
    || ts.isFunctionDeclaration(statement) && statement.name?.text === 'lazyZodSchema');
  const line = node => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const raw = node => source.slice(node.getStart(ast), node.end);
  const mark = (node, method, reason) => {
    const key = `${node.getStart(ast)}:${method}`;
    if (!seenUnresolved.has(key)) {
      seenUnresolved.add(key);
      unresolved.push({ file: fileName, line: line(node), method, reason });
    }
  };
  const count = name => { api[name] = (api[name] ?? 0) + 1; };
  const walk = (root, visit) => {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      visit(node);
      ts.forEachChild(node, child => { stack.push(child); });
    }
  };

  for (const statement of ast.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      occupiedTopLevel.add(statement.name.text);
    }
    if (!factoryOnly && ts.isExportDeclaration(statement) && statement.moduleSpecifier && zodModules.has(statement.moduleSpecifier.text)) {
      mark(statement, 're-export', 'Zod re-export requires a deliberate public API decision');
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const importBinding = statement.importClause?.namedBindings;
    if (statement.importClause?.name) occupiedTopLevel.add(statement.importClause.name.text);
    if (importBinding && ts.isNamespaceImport(importBinding)) occupiedTopLevel.add(importBinding.name.text);
    if (importBinding && ts.isNamedImports(importBinding)) for (const element of importBinding.elements) occupiedTopLevel.add(element.name.text);
    const module = statement.moduleSpecifier.text;
    if (importBinding && ts.isNamedImports(importBinding)) for (const element of importBinding.elements) {
      staticNamedImports.set(element.name.text, { module, name: element.propertyName?.text ?? element.name.text });
    }
    if (!zodModules.has(module)) continue;
    const names = [], clause = statement.importClause;
    if (clause?.name) names.push(`default:${clause.name.text}`);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.add(clause.namedBindings.name.text);
      staticNamespaces.add(clause.namedBindings.name.text);
      if (module === 'zod/mini') miniNamespaces.add(clause.namedBindings.name.text);
      names.push(`*:${clause.namedBindings.name.text}`);
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const name = element.propertyName?.text ?? element.name.text;
        names.push(`${name}:${element.name.text}`);
        if (name === 'z') {
          namespaces.add(element.name.text);
          staticNamespaces.add(element.name.text);
          if (module === 'zod/mini') miniNamespaces.add(element.name.text);
        } else if (!factoryOnly && classicModules.has(module)) {
          const mapped = miniTypeName(name);
          if (mapped && !mapped.includes('.') && mapped in mini.z) {
            namedSchemaTypes.add(element.name.text);
            edits.push({ start: element.getStart(ast), end: element.end, text: `${mapped} as ${element.name.text}` });
          } else if (mapped?.startsWith('core.')) {
            const alias = nextCoreAlias();
            namedCoreAliases.set(element.name.text, `${alias}.${mapped}`);
            edits.push({ start: element.getStart(ast), end: element.end, text: `z as ${alias}` });
          } else if (!(name in mini.z) && !['infer', 'input', 'output'].includes(name)) {
            mark(element, name, 'named Zod import needs an explicit Mini/core mapping');
          }
        }
      }
    }
    imports.push({ file: fileName, line: line(statement), module, names });
    if (!factoryOnly && (clause?.name || !clause?.namedBindings)) mark(statement, 'import', 'default or side-effect Zod import needs manual review');
    if (!factoryOnly && classicModules.has(module)) {
      const q = source[statement.moduleSpecifier.getStart(ast)];
      edits.push({ start: statement.moduleSpecifier.getStart(ast), end: statement.moduleSpecifier.end, text: `${q}zod/mini${q}` });
    }
  }

  function dynamicObjectPattern(node) {
    const directAwait = node.parent;
    if (ts.isAwaitExpression(directAwait) && directAwait.expression === node
      && ts.isVariableDeclaration(directAwait.parent) && directAwait.parent.initializer === directAwait) {
      return ts.isObjectBindingPattern(directAwait.parent.name) ? directAwait.parent.name : null;
    }
    const array = node.parent;
    if (!ts.isArrayLiteralExpression(array)) return null;
    const all = array.parent;
    if (!ts.isCallExpression(all) || all.arguments[0] !== array
      || !ts.isPropertyAccessExpression(all.expression) || !ts.isIdentifier(all.expression.expression)
      || all.expression.expression.text !== 'Promise' || all.expression.name.text !== 'all') return null;
    const awaited = all.parent;
    if (!ts.isAwaitExpression(awaited) || !ts.isVariableDeclaration(awaited.parent)
      || awaited.parent.initializer !== awaited || !ts.isArrayBindingPattern(awaited.parent.name)) return null;
    const entry = awaited.parent.name.elements[array.elements.indexOf(node)];
    return entry && ts.isObjectBindingPattern(entry.name) ? entry.name : null;
  }
  function dynamicZBinding(node) {
    return dynamicObjectPattern(node)?.elements.find(element =>
      (element.propertyName?.text ?? element.name.getText(ast)) === 'z'
      && ts.isIdentifier(element.name)) ?? null;
  }
  walk(ast, node => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal) && zodModules.has(node.argument.literal.text)) {
      const module = node.argument.literal.text;
      imports.push({ file: fileName, line: line(node), module, names: [`type:${node.qualifier?.getText(ast) ?? '*'}`] });
      if (!factoryOnly && classicModules.has(module)
        && (!node.qualifier || !ts.isIdentifier(node.qualifier)
          || !['infer', 'input', 'output'].includes(node.qualifier.text))) {
        mark(node, 'type-import', 'dynamic Zod type requires an explicit Mini/core mapping');
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const module = node.arguments[0].text;
      for (const binding of dynamicObjectPattern(node)?.elements ?? []) {
        if (!ts.isIdentifier(binding.name)) continue;
        const previous = staticNamedImports.get(binding.name.text);
        if (previous?.module === module
          && previous.name === (binding.propertyName?.text ?? binding.name.text)) sameSourceDynamicBindings.add(binding);
      }
      if (!zodModules.has(module)) return;
      const binding = dynamicZBinding(node);
      imports.push({ file: fileName, line: line(node), module, names: binding ? [`dynamic:z:${binding.name.text}`] : ['dynamic:unresolved'] });
      if (!binding) {
        if (!factoryOnly && classicModules.has(module)) mark(node, 'dynamic-import', 'runtime Zod namespace binding is not source-proven');
      } else {
        namespaces.add(binding.name.text);
        dynamicNamespaces.add(binding.name.text);
        dynamicBindings.add(binding);
      }
    }
  });

  function collect(node) {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      if (!bindings.has(node.name.text)) bindings.set(node.name.text, []);
      bindings.get(node.name.text).push(node);
      if (!dynamicBindings.has(node) && !sameSourceDynamicBindings.has(node)
        && (namespaces.has(node.name.text) || importedSchemas.has(node.name.text) || namedCoreAliases.has(node.name.text))) mark(node.name, node.name.text, 'imported Zod/schema symbol is shadowed');
      vars.set(node.name.text, node);
    }
  }
  walk(ast, collect);
  function bindingFor(reference) {
    if (!ts.isIdentifier(reference)) return null;
    const position = reference.getStart(ast);
    let best = null, bestSpan = Infinity;
    for (const declaration of bindings.get(reference.text) ?? []) {
      let scope = declaration.parent;
      while (scope && !ts.isFunctionLike(scope) && !ts.isBlock(scope) && !ts.isSourceFile(scope)
        && !ts.isCaseBlock(scope) && !ts.isForStatement(scope) && !ts.isForOfStatement(scope)) scope = scope.parent;
      if (!scope || scope.getStart(ast) > position || scope.end < reference.end) continue;
      if (declaration.getStart(ast) > position
        && !(ts.isSourceFile(scope) && insideLazyFactory(reference))) continue;
      const span = scope.end - scope.getStart(ast);
      if (span < bestSpan || span === bestSpan && declaration.getStart(ast) > best?.getStart(ast)) {
        best = declaration;
        bestSpan = span;
      }
    }
    return best;
  }
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      localFunctionDeclarationCount.set(name, (localFunctionDeclarationCount.get(name) ?? 0) + 1);
      if (statement.body) localFunctions.set(name, statement);
    }
  }
  function soleReturnExpression(fn) {
    if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
    if (!ts.isBlock(fn.body)) return fn.body;
    const final = fn.body.statements.at(-1);
    if (!final || !ts.isReturnStatement(final) || !final.expression) return null;
    let returns = 0;
    const pending = [fn.body];
    while (pending.length) {
      const node = pending.pop();
      if (ts.isReturnStatement(node)) returns++;
      ts.forEachChild(node, child => { if (!ts.isFunctionLike(child)) pending.push(child); });
    }
    return returns === 1 ? final.expression : null;
  }
  const neutralConstructors = new Set(['defineProtocolObject', 'defineProtocolUnion', 'createProtocolComposableSchema']);
  function isNeutralSchema(node, seen = new Set()) {
    if (unwrap(node)) return isNeutralSchema(node.expression, seen);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      return neutralConstructors.has(node.expression.text) || importedNeutralSchemas.has(node.expression.text);
    }
    if (!ts.isIdentifier(node) || seen.has(node.text)) return false;
    if (importedNeutralSchemas.has(node.text)) return true;
    seen.add(node.text);
    const initializer = bindingFor(node)?.initializer;
    return !!initializer && isNeutralSchema(initializer, seen);
  }
  const canImportLazyHelper = !!options.lazyHelperImport && !vars.has('lazyZodSchema') && !namespaces.has('lazyZodSchema');
  const isZ = node => {
    if (!ts.isIdentifier(node)) return false;
    if (namespaces.has(node.text)) return true;
    const binding = bindingFor(node);
    return !!binding && ts.isParameter(binding) && !!binding.type
      && ts.isTypeQueryNode(binding.type) && ts.isIdentifier(binding.type.exprName)
      && namespaces.has(binding.type.exprName.text);
  };
  const zOf = node => isZ(node) ? node.text : ts.isPropertyAccessExpression(node) && isZ(node.expression) && ['coerce', 'iso'].includes(node.name.text) ? node.expression.text : null;
  function guardedSchema(node) {
    if (!ts.isIdentifier(node)) return null;
    const fromCondition = (condition, negative) => {
      if (negative) {
        if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return null;
        condition = condition.operand;
      }
      while (ts.isParenthesizedExpression(condition)) condition = condition.expression;
      if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword
        || !ts.isIdentifier(condition.left) || condition.left.text !== node.text
        || bindingFor(condition.left) !== bindingFor(node)
        || !ts.isPropertyAccessExpression(condition.right) || !isZ(condition.right.expression)) return null;
      const guarded = {
        ZodMiniOptional: ['unknown', 'optional'], ZodOptional: ['unknown', 'optional'],
        ZodMiniDefault: ['unknown', 'default'], ZodDefault: ['unknown', 'default'],
        ZodMiniNullable: ['unknown', 'nullable'], ZodNullable: ['unknown', 'nullable'],
        ZodMiniPipe: ['unknown', 'pipe'], ZodPipe: ['unknown', 'pipe'],
        ZodMiniLazy: ['unknown', 'lazy'], ZodLazy: ['unknown', 'lazy'],
        ZodMiniUnion: ['union'], ZodUnion: ['union'],
        ZodMiniArray: ['array'], ZodArray: ['array'],
      }[condition.right.name.text];
      return guarded ? { alias: condition.right.expression.text, kind: guarded[0], wrapper: guarded[1] } : null;
    };
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      if (ts.isFunctionLike(parent)) break;
      if (ts.isIfStatement(parent) && parent.thenStatement === child) {
        const proof = fromCondition(parent.expression, false);
        if (proof) return proof;
      }
      if (ts.isBlock(parent)) {
        const index = parent.statements.indexOf(child);
        const previous = index > 0 ? parent.statements[index - 1] : null;
        if (previous && ts.isIfStatement(previous) && !previous.elseStatement
          && (ts.isReturnStatement(previous.thenStatement) || ts.isThrowStatement(previous.thenStatement))) {
          const proof = fromCondition(previous.expression, true);
          if (proof) return proof;
        }
      }
    }
    return null;
  }
  const freshMiniAlias = () => {
    for (let index = 0; ; index++) {
      const alias = index ? `zMini${index}` : 'zMini';
      if (!vars.has(alias) && !namespaces.has(alias) && !occupiedTopLevel.has(alias)) return alias;
    }
  };
  const miniAlias = () => factoryOnly ? ([...miniNamespaces][0] ?? freshMiniAlias())
    : [...staticNamespaces][0] ?? (dynamicNamespaces.size ? freshMiniAlias()
      : vars.has('z') || occupiedTopLevel.has('z') ? freshMiniAlias() : 'z');
  const objectPolicyClone = (runtime, base, catchall, config) => {
    const typeZ = miniAlias();
    return `(<T extends ${typeZ}.ZodMiniObject>(schema: T) => ${runtime}.core.clone(schema, { ...schema._zod.def, catchall: ${catchall} }) as ${typeZ}.ZodMiniObject<T['shape'], ${typeZ}.core.$${config}>)(${base})`;
  };
  const nativePreprocessPipe = (runtime, input, output) => {
    const typeZ = miniAlias();
    return `(<I extends ${typeZ}.core.$ZodType, O extends ${typeZ}.core.$ZodType>(input: I, output: O) => new ${runtime}.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as ${typeZ}.ZodMiniPipe<I, O>)(${input}, ${output})`;
  };
  const insideLazyFactory = node => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))
        && ts.isCallExpression(parent.parent)
        && ts.isIdentifier(parent.parent.expression)
        && parent.parent.expression.text === 'lazyZodSchema'
        && parent.parent.arguments.includes(parent)) return true;
    }
    return false;
  };
  const isSchemaChainChild = node => ts.isPropertyAccessExpression(node.parent)
    && node.parent.expression === node && ts.isCallExpression(node.parent.parent)
    && node.parent.parent.expression === node.parent && !!schema(node.parent.parent);
  const hasReflectiveChain = node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && (reflective.has(node.expression.name.text) || hasReflectiveChain(node.expression.expression));
  const deferredFacadeCheck = node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ['refine', 'superRefine', 'check'].includes(node.expression.name.text)
    && !!schema(node.expression.expression)?.facade;
  function fieldInitializer(shape, name, seen = new Set()) {
    if (!shape) return null;
    if (unwrap(shape)) return fieldInitializer(shape.expression, name, seen);
    if (ts.isIdentifier(shape)) {
      if (seen.has(shape.text)) return null;
      const initializer = bindingFor(shape)?.initializer;
      return initializer ? fieldInitializer(initializer, name, new Set([...seen, shape.text])) : null;
    }
    if (!ts.isObjectLiteralExpression(shape)) return null;
    for (const property of [...shape.properties].reverse()) {
      if (ts.isPropertyAssignment(property)
        && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        && property.name.text === name) return property.initializer;
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
      if (ts.isSpreadAssignment(property)) {
        const inherited = fieldInitializer(property.expression, name, seen);
        if (inherited) return inherited;
      }
    }
    return null;
  }
  function shapeFields(shape, seen = new Set()) {
    if (!shape) return null;
    if (unwrap(shape)) return shapeFields(shape.expression, seen);
    if (ts.isPropertyAccessExpression(shape) && shape.name.text === 'shape') {
      const owner = schema(shape.expression, new Set(seen));
      return owner?.kind === 'object' ? owner.fields ?? null : null;
    }
    if (ts.isIdentifier(shape)) {
      if (seen.has(shape.text)) return null;
      return shapeFields(bindingFor(shape)?.initializer, new Set([...seen, shape.text]));
    }
    if (!ts.isObjectLiteralExpression(shape)) return null;
    const fields = Object.create(null);
    for (const property of shape.properties) {
      if (ts.isSpreadAssignment(property)) Object.assign(fields, shapeFields(property.expression, seen));
      else if (ts.isPropertyAssignment(property)
        && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        const proof = schema(property.initializer, new Set(seen));
        if (proof) fields[property.name.text] = proof;
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const proof = schema(property.name, new Set(seen));
        if (proof) fields[property.name.text] = proof;
      }
    }
    return fields;
  }
  function schemaRecordValueAlias(type) {
    if (!type || !ts.isTypeReferenceNode(type)) return null;
    if (ts.isIdentifier(type.typeName) && type.typeName.text === 'Readonly'
      && type.typeArguments?.length === 1) return schemaRecordValueAlias(type.typeArguments[0]);
    if (!ts.isIdentifier(type.typeName) || type.typeName.text !== 'Record'
      || type.typeArguments?.length !== 2 || type.typeArguments[0].kind !== ts.SyntaxKind.StringKeyword) return null;
    const value = type.typeArguments[1];
    if (!ts.isTypeReferenceNode(value)) return null;
    if (ts.isQualifiedName(value.typeName) && isZ(value.typeName.left)
      && /^Zod(?:Mini)?(?:Type|Object|Array|String|Number)/.test(value.typeName.right.text)) return value.typeName.left.text;
    if (ts.isIdentifier(value.typeName) && namedSchemaTypes.has(value.typeName.text)) return [...namespaces][0] ?? null;
    return null;
  }
  function singleLiteralArgument(node) {
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)
      || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (!ts.isIdentifier(node)) return false;
    const variable = bindingFor(node);
    if (!variable?.type) return false;
    const primitive = constraint => constraint && [ts.SyntaxKind.StringKeyword,
      ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword].includes(constraint.kind);
    if (primitive(variable.type)) return true;
    if (!ts.isTypeReferenceNode(variable.type) || !ts.isIdentifier(variable.type.typeName)) return false;
    const generic = variable.parent?.typeParameters?.find(parameter => parameter.name.text === variable.type.typeName.text);
    return !!generic && primitive(generic.constraint);
  }
  function schema(node, seen = new Set()) {
    if (unwrap(node)) return schema(node.expression, seen);
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return null;
      seen.add(node.text);
      const guarded = guardedSchema(node);
      if (guarded) return guarded;
      const variable = bindingFor(node);
      if (variable && ts.isBindingElement(variable) && ts.isArrayBindingPattern(variable.parent)
        && ts.isParameter(variable.parent.parent) && ts.isArrowFunction(variable.parent.parent.parent)) {
        const callback = variable.parent.parent.parent;
        const map = callback.parent;
        if (ts.isCallExpression(map) && map.arguments[0] === callback
          && ts.isPropertyAccessExpression(map.expression) && map.expression.name.text === 'map'
          && ts.isCallExpression(map.expression.expression)
          && ts.isPropertyAccessExpression(map.expression.expression.expression)
          && ts.isIdentifier(map.expression.expression.expression.expression)
          && map.expression.expression.expression.expression.text === 'Object'
          && map.expression.expression.expression.name.text === 'entries'
          && map.expression.expression.arguments.length === 1
          && ts.isIdentifier(map.expression.expression.arguments[0])
          && variable.parent.elements.indexOf(variable) === 1) {
          const record = bindingFor(map.expression.expression.arguments[0]);
          const alias = schemaRecordValueAlias(record?.type);
          if (alias) return { alias, kind: 'unknown' };
        }
      }
      if (variable && ts.isParameter(variable) && ts.isIdentifier(variable.name)
        && variable.parent?.parameters?.[0] === variable
        && ts.isCallExpression(variable.parent.parent)
        && variable.parent.parent.arguments[0] === variable.parent
        && ts.isPropertyAccessExpression(variable.parent.parent.expression)
        && ['find', 'filter', 'map', 'flatMap', 'some', 'every'].includes(variable.parent.parent.expression.name.text)) {
        const collection = variable.parent.parent.expression.expression;
        let unionOwner = ts.isPropertyAccessExpression(collection) && collection.name.text === 'options'
          ? collection.expression : null;
        if (unionOwner && ts.isPropertyAccessExpression(unionOwner) && unionOwner.name.text === 'def'
          && ts.isPropertyAccessExpression(unionOwner.expression) && unionOwner.expression.name.text === '_zod')
          unionOwner = unionOwner.expression.expression;
        const union = unionOwner && schema(unionOwner, new Set(seen));
        let literal = collection;
        if (ts.isIdentifier(literal)) literal = bindingFor(literal)?.initializer;
        while (literal && unwrap(literal)) literal = literal.expression;
        const importedArray = ts.isIdentifier(collection) && importedSchemas instanceof Map
          ? importedSchemas.get(collection.text) : null;
        const options = union?.kind === 'union' ? union.options
          : importedArray?.kind === 'schemaArray' ? importedArray.elements
          : literal && ts.isArrayLiteralExpression(literal)
            ? literal.elements.map(option => schema(option, new Set(seen))) : null;
        if (options?.length && options.every(option => option?.kind === 'object')) {
          const fields = Object.create(null);
          const optionFields = option => {
            if (option.fields) return option.fields;
            const shape = option.shapeNode;
            if (!shape || !ts.isObjectLiteralExpression(shape)) return null;
            const values = Object.create(null);
            for (const property of shape.properties) if (ts.isPropertyAssignment(property)
              && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
              const proof = schema(property.initializer, new Set(seen));
              if (proof) values[property.name.text] = proof;
            }
            return values;
          };
          const members = options.map(optionFields);
          for (const [field, proof] of Object.entries(members[0] ?? {})) {
            if (members.every(member => member?.[field]?.kind === proof.kind))
              fields[field] = { ...proof, literalSingleton: members.every(member => member[field].literalSingleton) };
          }
          return { alias: union?.alias ?? options[0].alias, kind: 'object', fields };
        }
      }
      if (variable && ts.isBindingElement(variable) && !variable.dotDotDotToken
        && ts.isArrayBindingPattern(variable.parent) && ts.isVariableDeclaration(variable.parent.parent)) {
        const declaration = variable.parent.parent;
        const list = declaration.parent;
        const loop = list.parent;
        if (!variable.initializer && ts.isVariableDeclarationList(list)
          && list.flags & ts.NodeFlags.Const && list.declarations.length === 1
          && ts.isForOfStatement(loop) && loop.initializer === list) {
          let rows = loop.expression;
          while (unwrap(rows)) rows = rows.expression;
          if (ts.isArrayLiteralExpression(rows) && rows.elements.length) {
            const index = variable.parent.elements.indexOf(variable);
            const members = rows.elements.map(row => {
              while (unwrap(row)) row = row.expression;
              if (!ts.isArrayLiteralExpression(row) || row.elements.slice(0, index + 1).some(ts.isSpreadElement)) return null;
              const value = row.elements[index];
              return value ? schema(value, new Set(seen)) : null;
            });
            if (members.every(Boolean)) return {
              alias: members[0].alias,
              kind: members.every(member => member.kind === members[0].kind) ? members[0].kind : 'unknown',
              cold: members.some(member => member.cold),
            };
            const access = node.parent;
            if (members.some(Boolean) && ts.isPropertyAccessExpression(access) && access.expression === node
              && ts.isCallExpression(access.parent) && access.parent.expression === access && possible.has(access.name.text)) {
              mark(access.name, access.name.text, 'tuple schema column is not proven for every row');
            }
          }
        }
        const source = variable.parent.parent.initializer;
        if (source && ts.isPropertyAccessExpression(source) && source.name.text === 'options') {
          let owner = source.expression;
          if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'def'
            && ts.isPropertyAccessExpression(owner.expression) && owner.expression.name.text === '_zod')
            owner = owner.expression.expression;
          const union = schema(owner, new Set(seen));
          const member = union?.kind === 'union' && union.options?.[variable.parent.elements.indexOf(variable)];
          if (member) return { ...member, alias: union.alias };
        }
      }
      if (variable?.initializer) {
        const inferred = schema(variable.initializer, seen);
        if (inferred) return inferred;
      }
      if (variable?.type && ts.isTypeQueryNode(variable.type) && ts.isIdentifier(variable.type.exprName)) {
        const queried = schema(variable.type.exprName, new Set(seen));
        if (queried) return queried;
      }
      if (variable?.type && ts.isTypeReferenceNode(variable.type)
        && ts.isIdentifier(variable.type.typeName) && namedSchemaTypes.has(variable.type.typeName.text)) {
        return { alias: [...namespaces][0] ?? null, kind: 'unknown' };
      }
      if (variable?.type && ts.isTypeReferenceNode(variable.type) && ts.isIdentifier(variable.type.typeName)) {
        const typeName = variable.type.typeName.text;
        for (let owner = variable.parent; owner; owner = owner.parent) {
          const parameter = owner.typeParameters?.find(item => item.name.text === typeName);
          if (!parameter) continue;
          const constraint = parameter.constraint;
          if (constraint && ts.isTypeReferenceNode(constraint)
            && ts.isQualifiedName(constraint.typeName) && isZ(constraint.typeName.left)
            && /^(?:Zod|\$Zod)/.test(constraint.typeName.right.text)) {
            return { alias: constraint.typeName.left.text, kind: 'unknown' };
          }
          if (constraint && ts.isTypeReferenceNode(constraint)
            && ts.isIdentifier(constraint.typeName) && namedSchemaTypes.has(constraint.typeName.text)) {
            return { alias: [...namespaces][0] ?? null, kind: 'unknown' };
          }
          break;
        }
      }
      if (variable?.type && ts.isTypeReferenceNode(variable.type)
        && ts.isQualifiedName(variable.type.typeName)
        && ts.isIdentifier(variable.type.typeName.left)
        && namespaces.has(variable.type.typeName.left.text)
        && /^(?:Zod|\$Zod)/.test(variable.type.typeName.right.text)
        && !/^(?:Zod|\$Zod)(?:Error|Issue|SafeParse|RawShape)/.test(variable.type.typeName.right.text)) {
        for (const alias of namespaces) if (variable.type.typeName.left.text === alias) {
          const annotation = variable.type.typeName.right.text;
          const kind = /(?:ZodMiniString|ZodString)\b/.test(annotation) ? 'string'
            : /(?:ZodMiniNumber|ZodNumber)\b/.test(annotation) ? 'number'
            : /(?:ZodMiniArray|ZodArray)\b/.test(annotation) ? 'array'
            : /(?:ZodMiniObject|ZodObject)\b/.test(annotation) ? 'object' : 'unknown';
          return { alias, kind };
        }
      }
      if (variable?.type && ts.isTypeReferenceNode(variable.type)
        && ts.isQualifiedName(variable.type.typeName)
        && ts.isQualifiedName(variable.type.typeName.left)
        && ts.isIdentifier(variable.type.typeName.left.left)
        && namespaces.has(variable.type.typeName.left.left.text)
        && variable.type.typeName.left.right.text === 'core'
        && /^\$Zod(?:Type|Optional|Default|Nullable|Pipe|Union|Array)$/.test(variable.type.typeName.right.text)) {
        return { alias: variable.type.typeName.left.left.text, kind: 'unknown' };
      }
      if (importedSchemas.has(node.text)) {
        const meta = importedSchemas instanceof Map ? importedSchemas.get(node.text) : {};
        return { alias: [...namespaces][0] ?? null, kind: meta?.kind ?? 'unknown', cold: meta?.cold ?? false, factory: meta?.bridge ?? false, enumSimple: meta?.enumSimple ?? false,
          literalSingleton: meta?.literalSingleton ?? false,
          wrapper: meta?.wrapper, fields: meta?.fields, element: meta?.element, elements: meta?.elements, options: meta?.options, facade: meta?.facade };
      }
      return null;
    }
    if (ts.isConditionalExpression(node)) {
      const yes = schema(node.whenTrue, seen), no = schema(node.whenFalse, seen);
      return yes && no && yes.alias === no.alias ? { alias: yes.alias, kind: yes.kind === no.kind ? yes.kind : 'unknown' } : null;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'shape') {
      const base = schema(node.expression, seen);
      return base?.kind === 'object' ? { ...base, kind: 'shape' } : null;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'options') {
      let owner = node.expression;
      if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'def'
        && ts.isPropertyAccessExpression(owner.expression) && owner.expression.name.text === '_zod')
        owner = owner.expression.expression;
      const base = schema(owner, new Set(seen));
      if (base?.kind === 'union') return { ...base, kind: 'unionOptions' };
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'innerType'
      && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'def'
      && ts.isPropertyAccessExpression(node.expression.expression)
      && node.expression.expression.name.text === '_zod') {
      const base = schema(node.expression.expression.expression, new Set(seen));
      if (base?.wrapper && ['optional', 'nullable', 'nullish', 'nonoptional', 'default', '_default', 'prefault', 'catch', 'readonly'].includes(base.wrapper))
        return { ...base, wrapper: undefined };
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        let annotated = bindingFor(node.expression)?.type;
        if (annotated && ts.isTypeReferenceNode(annotated)
          && ts.isIdentifier(annotated.typeName) && annotated.typeName.text === 'Readonly'
          && annotated.typeArguments?.length === 1) annotated = annotated.typeArguments[0];
        if (annotated && ts.isTypeLiteralNode(annotated)) {
          const field = annotated.members.find(member => ts.isPropertySignature(member)
            && member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
            && member.name.text === node.name.text);
          const type = field?.type;
          if (type && ts.isTypeReferenceNode(type) && ts.isQualifiedName(type.typeName)
            && isZ(type.typeName.left)
            && /^Zod(?:Mini)?(?:Type|Object|Array|String|Number)$/.test(type.typeName.right.text)) {
            const name = type.typeName.right.text;
            return { alias: type.typeName.left.text,
              kind: /Object/.test(name) ? 'object' : /Array/.test(name) ? 'array'
                : /String/.test(name) ? 'string' : /Number/.test(name) ? 'number' : 'unknown' };
          }
        }
      }
      const memberKey = `field:${raw(node)}`;
      if (seen.has(memberKey)) return null;
      const initializer = fieldInitializer(node.expression, node.name.text, new Set(seen));
      if (initializer) {
        const field = schema(initializer, new Set([...seen, memberKey]));
        if (field) return field;
      }
      const parentShape = schema(node.expression, new Set(seen));
      if (['shape', 'record'].includes(parentShape?.kind)) {
        const initializer = parentShape.kind === 'shape' ? fieldInitializer(parentShape.shapeNode, node.name.text) : null;
        const field = initializer ? schema(initializer, new Set(seen)) : parentShape.fields?.[node.name.text];
        if (field) return { ...field, alias: parentShape.alias };
        return parentShape.kind === 'shape' ? { ...parentShape, kind: 'unknown', shapeNode: undefined, wrapper: undefined } : null;
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'element') {
      const base = schema(node.expression, seen);
      return base?.kind === 'array' ? base.element ? { ...base.element, alias: base.alias } : { ...base, kind: 'unknown', wrapper: undefined } : null;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'valueType') {
      const base = schema(node.expression, seen);
      return base?.kind === 'recordSchema' ? base.element ? { ...base.element, alias: base.alias } : { ...base, kind: 'unknown', wrapper: undefined } : null;
    }
    if (ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'options') {
      let owner = node.expression.expression;
      if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'def'
        && ts.isPropertyAccessExpression(owner.expression) && owner.expression.name.text === '_zod')
        owner = owner.expression.expression;
      const base = schema(owner, seen);
      if (base?.kind === 'union') {
        const option = ts.isNumericLiteral(node.argumentExpression) && base.options?.[Number(node.argumentExpression.text)];
        return option ? { ...option, alias: base.alias } : { ...base, kind: 'unknown' };
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'shape') {
      const base = schema(node.expression.expression, seen);
      if (base?.kind === 'object') return { ...base, kind: 'unknown' };
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      const base = schema(node.expression, seen);
      const field = base?.kind === 'record' ? base.fields?.[node.argumentExpression.text] : null;
      if (field) return { ...field, alias: base.alias };
    }
    if (ts.isElementAccessExpression(node) && ts.isNumericLiteral(node.argumentExpression)) {
      const base = schema(node.expression, new Set(seen));
      const member = base?.kind === 'unionOptions' && base.options?.[Number(node.argumentExpression.text)];
      if (member) return { ...member, alias: base.alias };
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'lazyZodSchema') {
      const callback = node.arguments[0];
      const returned = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ? ts.isBlock(callback.body)
          ? [...callback.body.statements].reverse().find(ts.isReturnStatement)?.expression
          : callback.body : null;
      const inferred = returned ? schema(returned, seen) : null;
      return { ...inferred, alias: inferred?.alias ?? [...namespaces][0] ?? null, kind: inferred?.kind ?? 'unknown', cold: true, facade: !!inferred, enumSimple: inferred?.enumSimple ?? false };
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && importedSchemaFactories.has(node.expression.text)) {
      const meta = importedSchemaFactories instanceof Map ? importedSchemaFactories.get(node.expression.text) : {};
      if (meta?.passthroughArg !== undefined) {
        const argument = node.arguments[meta.passthroughArg];
        const proof = argument && schema(argument, new Set(seen));
        if (proof) return proof;
      }
      return { alias: [...namespaces][0] ?? null, kind: meta?.kind ?? 'unknown', cold: meta?.cold ?? false, factory: true, enumSimple: meta?.enumSimple ?? false,
        wrapper: meta?.wrapper, fields: meta?.fields, element: meta?.element, options: meta?.options, facade: meta?.facade };
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (seen.has(name)) return null;
      const local = localFunctions.get(name) ?? bindingFor(node.expression)?.initializer;
      const returned = soleReturnExpression(local);
      if (returned) {
        const proof = schema(returned, new Set([...seen, name]));
        if (proof) return { ...proof, factory: proof.factory || miniNamespaces.has(proof.alias) };
      }
      const declared = local?.type;
      if (declared && ts.isTypeReferenceNode(declared) && ts.isQualifiedName(declared.typeName)
        && isZ(declared.typeName.left) && /^Zod(?:Mini)?(?:Type|Object|Array|String|Number)/.test(declared.typeName.right.text)) {
        const typeName = declared.typeName.right.text;
        return { alias: declared.typeName.left.text,
          kind: /Object/.test(typeName) ? 'object' : /Array/.test(typeName) ? 'array'
            : /String/.test(typeName) ? 'string' : /Number/.test(typeName) ? 'number' : 'unknown',
          factory: true };
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      let invoked = node.expression;
      while (ts.isParenthesizedExpression(invoked)) invoked = invoked.expression;
      if (ts.isArrowFunction(invoked) && invoked.parameters.length === 1
        && invoked.typeParameters?.length === 1
        && ts.isIdentifier(invoked.parameters[0].name)
        && invoked.typeParameters[0].constraint
        && ts.isTypeReferenceNode(invoked.typeParameters[0].constraint)
        && ts.isQualifiedName(invoked.typeParameters[0].constraint.typeName)
        && isZ(invoked.typeParameters[0].constraint.typeName.left)
        && invoked.typeParameters[0].constraint.typeName.right.text === 'ZodMiniObject'
        && ts.isAsExpression(invoked.body)
        && ts.isCallExpression(invoked.body.expression)
        && ts.isPropertyAccessExpression(invoked.body.expression.expression)
        && invoked.body.expression.expression.name.text === 'clone'
        && ts.isPropertyAccessExpression(invoked.body.expression.expression.expression)
        && invoked.body.expression.expression.expression.name.text === 'core'
        && isZ(invoked.body.expression.expression.expression.expression)
        && invoked.body.expression.arguments.length >= 1
        && ts.isIdentifier(invoked.body.expression.arguments[0])
        && invoked.body.expression.arguments[0].text === invoked.parameters[0].name.text) {
        const input = schema(node.arguments[0], new Set(seen));
        if (input?.kind === 'object') return { ...input, kind: 'object' };
      }
    }
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
    const method = node.expression.name.text, receiver = node.expression.expression;
    const alias = zOf(receiver);
    if (alias) {
      if (!factories.has(method)) return null;
      const kind = ['string', 'email', 'url', 'uuid', 'base64', 'base64url', 'hex'].includes(method) || ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'iso' ? 'string'
        : ['number', 'int'].includes(method) ? 'number'
        : method === 'literal' ? 'literal'
        : ['array', 'tuple'].includes(method) ? 'array'
        : method === 'record' || method === 'partialRecord' ? 'recordSchema'
        : ['set', 'map', 'file'].includes(method) ? 'collection'
        : ['object', 'strictObject', 'looseObject', 'extend', 'safeExtend', 'merge', 'pick', 'omit', 'partial', 'required', 'catchall'].includes(method) ? 'object'
        : ['enum', 'nativeEnum', 'keyof'].includes(method) ? 'enum'
        : ['union', 'discriminatedUnion'].includes(method) ? 'union' : 'unknown';
      const wrapped = ['optional', 'nullable', 'nullish', 'nonoptional', '_default', 'prefault', 'catch', 'readonly'].includes(method)
        ? schema(node.arguments[0], new Set(seen)) : null;
      return { alias, kind: wrapped?.kind ?? kind, directFactory: method, enumSimple: method === 'enum' && node.arguments.length === 1,
        literalSingleton: method === 'literal' && node.arguments.length === 1 && singleLiteralArgument(node.arguments[0]),
        wrapper: wrapperMethods.has(method) ? method : undefined,
        shapeNode: wrapped?.shapeNode ?? (kind === 'object' ? node.arguments[0] : undefined),
        fields: ['object', 'strictObject', 'looseObject'].includes(method) ? shapeFields(node.arguments[0], seen)
          : ['extend', 'safeExtend'].includes(method)
            ? { ...schema(node.arguments[0], new Set(seen))?.fields, ...shapeFields(node.arguments[1], seen) }
            : wrapped?.fields ?? (kind === 'object' && node.arguments[0] ? schema(node.arguments[0], new Set(seen))?.fields : undefined),
        element: wrapped?.element ?? (kind === 'array' ? schema(node.arguments[0], new Set(seen))
          : kind === 'recordSchema' ? schema(node.arguments[1], new Set(seen)) : undefined),
        options: kind === 'union' && ts.isArrayLiteralExpression(method === 'discriminatedUnion' ? node.arguments[1] : node.arguments[0])
          ? (method === 'discriminatedUnion' ? node.arguments[1] : node.arguments[0]).elements.map(option => schema(option, new Set(seen))) : undefined };
    }
    const base = schema(receiver, seen);
    if (!base || ['parse', 'safeParse', 'parseAsync', 'safeParseAsync', 'apply', 'toJSONSchema'].includes(method)) return null;
    if (method === 'unwrap' && base.wrapper && base.wrapper !== 'lazy') return { ...base, wrapper: undefined };
    if (base.kind === 'unionOptions' && method === 'find' && base.options?.length
      && base.options.every(option => option?.kind === 'object')) {
      const members = base.options.map(option => option.fields ?? shapeFields(option.shapeNode));
      const fields = Object.create(null);
      for (const [field, proof] of Object.entries(members[0] ?? {})) {
        if (members.every(member => member?.[field]?.kind === proof.kind
          && member[field].wrapper === proof.wrapper)) fields[field] = {
          alias: base.alias, kind: proof.kind, wrapper: proof.wrapper,
          literalSingleton: members.every(member => member[field].literalSingleton),
        };
      }
      return { alias: base.alias, kind: 'object', fields };
    }
    if (['record', 'unionOptions', 'schemaArray'].includes(base.kind)) return null;
    const kind = ['extend', 'safeExtend', 'merge', 'pick', 'omit', 'partial', 'required', 'catchall'].includes(method) ? 'object'
      : method === 'keyof' ? 'enum'
      : method === 'array' ? 'array'
      : ['or', 'and', 'pipe', 'transform'].includes(method) ? 'unknown' : base.kind;
    return { alias: base.alias, kind, directFactory: null, cold: base.cold, ambiguous: base.ambiguous, factory: base.factory, enumSimple: base.enumSimple,
      literalSingleton: base.literalSingleton,
      wrapper: wrapperMethods.has(method) ? method : ['describe', 'meta', 'refine', 'superRefine', 'check', 'brand'].includes(method) ? base.wrapper : undefined,
      facade: ['describe', 'meta', 'refine', 'superRefine', 'check', 'brand'].includes(method) ? base.facade : false,
      shapeNode: kind === 'object' ? base.shapeNode : undefined,
      fields: kind === 'object' ? base.fields : undefined,
      element: method === 'array' ? base : base.element,
      options: kind === 'union' ? base.options : undefined };
  }

  // Rebuild only transformed AST subtrees, using original text for every
  // surrounding token and comment. The outer edit wins over its inner edits.
  const isTransformContextCall = node => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && (node.expression.name.text === 'transform'
      && (isZ(node.expression.expression) || !!schema(node.expression.expression))
      || node.expression.name.text === 'preprocess' && isZ(node.expression.expression));
  const transformContexts = analyzeTransformContexts({
    ast, source, ts, isZ, miniAlias,
    isPureNamedTransform: node => ts.isIdentifier(node)
      && importedPureTransforms.has(node.text) && !bindingFor(node),
    isNativePayloadContextHelper: (node, index) => ts.isIdentifier(node)
      && importedNativePayloadContexts.get(node.text)?.has(index) && !bindingFor(node),
    isTransformCall: isTransformContextCall,
  });
  for (const { node, method, reason } of transformContexts.unresolved) mark(node, method, reason);
  const typeGuardTarget = predicate => {
    if (!ts.isIdentifier(predicate)) return null;
    const declaration = localFunctions.get(predicate.text);
    if (!declaration || !declaration.type || !ts.isTypePredicateNode(declaration.type)
      || !declaration.type.type || !ts.isIdentifier(declaration.type.parameterName)
      || !declaration.parameters[0] || !ts.isIdentifier(declaration.parameters[0].name)
      || declaration.type.parameterName.text !== declaration.parameters[0].name.text) return null;
    return render(declaration.type.type);
  };
  function render(node) {
    if (!factoryOnly && ts.isCallExpression(node) && schema(node)?.cold && hasReflectiveChain(node)
      && !deferredFacadeCheck(node)
      && !insideLazyFactory(node) && !isSchemaChainChild(node)) {
      if (!hasLazyHelper && !canImportLazyHelper) mark(node.expression, 'lazyZodSchema', 'cold derived schema needs an in-scope lazyZodSchema import');
      else {
        if (!hasLazyHelper) needsLazyHelper = true;
        return `lazyZodSchema(() => ${renderNormal(node)})`;
      }
    }
    return renderNormal(node);
  }
  function renderNormal(node) {
    const override = transformContexts.overrides.get(node);
    if (override) return override(render);
    if (ts.isStringLiteral(node) && classicModules.has(node.text)
      && (ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent))) {
      const quote = source[node.getStart(ast)];
      return `${quote}zod/mini${quote}`;
    }
    if (ts.isCallExpression(node) && transformIssueCalls.has(node)) {
      const { name: ctx, conciseForEach } = transformIssueCalls.get(node);
      const issue = node.arguments[0];
      const rendered = render(issue);
      const close = rendered.lastIndexOf('}');
      const before = rendered.slice(0, close).trimEnd();
      const spread = issue.properties.findLast(ts.isSpreadAssignment);
      const fallback = spread
        ? `('input' in ${render(spread.expression)} ? ${render(spread.expression)}.input ?? ${ctx}.value : ${ctx}.value)`
        : `${ctx}.value`;
      const separator = !issue.properties.length ? ' ' : before.trimEnd().endsWith(',') ? ' ' : ', ';
      const rawIssue = spread ? ` as ${miniAlias()}.core.$ZodRawIssue` : '';
      return `${conciseForEach ? 'void ' : ''}${ctx}.issues.push(${before}${separator}input: ${fallback} ${rendered.slice(close)}${rawIssue})`;
    }
    if (ts.isCallExpression(node) && transformRawIssuePushes.has(node)) {
      return `${render(node.expression)}(${render(node.arguments[0])} as ${miniAlias()}.core.$ZodRawIssue)`;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression, method = node.expression.name.text;
      if (['format', 'flatten'].includes(method) && schemaSafeParseError(receiver)
        && node.arguments.length <= 1) {
        return `${miniAlias()}.${method}Error(${render(receiver)}${node.arguments.length ? `, ${render(node.arguments[0])}` : ''})`;
      }
      if (method === 'check' && schema(receiver)) {
        const guardChecks = node.arguments.filter(arg => ts.isCallExpression(arg)
          && !arg.typeArguments?.length && ts.isPropertyAccessExpression(arg.expression)
          && arg.expression.name.text === 'refine' && isZ(arg.expression.expression)
          && arg.arguments[0] && typeGuardTarget(arg.arguments[0]));
        if (guardChecks.length === 1) {
          const guard = guardChecks[0], runtime = guard.expression.expression.text, typeZ = miniAlias();
          const narrowed = node.arguments.map(arg => arg === guard
            ? `${runtime}.refine<${typeZ}.output<typeof base>>(${arg.arguments.map(render).join(', ')})`
            : render(arg));
          return `${render(receiver)}.apply((base) => base.check(${narrowed.join(', ')}) as typeof base & ${typeZ}.ZodMiniType<${typeGuardTarget(guard.arguments[0])}, ${typeZ}.input<typeof base>>)`;
        }
      }
      if (method === 'bind' && ts.isPropertyAccessExpression(receiver)
        && receiver.name.text === 'safeExtend' && node.arguments.length === 1
        && raw(node.arguments[0]) === raw(receiver.expression)
        && schema(receiver.expression)) {
        const runtime = schema(receiver.expression)?.alias ?? miniAlias();
        return `${runtime}.safeExtend.bind(null, ${render(receiver.expression)})`;
      }
      if (!factoryOnly && isZ(receiver) && method === 'catchall' && node.arguments.length === 2) {
        const policy = node.arguments[1];
        if (ts.isCallExpression(policy) && !policy.arguments.length && ts.isPropertyAccessExpression(policy.expression)
          && isZ(policy.expression.expression) && ['never', 'unknown'].includes(policy.expression.name.text)
          && schema(node.arguments[0])?.kind === 'object') {
          const config = policy.expression.name.text === 'never' ? 'strict' : 'loose';
          return objectPolicyClone(receiver.text, render(node.arguments[0]), render(policy), config);
        }
      }
      if (!factoryOnly && isZ(receiver) && method === 'pipe' && node.arguments.length === 2
        && schema(node.arguments[0])
        && ts.isCallExpression(node.arguments[1]) && !node.arguments[1].typeArguments?.length
        && ts.isPropertyAccessExpression(node.arguments[1].expression)
        && isZ(node.arguments[1].expression.expression)
        && node.arguments[1].expression.name.text === 'transform'
        && node.arguments[1].arguments.length === 1) {
        const callback = node.arguments[1].arguments[0];
        if (miniNamespaces.has(receiver.text) && !bindingFor(receiver)
          && ts.isIdentifier(callback) && !bindingFor(callback)
          && (localFunctionDeclarationCount.get(callback.text) ?? 0) > 1) {
          mark(callback, 'transform', 'overloaded local callback has no unique return type');
          return raw(node);
        }
        if (miniNamespaces.has(receiver.text) && !bindingFor(receiver)
          && ts.isIdentifier(callback) && !bindingFor(callback)
          && (importedPureTransforms.has(callback.text)
            || localFunctions.get(callback.text)?.parameters.length === 1
              && !localFunctions.get(callback.text)?.typeParameters?.length
              && localFunctionDeclarationCount.get(callback.text) === 1)) {
          const typeZ = miniAlias();
          return `${render(node.arguments[0])}.apply((schema) => ${receiver.text}.pipe(schema, ${node.arguments[1].expression.expression.text}.transform<${typeZ}.output<typeof schema>, ReturnType<typeof ${callback.text}>>(${render(callback)})))`;
        }
        if ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          && callback.parameters.length === 1 && ts.isIdentifier(callback.parameters[0].name)
          && !callback.parameters[0].type && callback.type && ts.isTypeQueryNode(callback.type)
          && ts.isIdentifier(callback.type.exprName)
          && callback.type.exprName.text === callback.parameters[0].name.text) {
          const typeZ = miniAlias();
          return `${render(node.arguments[0])}.apply((schema) => ${receiver.text}.pipe(schema, ${node.arguments[1].expression.expression.text}.transform<${typeZ}.output<typeof schema>, ${typeZ}.output<typeof schema>>(${render(callback)})))`;
        }
      }
      if (!factoryOnly && isZ(receiver) && method === 'preprocess') {
        const args = node.arguments.map(render);
        if (args.length === 2) return nativePreprocessPipe(receiver.text, `${receiver.text}.transform(${args[0]})`, args[1]);
        mark(node.expression.name, method, 'preprocess requires function and schema');
        return raw(node);
      }
      if (!factoryOnly && isZ(receiver) && method === 'pipe' && node.arguments.length === 2) {
        const input = node.arguments[0];
        if (ts.isCallExpression(input) && ts.isPropertyAccessExpression(input.expression)
          && input.expression.name.text === 'transform' && isZ(input.expression.expression)
          && input.expression.expression.text === receiver.text && input.arguments.length === 1) {
          return nativePreprocessPipe(receiver.text, render(input), render(node.arguments[1]));
        }
      }
      const candidate = schema(receiver);
      const info = candidate && !['record', 'unionOptions', 'schemaArray'].includes(candidate.kind) ? candidate : null;
      if (info && !keep.has(method) && (!factoryOnly || info.factory)) {
        const z = factoryOnly ? miniAlias() : info.alias ?? miniAlias();
        const base = render(receiver), args = node.arguments.map(render), params = args.join(', ');
        const rest = params ? `, ${params}` : '';
        const checked = check => ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)
          && new Set([...checks, ...formats.keys(), 'min', 'max', 'length', 'size', 'nonempty', 'int', 'safe', 'gt', 'gte', 'lt', 'lte', 'step']).has(receiver.expression.name.text)
          && base.endsWith(')') && base.includes('.check(')
          ? `${base.slice(0, -1)}, ${check})` : `${base}.check(${check})`;
        if (method === 'merge') {
          if (node.arguments.length !== 1 || schema(node.arguments[0])?.kind !== 'object') {
            mark(node.expression.name, method, 'merge requires a proven object schema on the right');
            return raw(node);
          }
          const typeZ = miniAlias();
          return `(<A extends ${typeZ}.ZodMiniObject, B extends ${typeZ}.ZodMiniObject>(a: A, b: B) => ${z}.core.util.merge(a, b) as ${typeZ}.ZodMiniObject<${typeZ}.core.util.Extend<A['shape'], B['shape']>, B['_zod']['config']>)(${base}, ${params})`;
        }
        if (method === 'rest') {
          if (info.directFactory !== 'tuple' || !ts.isCallExpression(receiver) || receiver.arguments.length > 2
            || node.arguments.length !== 1) {
            mark(node.expression.name, method, 'tuple rest needs a directly constructed tuple');
            return raw(node);
          }
          return `${z}.tuple(${render(receiver.arguments[0])}, ${params}${receiver.arguments[1] ? `, ${render(receiver.arguments[1])}` : ''})`;
        }
        if (['unwrap', 'removeDefault', 'removeCatch'].includes(method)) {
          if (method === 'removeCatch' && catchGuardedHere(node, receiver)) return `${base}._zod.def.innerType`;
          if (method === 'unwrap' && info.facade && !info.wrapper) return base;
          if (info.wrapper === 'lazy' && method === 'unwrap') return `${base}._zod.innerType`;
          if (info.wrapper && info.wrapper !== 'lazy'
            && (method === 'unwrap' || method === 'removeDefault' && ['default', '_default'].includes(info.wrapper)
              || method === 'removeCatch' && info.wrapper === 'catch')) return `${base}._zod.def.innerType`;
          mark(node.expression.name, method, 'schema wrapper kind is not proven for Mini unwrapping');
          return raw(node);
        }
        if (['extract', 'exclude'].includes(method)) {
          const selections = node.arguments[0];
          const literalSelection = item => ts.isStringLiteral(item) || ts.isPropertyAccessExpression(item)
            && ts.isIdentifier(item.expression) && !bindingFor(item.expression)
            && typeof importedLiteralObjects.get(item.expression.text)?.[item.name.text] === 'string';
          if (info.kind !== 'enum' || !selections || node.arguments.length > 2
            || method === 'extract' && (!ts.isArrayLiteralExpression(selections)
              || !selections.elements.every(literalSelection))
            || method === 'exclude' && !ts.isArrayLiteralExpression(selections) && !ts.isIdentifier(selections)) {
            mark(node.expression.name, method, 'enum selection keys are not statically proven');
            return raw(node);
          }
          const typeZ = miniAlias();
          const subsetType = `${method === 'extract' ? 'Pick' : 'Omit'}<Entries, Keys[number]>`;
          const entries = method === 'extract' ? '{}' : '{ ...schema._zod.def.entries }';
          const select = method === 'extract' ? 'entries[key] = schema._zod.def.entries[key]' : 'delete entries[key]';
          // Zod's native constructor erases the entries generic; the copied key map establishes the narrower type.
          return `(<Entries extends ${typeZ}.core.util.EnumLike, const Keys extends readonly (keyof Entries)[]>(schema: ${typeZ}.ZodMiniEnum<Entries>, selected: Keys, params?: string | ${typeZ}.core.$ZodEnumParams) => { const keys = new Set<PropertyKey>(Object.keys(schema._zod.def.entries)); const entries: Record<PropertyKey, ${typeZ}.core.util.EnumValue> = ${entries}; for (const key of selected) { if (!keys.has(key)) throw new Error(\`Key \${key as string} not found in enum\`); ${select}; } return new ${z}.ZodMiniEnum({ ...schema._zod.def, checks: [], ...${z}.core.util.normalizeParams(params), entries }) as unknown as ${typeZ}.ZodMiniEnum<${subsetType}>; })(${base}, ${params})`;
        }
        if (wrappers.has(method)) return `${z}.${wrappers.get(method)}(${base}${rest})`;
        if (method === 'or') return `${z}.union([${base}, ${params}])`;
        if (method === 'and') return `${z}.intersection(${base}${rest})`;
        if (method === 'transform') return `${z}.pipe(${base}, ${z}.transform(${params}))`;
        if (method === 'refine' && node.arguments[0] && typeGuardTarget(node.arguments[0])) {
          const typeZ = miniAlias();
          return `${base}.apply((base) => base.check(${z}.refine<${typeZ}.output<typeof base>>(${params})) as typeof base & ${typeZ}.ZodMiniType<${typeGuardTarget(node.arguments[0])}, ${typeZ}.input<typeof base>>)`;
        }
        if (checks.has(method)) return checked(`${z}.${method}(${params})`);
        if (['gt', 'gte', 'lt', 'lte'].includes(method) && info.kind === 'number') return checked(`${z}.${method}(${params})`);
        if (method === 'step' && info.kind === 'number') return checked(`${z}.multipleOf(${params})`);
        if (method === 'finite' && info.kind === 'number') return base;
        if (['min', 'max', 'length', 'size', 'nonempty'].includes(method)) {
          const key = method === 'nonempty' ? 'min' : method;
          const mapped = info.kind === 'number' ? { min: 'minimum', max: 'maximum' }[key]
            : info.kind === 'array' ? { min: 'minLength', max: 'maxLength', length: 'length' }[key]
            : info.kind === 'collection' ? { min: 'minSize', max: 'maxSize', size: 'size' }[key]
            : info.kind === 'string' ? { min: 'minLength', max: 'maxLength', length: 'length' }[key] : null;
          if (!mapped) { mark(node.expression.name, method, `schema kind ${info.kind} cannot choose a Mini check`); return raw(node); }
          return checked(`${z}.${mapped}(${method === 'nonempty' ? `1${rest}` : params})`);
        }
        if (formats.has(method)) return checked(`${z}.${formats.get(method)}(${params})`);
        if (['int', 'safe'].includes(method) && info.kind === 'number') return checked(`${z}.int(${params})`);
        if (['strict', 'passthrough', 'loose', 'strip'].includes(method)) {
          if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)
            && isZ(receiver.expression.expression) && receiver.expression.name.text === 'object') {
            if (method === 'strip') return base;
            return `${z}.${method === 'strict' ? 'strictObject' : 'looseObject'}(${receiver.arguments.map(render).join(', ')})`;
          }
          if (info.kind === 'object' && method === 'strip') {
            return objectPolicyClone(z, base, 'undefined', 'strip');
          }
          if (info.kind === 'object') return objectPolicyClone(z, base, `${z}.${method === 'strict' ? 'never' : 'unknown'}()`, method === 'strict' ? 'strict' : 'loose');
          mark(node.expression.name, method, 'derived-object unknown-key policy needs issue-preserving manual conversion');
          return raw(node);
        }
        if (method === 'toJSONSchema') return `${z}.toJSONSchema(${base}${rest})`;
        mark(node.expression.name, method, 'no proven Mini equivalent');
        return raw(node);
      }
      if (!factoryOnly && !info && ts.isIdentifier(receiver) && /Schema$/.test(receiver.text) && possible.has(method)
        && !isNeutralSchema(receiver)) mark(node.expression.name, method, 'schema-like symbol has no provable Zod lineage');
    }
    if (!factoryOnly && ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && isZ(node.expression.expression) && node.expression.name.text === 'ZodIssueCode') return JSON.stringify(node.name.text);
    if (!factoryOnly && ts.isPropertyAccessExpression(node) && node.name.text === 'options'
      && schema(node.expression)?.kind === 'union') return `${render(node.expression)}._zod.def.options`;
    if (!factoryOnly && ts.isPropertyAccessExpression(node) && node.name.text === 'element'
      && schema(node.expression)?.kind === 'array') return `${render(node.expression)}._zod.def.element`;
    if (!factoryOnly && ts.isPropertyAccessExpression(node) && node.name.text === 'valueType'
      && schema(node.expression)?.kind === 'recordSchema') return `${render(node.expression)}._zod.def.valueType`;
    if (!factoryOnly && ts.isPropertyAccessExpression(node) && node.name.text === 'maxLength'
      && schema(node.expression)?.kind === 'string') return `${render(node.expression)}._zod.bag.maximum`;
    if (!factoryOnly && ts.isPropertyAccessExpression(node) && ['minValue', 'maxValue'].includes(node.name.text)
      && schema(node.expression)?.kind === 'number') {
      const stable = ts.isIdentifier(node.expression), base = stable ? render(node.expression) : 'schema';
      const minimum = node.name.text === 'minValue';
      const value = `(Math.${minimum ? 'max' : 'min'}(${base}._zod.bag.${minimum ? 'minimum' : 'maximum'} ?? Number.${minimum ? 'NEGATIVE' : 'POSITIVE'}_INFINITY, ${base}._zod.bag.exclusive${minimum ? 'Minimum' : 'Maximum'} ?? Number.${minimum ? 'NEGATIVE' : 'POSITIVE'}_INFINITY) ?? null)`;
      return stable ? value : `(<T extends ${miniAlias()}.ZodMiniNumber>(schema: T) => ${value})(${render(node.expression)})`;
    }
    if (!factoryOnly && ts.isPropertyAccessExpression(node) && node.name.text === 'value'
      && schema(node.expression)?.kind === 'literal' && schema(node.expression)?.literalSingleton)
      return `${render(node.expression)}._zod.def.values[0]`;
    if (!factoryOnly && ts.isPropertyAccessExpression(node) && node.name.text === 'in'
      && schema(node.expression)?.wrapper === 'pipe') return `${render(node.expression)}._zod.def.in`;
    if (!factoryOnly && ts.isPropertyAccessExpression(node) && node.name.text === 'enum'
      && schema(node.expression)?.kind === 'enum') return `${render(node.expression)}._zod.def.entries`;
    if (!factoryOnly && ts.isIndexedAccessTypeNode(node)
      && ts.isLiteralTypeNode(node.indexType) && ts.isStringLiteral(node.indexType.literal)) {
      let owner = node.objectType;
      while (ts.isParenthesizedTypeNode(owner)) owner = owner.type;
      if (ts.isTypeQueryNode(owner) && ts.isIdentifier(owner.exprName)) {
        const proof = schema(owner.exprName);
        if (node.indexType.literal.text === 'options' && proof?.kind === 'union')
          return `${render(node.objectType)}['_zod']['def']['options']`;
        if (node.indexType.literal.text === '_output' && proof)
          return `${miniAlias()}.output<${render(node.objectType)}>`;
      }
    }
    if (!factoryOnly && ts.isTypeReferenceNode(node)) {
      const name = node.typeName;
      const imported = ts.isIdentifier(name) ? staticNamedImports.get(name.text) : null;
      const classicName = ts.isQualifiedName(name) && isZ(name.left) ? name.right.text
        : imported && classicModules.has(imported.module) ? imported.name : null;
      if (classicName === 'ZodObject' && ts.isQualifiedName(name)
        && node.typeArguments?.length === 1 && node.typeArguments[0].kind === ts.SyntaxKind.AnyKeyword)
        return `${name.left.text}.core.$ZodObject`;
      if (!node.typeArguments?.length) {
        const input = classicScalarInputs.get(classicName);
        if (input) return `${render(name)}<${input}>`;
      }
    }
    if (!factoryOnly && ts.isQualifiedName(node) && ts.isIdentifier(node.left)
      && !namespaces.has(node.left.text) && isZ(node.left)
      && (node.right.text === 'core' || /^ZodMini[A-Z]/.test(node.right.text))) {
      return `${miniAlias()}.${node.right.text}`;
    }
    if (!factoryOnly && ts.isQualifiedName(node) && isZ(node.left)) {
      const replacement = miniTypeName(node.right.text);
      if (replacement) return `${node.left.text}.${replacement}`;
    }
    if (!factoryOnly && ts.isPropertyAccessExpression(node) && isZ(node.expression)) {
      const replacement = miniTypeName(node.name.text);
      if (replacement) return `${node.expression.text}.${replacement}`;
    }
    if (!factoryOnly && ts.isIdentifier(node) && namedCoreAliases.has(node.text)
      && !ts.isImportSpecifier(node.parent)
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      if (ts.isShorthandPropertyAssignment(node.parent)) mark(node, node.text, 'named core alias in shorthand property needs manual expansion');
      return namedCoreAliases.get(node.text);
    }
    let output = '', cursor = node.getStart(ast);
    ts.forEachChild(node, child => {
      if (child.getStart(ast) >= cursor) {
        output += source.slice(cursor, child.getStart(ast)) + render(child);
        cursor = child.end;
      }
    });
    return output + source.slice(cursor, node.end);
  }
  function schemaSafeParseError(receiver) {
    if (!ts.isPropertyAccessExpression(receiver) || receiver.name.text !== 'error') return false;
    let result = receiver.expression;
    if (ts.isIdentifier(result)) {
      const declaration = bindingFor(result);
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
      result = declaration.initializer;
    }
    return ts.isCallExpression(result) && ts.isPropertyAccessExpression(result.expression)
      && ['safeParse', 'safeParseAsync'].includes(result.expression.name.text)
      && !!schema(result.expression.expression);
  }
  function catchGuardedHere(node, receiver) {
    if (!ts.isIdentifier(receiver)) return false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionLike(parent)) return false;
      if (!ts.isConditionalExpression(parent) || node.pos < parent.whenTrue.pos || node.end > parent.whenTrue.end) continue;
      const guard = parent.condition;
      return ts.isBinaryExpression(guard) && guard.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
        && ts.isIdentifier(guard.left) && guard.left.text === receiver.text
        && ts.isPropertyAccessExpression(guard.right) && isZ(guard.right.expression)
        && ['ZodCatch', 'ZodMiniCatch'].includes(guard.right.name.text);
    }
    return false;
  }

  function inspect(node) {
    if (factoryOnly && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const info = schema(node.expression.expression);
      if (info?.factory && !keep.has(node.expression.name.text)
        && !possible.has(node.expression.name.text)) mark(node.expression.name, node.expression.name.text, 'unsupported proven factory schema method');
      return;
    }
    if (factoryOnly) return;
    if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0])
      && zodModules.has(node.arguments[0].text) && ts.isIdentifier(node.expression)
      && ['require', 'import'].includes(node.expression.text)) mark(node, node.expression.text, 'dynamic Zod import needs manual review');
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression, method = node.expression.name.text;
      if (isZ(receiver)) count(method);
      const candidate = schema(receiver);
      const info = candidate && !['record', 'unionOptions', 'schemaArray'].includes(candidate.kind) ? candidate : null;
      if (isTransformContextCall(node)) {
        const callback = node.arguments[0];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          && callback.parameters.length >= 2 && ts.isIdentifier(callback.parameters[1].name)) {
          const context = callback.parameters[1];
          walk(callback.body, issueCall => {
            if (!ts.isCallExpression(issueCall) || !ts.isPropertyAccessExpression(issueCall.expression)) return;
            const call = issueCall.expression;
            if (call.name.text === 'push' && ts.isPropertyAccessExpression(call.expression)
              && call.expression.name.text === 'issues' && ts.isIdentifier(call.expression.expression)
              && bindingFor(call.expression.expression) === context && issueCall.arguments.length === 1
              && ts.isObjectLiteralExpression(issueCall.arguments[0])
              && issueCall.arguments[0].properties.some(property => ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression))
              && issueCall.arguments[0].properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(ast) === 'input')) {
              // Zod's final issue union has narrower code-specific input types
              // than the raw sink, though the Classic fallback admits unknown.
              transformRawIssuePushes.add(issueCall);
              return;
            }
            if (call.name.text !== 'addIssue' || !ts.isIdentifier(call.expression)
              || bindingFor(call.expression) !== context) return;
            const issue = issueCall.arguments[0];
            const spreads = issue && ts.isObjectLiteralExpression(issue) ? issue.properties.filter(ts.isSpreadAssignment) : [];
            const explicitInput = issue && ts.isObjectLiteralExpression(issue) && issue.properties.some(property =>
              (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
              && property.name.text === 'input');
            const conciseForEach = ts.isArrowFunction(issueCall.parent) && issueCall.parent.body === issueCall
              && ts.isCallExpression(issueCall.parent.parent)
              && ts.isPropertyAccessExpression(issueCall.parent.parent.expression)
              && issueCall.parent.parent.expression.name.text === 'forEach'
              && issueCall.parent.parent.arguments.includes(issueCall.parent);
            if (!(ts.isExpressionStatement(issueCall.parent) || conciseForEach) || issueCall.arguments.length !== 1
              || !issue || !ts.isObjectLiteralExpression(issue) || explicitInput
              || spreads.length > 1 || spreads.some(spread => !ts.isIdentifier(spread.expression))) {
              mark(issueCall.expression.name, 'addIssue', 'transform issue argument needs a proven raw Mini payload mapping');
              return;
            }
            transformIssueCalls.set(issueCall, { name: context.name.text, conciseForEach });
          });
        }
      }
      if (info) count(method);
      if (!info && possible.has(method) && ts.isCallExpression(receiver)
        && ts.isPropertyAccessExpression(receiver.expression)
        && zOf(receiver.expression.expression)) {
        mark(node.expression.name, method, 'Zod namespace factory fluent receiver is unclassified');
      }
      if (info?.ambiguous) mark(node.expression.name, method, 'schema symbol is shadowed or multiply declared');
      if (info && method === 'meta' && node.arguments.length === 0) mark(node.expression.name, method, 'Classic metadata getter needs a registry read');
      if (info && (zeroArgMethods.has(method) && node.arguments.length
        || singleArgMethods.has(method) && node.arguments.length !== 1)) {
        mark(node.expression.name, method, 'fluent method arity is not equivalent to Mini');
      }
      if (info?.cold && reflective.has(method) && !deferredFacadeCheck(node)
        && !insideLazyFactory(node) && !hasLazyHelper && !canImportLazyHelper) {
        mark(node.expression.name, method, 'lazyZodSchema derived operation requires an in-scope helper');
      }
      if (info && !keep.has(method) && !possible.has(method)) mark(node.expression.name, method, 'unknown schema method');
      if (!info && possible.has(method) && ts.isIdentifier(receiver) && !insideLazyFactory(receiver)
        && (bindings.get(receiver.text) ?? []).some(declaration => declaration.getStart(ast) > receiver.getStart(ast)
          && ts.isVariableDeclaration(declaration) && declaration.parent?.parent?.parent === ast
          && declaration.initializer && schema(declaration.initializer))) {
        mark(node.expression.name, method, 'forward Zod schema read is not deferred');
      }
      if (!info && possible.has(method) && ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression)) {
        const local = localFunctions.get(receiver.expression.text) ?? bindingFor(receiver.expression)?.initializer;
        if (local && (ts.isFunctionDeclaration(local) || ts.isArrowFunction(local) || ts.isFunctionExpression(local)) && local.body) {
          let zodFactories = 0;
          walk(local.body, candidate => {
            if (ts.isCallExpression(candidate) && ts.isPropertyAccessExpression(candidate.expression)
              && zOf(candidate.expression.expression) && factories.has(candidate.expression.name.text)) zodFactories++;
          });
          if (zodFactories) mark(node.expression.name, method, 'local Zod-bearing factory result has no single proven schema return');
        }
      }
      if (!info && ts.isIdentifier(receiver) && /Schema$/.test(receiver.text) && possible.has(method)
        && !isNeutralSchema(receiver)) mark(node.expression.name, method, 'schema-like symbol has no provable Zod lineage');
      if (['format', 'flatten'].includes(method)
        && (ts.isIdentifier(receiver) && /(?:err|error)$/i.test(receiver.text)
          || ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'error')
        && !(schemaSafeParseError(receiver) && node.arguments.length <= 1)) {
        mark(node.expression.name, method, 'Zod error instance formatter needs a core helper');
      }
    }
    if (ts.isPropertyAccessExpression(node) && isZ(node.expression)) {
      const member = node.name.text;
      if (!types.has(member) && !(member.startsWith('Zod') && `ZodMini${member.slice(3)}` in mini.z)
        && member !== 'ZodIssueCode' && member !== 'preprocess' && !(member in mini.z)) {
        mark(node.name, member, 'namespace member is absent from installed Zod Mini');
      }
    }
    if (ts.isQualifiedName(node) && isZ(node.left) && /^Zod[A-Z]/.test(node.right.text)
      && !types.has(node.right.text) && !(`ZodMini${node.right.text.slice(3)}` in mini.z)
      && !(node.right.text in mini.z)) mark(node.right, node.right.text, 'Zod type is absent from installed Zod Mini');
    if (ts.isPropertyAccessExpression(node) && !isZ(node.expression)) {
      const info = schema(node.expression);
      if (info && !['record', 'unionOptions'].includes(info.kind)
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        const member = node.name.text;
        if (info.kind !== 'shape'
          && !['shape', 'def', '_zod', 'type', 'parse', 'safeParse', 'parseAsync', 'safeParseAsync', 'brand', 'check', 'with', 'clone', 'register', 'apply'].includes(member)
          && !(member === 'safeExtend' && ts.isPropertyAccessExpression(node.parent)
            && node.parent.name.text === 'bind' && ts.isCallExpression(node.parent.parent)
            && node.parent.parent.expression === node.parent
            && node.parent.parent.arguments.length === 1
            && raw(node.parent.parent.arguments[0]) === raw(node.expression))
          && !(member === 'options' && ['enum', 'union'].includes(info.kind))
          && !(member === 'element' && info.kind === 'array')
          && !(member === 'valueType' && info.kind === 'recordSchema')
          && !(member === 'maxLength' && info.kind === 'string')
          && !(['minValue', 'maxValue'].includes(member) && info.kind === 'number')
          && !(member === 'value' && info.kind === 'literal' && info.literalSingleton)
          && !(member === 'in' && info.wrapper === 'pipe')
          && !(member === 'enum' && info.kind === 'enum')
          && !(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'shape' && info.kind === 'shape')) {
          mark(node.name, member, 'schema property is not verified on Zod Mini');
        }
      }
    }
  }
  walk(ast, inspect);
  for (const diagnostic of ast.parseDiagnostics ?? []) mark(ast, 'syntax', String(diagnostic.messageText));
  if (imports.length || importedSchemas.size || importedSchemaFactories.size) {
    for (const statement of ast.statements) {
      if (ts.isImportDeclaration(statement) && zodModules.has(statement.moduleSpecifier.text)) continue;
      const converted = render(statement);
      if (converted !== raw(statement)) edits.push({ start: statement.getStart(ast), end: statement.end, text: converted });
    }
  }
  const needsDynamicHelperImport = dynamicNamespaces.size && !staticNamespaces.size
    && edits.some(edit => edit.text.includes(`${freshMiniAlias()}.`));
  if (edits.length && (factoryOnly ? !miniNamespaces.size
    : !imports.length && (importedSchemas.size || importedSchemaFactories.size) || needsDynamicHelperImport)) {
    edits.push({ start: 0, end: 0, text: `import * as ${miniAlias()} from 'zod/mini';\n` });
  }
  if (needsLazyHelper) edits.push({ start: 0, end: 0, text: `import { lazyZodSchema } from '${options.lazyHelperImport}';\n` });
  unresolved.sort((a, b) => a.line - b.line || a.method.localeCompare(b.method));
  if (unresolved.length) return { output: source, changed: false, unresolved, imports, api };
  edits.sort((a, b) => b.start - a.start);
  let output = source;
  for (const edit of edits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  if (!factoryOnly) {
    // A converted expression may be the first runtime use of a namespace
    // previously imported only for z.infer, or of a namespace not imported at
    // all when the file had only named Zod type imports.
    const parsed = ts.createSourceFile(fileName, output, ts.ScriptTarget.Latest, true);
    const runtimeNamespaces = new Set();
    walk(parsed, node => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) runtimeNamespaces.add(node.expression.text);
    });
    const boundNamespaces = new Set();
    const bindingEdits = [];
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || !zodModules.has(statement.moduleSpecifier.text)) continue;
      const clause = statement.importClause;
      if (!clause?.namedBindings) continue;
      const names = ts.isNamespaceImport(clause.namedBindings)
        ? [clause.namedBindings.name.text]
        : clause.namedBindings.elements.filter(element => (element.propertyName?.text ?? element.name.text) === 'z')
          .map(element => element.name.text);
      for (const name of names) boundNamespaces.add(name);
      if (clause.isTypeOnly && names.some(name => runtimeNamespaces.has(name))) {
        const start = statement.getStart(parsed), original = output.slice(start, statement.end);
        const promoted = original.replace(/^import\s+type\b/, 'import');
        if (promoted === original) mark(ast, 'import type', 'runtime Zod namespace import could not be promoted');
        else bindingEdits.push({ start, end: statement.end, text: promoted });
      } else if (ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) !== 'z' || !element.isTypeOnly
            || !runtimeNamespaces.has(element.name.text)) continue;
          const start = element.getStart(parsed), original = output.slice(start, element.end);
          const promoted = original.replace(/^type\s+/, '');
          if (promoted === original) mark(ast, 'import type', 'runtime Zod namespace specifier could not be promoted');
          else bindingEdits.push({ start, end: element.end, text: promoted });
        }
      }
    }
    const missing = miniAlias();
    if (runtimeNamespaces.has(missing) && !boundNamespaces.has(missing) && !vars.has(missing)) {
      bindingEdits.push({ start: 0, end: 0, text: `import * as ${missing} from 'zod/mini';\n` });
    }
    bindingEdits.sort((a, b) => b.start - a.start);
    for (const edit of bindingEdits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  if (output !== source) {
    const result = ts.createSourceFile(fileName, output, ts.ScriptTarget.Latest, true);
    for (const diagnostic of result.parseDiagnostics ?? []) mark(ast, 'output syntax', String(diagnostic.messageText));
  }
  if (unresolved.length) return { output: source, changed: false, unresolved, imports, api };
  return { output, changed: output !== source, unresolved, imports, api };
}
