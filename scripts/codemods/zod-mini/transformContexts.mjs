/**
 * Analyze context-bearing local helpers reached by Zod transforms. Inline
 * callbacks remain the main codemod's responsibility. A refused flow leaves
 * the caller free to reject the whole file before applying any overrides.
 */
export function analyzeTransformContexts({ ast, ts, isTransformCall, isZ, miniAlias, isPureNamedTransform, isNativePayloadContextHelper }) {
  const overrides = new Map();
  const unresolved = [];
  const functions = new Map();
  const declarationCounts = new Map();
  const uses = new Map();
  const contexts = new Map();
  const seenProblems = new Set();
  const alias = () => typeof miniAlias === 'function' ? miniAlias() : miniAlias;
  const visit = (node, fn) => { fn(node); ts.forEachChild(node, child => visit(child, fn)); };
  const problem = (node, method, reason) => {
    const key = `${node.getStart(ast)}:${method}`;
    if (!seenProblems.has(key)) {
      seenProblems.add(key);
      unresolved.push({ node, method, reason });
    }
  };
  const segments = node => ts.isIdentifier(node) ? [node.text]
    : ts.isQualifiedName(node) ? [...segments(node.left), node.right.text] : [];
  const typePath = (node, suffix) => !!node && ts.isTypeReferenceNode(node)
    && (() => {
      const path = segments(node.typeName);
      if (path.length !== suffix.length + 1 || !path.slice(1).every((part, index) => part === suffix[index])) return false;
      let first = node.typeName;
      while (ts.isQualifiedName(first)) first = first.left;
      return isZ(first);
    })();
  const refinementType = node => typePath(node, ['core', '$RefinementCtx']) || typePath(node, ['RefinementCtx']);
  const payloadType = node => typePath(node, ['core', 'ParsePayload']);
  const migratedType = node => payloadType(node) || !!node && ts.isUnionTypeNode(node)
    && node.types.length === 2 && node.types.some(payloadType) && node.types.some(refinementType);
  const contextParameter = (fn, index) => {
    const param = fn.parameters[index];
    return param && ts.isIdentifier(param.name) ? param : null;
  };
  const isFunction = node => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
  const isSuperRefineCall = node => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'superRefine' && isZ(node.expression.expression);
  const isContextName = (node, name) => ts.isIdentifier(node) && node.text === name;
  const localBindings = body => {
    const names = new Set();
    visit(body, node => {
      if ((ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)
        || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) names.add(node.name.text);
    });
    return names;
  };
  const shadowedAt = (reference, name) => {
    for (let parent = reference.parent; parent && parent !== ast; parent = parent.parent) {
      if (isFunction(parent) && parent.body && localBindings(parent.body).has(name)) return true;
    }
    return false;
  };
  const nestedFunctionAt = (reference, name) => {
    for (let scope = reference.parent; scope && scope !== ast; scope = scope.parent) {
      if (ts.isBlock(scope)) {
        const declarations = [];
        for (const statement of scope.statements) {
          if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) declarations.push(statement);
          if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === name) declarations.push(declaration);
          }
        }
        if (declarations.length) return declarations.length === 1 && ts.isFunctionDeclaration(declarations[0])
          ? { fn: declarations[0] } : { shadowed: true };
      }
      if (isFunction(scope) && scope.parameters.some(parameter => ts.isIdentifier(parameter.name)
        && parameter.name.text === name)) return { shadowed: true };
      if (ts.isCatchClause(scope) && scope.variableDeclaration && ts.isIdentifier(scope.variableDeclaration.name)
        && scope.variableDeclaration.name.text === name) return { shadowed: true };
    }
    return null;
  };
  const contextFreeOneArgument = fn => {
    if (!fn.body || fn.parameters.length !== 1 || fn.parameters[0].dotDotDotToken) return false;
    let usesArguments = false;
    visit(fn.body, node => { if (ts.isIdentifier(node) && node.text === 'arguments') usesArguments = true; });
    return !usesArguments;
  };

  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarationCounts.set(statement.name.text, (declarationCounts.get(statement.name.text) ?? 0) + 1);
      if (!statement.body) continue;
      if (functions.has(statement.name.text)) problem(statement.name, 'context', 'local helper name has multiple declarations');
      else functions.set(statement.name.text, statement);
    }
  }

  const addRole = (fn, index, role, node, inline = false) => {
    const param = contextParameter(fn, index);
    if (!param) {
      problem(node, 'context', 'context parameter is not a single bound identifier');
      return;
    }
    let entry = contexts.get(fn);
    if (entry && entry.index !== index) {
      problem(node, 'context', 'helper receives different context parameter positions');
      return;
    }
    if (!entry) {
      entry = { fn, index, param, roles: new Set(), inline, scanned: new Set() };
      contexts.set(fn, entry);
    }
    entry.roles.add(role);
  };

  visit(ast, node => {
    if (!ts.isCallExpression(node) || !(isTransformCall(node) || isSuperRefineCall(node))) return;
    const role = isTransformCall(node) ? 'transform' : 'refine';
    const callback = node.arguments[0];
    if (callback && isFunction(callback) && callback.parameters.length >= 2) addRole(callback, 1, role, callback, true);
    else if (callback && ts.isIdentifier(callback)) {
      const nested = nestedFunctionAt(callback, callback.text);
      if (!nested && role === 'transform' && (declarationCounts.get(callback.text) ?? 0) > 1) {
        problem(callback, 'context', 'named Zod callback has multiple declarations');
        return;
      }
      const fn = nested?.fn ?? (nested ? null : functions.get(callback.text));
      if (nested?.shadowed) {
        if (role === 'transform') problem(callback, 'context', 'named Zod callback is shadowed');
      } else if (nested?.fn && role === 'transform' && contextFreeOneArgument(nested.fn)) {
        // A sole argument cannot receive Classic's context or Mini's payload.
      } else if (nested?.fn && role === 'transform') {
        problem(callback, 'context', 'nested Zod callback may observe its context');
      } else if (!fn) {
        if (role === 'transform' && isPureNamedTransform?.(callback) !== true) {
          problem(callback, 'context', 'named Zod callback is not a unique local function');
        }
      } else if (shadowedAt(callback, callback.text)) {
        if (role === 'transform') problem(callback, 'context', 'named Zod callback is shadowed');
      } else if (fn.parameters.length >= 2) addRole(fn, 1, role, callback);
    } else if (callback && !isFunction(callback) && role === 'transform') {
      problem(callback, 'context', 'Zod callback has an unproven binding');
    }
  });

  // Follow only direct identifier forwarding of the exact bound context to a
  // unique local function. Unknown callees or escapes are not safe to infer.
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of contexts.values()) {
      for (const role of entry.roles) {
        if (entry.scanned.has(role)) continue;
        entry.scanned.add(role);
        changed = true;
        const shadowed = localBindings(entry.fn.body);
        if (shadowed.has(entry.param.name.text)) {
          problem(entry.param, 'context', 'context binding is shadowed inside its function');
          continue;
        }
        visit(entry.fn.body, node => {
          if (!ts.isCallExpression(node)) return;
          for (let index = 0; index < node.arguments.length; index++) {
            if (!isContextName(node.arguments[index], entry.param.name.text)) continue;
            if (!ts.isIdentifier(node.expression)) {
              if (role === 'transform') problem(node, 'context', 'context is forwarded through an unproven call');
              continue;
            }
            const callee = functions.get(node.expression.text);
            if (!callee || (declarationCounts.get(node.expression.text) ?? 0) > 1) {
              if (!callee && role === 'transform' && isNativePayloadContextHelper?.(node.expression, index) === true) continue;
              if (role === 'transform') problem(node, 'context', 'context is forwarded outside a unique local helper');
              continue;
            }
            if (shadowed.has(node.expression.text)) {
              if (role === 'transform') problem(node, 'context', 'local helper name is shadowed at the call site');
              continue;
            }
            const prior = contexts.get(callee);
            addRole(callee, index, role, node);
            if (!prior?.roles.has(role)) changed = true;
            const calls = uses.get(callee) ?? new Set();
            calls.add(node);
            uses.set(callee, calls);
          }
        });
      }
    }
  }

  const propertyName = property => property.name && (ts.isIdentifier(property.name)
    || ts.isStringLiteral(property.name)) ? property.name.text : null;
  const isSafePathSpread = expression => {
    if (ts.isParenthesizedExpression(expression)) return isSafePathSpread(expression.expression);
    if (ts.isConditionalExpression(expression)) return isSafePathSpread(expression.whenTrue)
      && isSafePathSpread(expression.whenFalse);
    return ts.isObjectLiteralExpression(expression) && expression.properties.every(property =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
        && propertyName(property) === 'path');
  };
  const forwardedIssue = (identifier, call) => {
    for (let parent = call.parent; parent; parent = parent.parent) {
      if (!ts.isForOfStatement(parent)) continue;
      const declarations = parent.initializer.declarations;
      if (declarations?.length !== 1 || declarations[0].name.text !== identifier.text
        || !(declarations[0].parent.flags & ts.NodeFlags.Const)) continue;
      const rhs = parent.expression;
      return ts.isPropertyAccessExpression(rhs) && rhs.name.text === 'issues'
        && ts.isPropertyAccessExpression(rhs.expression) && rhs.expression.name.text === 'error';
    }
    return false;
  };
  const issuePlan = (issue, call, ctx) => {
    if (!issue || !ts.isObjectLiteralExpression(issue)) {
      problem(call, 'addIssue', 'transform issue must be a proven object literal');
      return null;
    }
    let spreadIssue = null;
    let code = false;
    let message = false;
    for (const property of issue.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (ts.isIdentifier(property.expression) && forwardedIssue(property.expression, call) && !spreadIssue) {
          spreadIssue = property.expression;
        } else if (!isSafePathSpread(property.expression)) {
          problem(call, 'addIssue', 'issue spread is not a proven forwarded issue or path-only object');
          return null;
        }
        continue;
      }
      const name = propertyName(property);
      if (!name || !(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) {
        problem(call, 'addIssue', 'issue has an unsupported computed or method property');
        return null;
      }
      if (['fatal', 'continue', 'input'].includes(name)) {
        problem(call, 'addIssue', `issue ${name} needs a deliberate raw payload mapping`);
        return null;
      }
      if (name === 'code') code = true;
      if (name === 'message') message = true;
    }
    if ((!code || !message) && !spreadIssue) {
      problem(call, 'addIssue', 'issue requires explicit code and message');
      return null;
    }
    const fallback = spreadIssue
      ? `'input' in ${spreadIssue.text} ? ${spreadIssue.text}.input ?? ${ctx}.value : ${ctx}.value`
      : `${ctx}.value`;
    return { original: issue, fallback, forwarded: !!spreadIssue };
  };

  // A local, exclusively transformed helper must not have unclassified calls.
  for (const entry of contexts.values()) {
    if (!entry.roles.has('transform')) continue;
    if (entry.inline) {
      if (refinementType(entry.param.type)) overrides.set(entry.param.type, () => `${alias()}.core.ParsePayload`);
      continue;
    }
    if (migratedType(entry.param.type)) continue;
    if (!refinementType(entry.param.type)) {
      problem(entry.param, 'context', 'named transform context lacks a proven RefinementCtx type');
      continue;
    }
    if (entry.roles.size === 1 && entry.fn.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
      problem(entry.fn.name ?? entry.fn, 'context', 'exported helper has an unproven external context caller');
    }
    visit(ast, node => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)
        || node.expression.text !== entry.fn.name?.text || uses.get(entry.fn)?.has(node)) return;
      problem(node, 'context', 'helper also has a call outside proven Zod context flow');
    });
    const type = entry.roles.has('refine')
      ? `${alias()}.core.ParsePayload | ${alias()}.core.$RefinementCtx`
      : `${alias()}.core.ParsePayload`;
    overrides.set(entry.param.type, () => type);

    const ctx = entry.param.name.text;
    let nativeIssuePush = false;
    let classicIssueCall = false;
    visit(entry.fn.body, node => {
      if (ts.isIdentifier(node) && node.text === ctx && node !== entry.param.name
        && node.parent && !ts.isPropertyAccessExpression(node.parent)
        && !ts.isCallExpression(node.parent) && !ts.isParameter(node.parent)) {
        problem(node, 'context', 'context escapes direct property access or proven forwarding');
      }
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      if (node.expression.name.text === 'push'
        && ts.isPropertyAccessExpression(node.expression.expression)
        && node.expression.expression.name.text === 'issues'
        && isContextName(node.expression.expression.expression, ctx)) nativeIssuePush = true;
      if (node.expression.name.text !== 'addIssue'
        || !isContextName(node.expression.expression, ctx)) return;
      classicIssueCall = true;
      const conciseForEach = ts.isArrowFunction(node.parent) && node.parent.body === node
        && ts.isCallExpression(node.parent.parent)
        && ts.isPropertyAccessExpression(node.parent.parent.expression)
        && node.parent.parent.expression.name.text === 'forEach';
      if (!(ts.isExpressionStatement(node.parent) || conciseForEach) || node.arguments.length !== 1) {
        problem(node, 'addIssue', 'context issue call has unsupported position or arity');
        return;
      }
      const planned = issuePlan(node.arguments[0], node, ctx);
      if (!planned) return;
      overrides.set(node, render => {
        const original = render(planned.original);
        const close = original.lastIndexOf('}');
        const before = original.slice(0, close).trimEnd();
        const separator = planned.original.properties.length && !before.endsWith(',') ? ', ' : ' ';
        const rawIssue = `${before}${separator}input: ${planned.fallback} ${original.slice(close)}`;
        const cast = planned.forwarded ? ` as ${alias()}.core.$ZodRawIssue` : '';
        const native = `${ctx}.issues.push(${rawIssue}${cast})`;
        return entry.roles.has('refine')
          ? `('addIssue' in ${ctx} ? ${ctx}.addIssue(${original}) : ${native})`
          : `${conciseForEach ? 'void ' : ''}${native}`;
      });
    });
    if (nativeIssuePush && classicIssueCall) problem(entry.fn, 'context', 'helper mixes raw issue pushes and Classic addIssue');
  }

  if (unresolved.length) overrides.clear();
  return { overrides, unresolved };
}
