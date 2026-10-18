import type {Parser} from "./state.ts"
import type {Identifier} from "./ast.ts"
import {raiseRecoverable} from "./location.ts"
import {
  SCOPE_VAR, SCOPE_FUNCTION, SCOPE_TOP, SCOPE_ARROW, SCOPE_SIMPLE_CATCH, BIND_LEXICAL,
  BIND_SIMPLE_CATCH, BIND_FUNCTION, SCOPE_CLASS_FIELD_INIT, SCOPE_CLASS_STATIC_BLOCK,
  SCOPE_GENERATOR, SCOPE_ASYNC, SCOPE_SUPER, SCOPE_DIRECT_SUPER, SCOPE_SWITCH
} from "./scopeflags.ts"

export class Scope {
  flags: number
  // A list of var-declared names in the current lexical scope
  var: string[]
  // A list of lexically-declared names in the current lexical scope
  lexical: string[]
  // A list of lexically-declared FunctionDeclaration names in the current lexical scope
  functions: string[]

  constructor(flags: number) {
    this.flags = flags
    this.var = []
    this.lexical = []
    this.functions = []
  }
}

// The functions in this module keep track of declared variables in the current scope in order to detect duplicate variable names.

export function enterScope(p: Parser, flags: number): void {
  p.scopeStack.push(new Scope(flags))
}

export function exitScope(p: Parser): void {
  p.scopeStack.pop()
}

// The spec says:
// > At the top level of a function, or script, function declarations are
// > treated like var declarations rather than like lexical declarations.
export function treatFunctionsAsVarInScope(p: Parser, scope: Scope): boolean {
  return !!(scope.flags & SCOPE_FUNCTION) || !p.inModule && !!(scope.flags & SCOPE_TOP)
}

export function declareName(p: Parser, name: string, bindingType: number, pos: number): void {
  let redeclared = false
  if (bindingType === BIND_LEXICAL) {
    const scope = currentScope(p)
    redeclared = scope.lexical.indexOf(name) > -1 || scope.functions.indexOf(name) > -1 || scope.var.indexOf(name) > -1
    scope.lexical.push(name)
    if (p.inModule && (scope.flags & SCOPE_TOP))
      p.undefinedExports.delete(name)
  } else if (bindingType === BIND_SIMPLE_CATCH) {
    const scope = currentScope(p)
    scope.lexical.push(name)
  } else if (bindingType === BIND_FUNCTION) {
    const scope = currentScope(p)
    if (treatFunctionsAsVar(p))
      redeclared = scope.lexical.indexOf(name) > -1
    else
      redeclared = scope.lexical.indexOf(name) > -1 || scope.var.indexOf(name) > -1
    scope.functions.push(name)
  } else {
    for (let i = p.scopeStack.length - 1; i >= 0; --i) {
      const scope = p.scopeStack[i]
      if (scope.lexical.indexOf(name) > -1 && !((scope.flags & SCOPE_SIMPLE_CATCH) && scope.lexical[0] === name) ||
          !treatFunctionsAsVarInScope(p, scope) && scope.functions.indexOf(name) > -1) {
        redeclared = true
        break
      }
      scope.var.push(name)
      if (p.inModule && (scope.flags & SCOPE_TOP))
        p.undefinedExports.delete(name)
      if (scope.flags & SCOPE_VAR) break
    }
  }
  if (redeclared) raiseRecoverable(p, pos, `Identifier '${name}' has already been declared`)
}

export function checkLocalExport(p: Parser, id: Identifier): void {
  // scope.functions must be empty as Module code is always strict.
  if (p.scopeStack[0].lexical.indexOf(id.name) === -1 &&
      p.scopeStack[0].var.indexOf(id.name) === -1) {
    p.undefinedExports.set(id.name, id)
  }
}

export function currentScope(p: Parser): Scope {
  return p.scopeStack[p.scopeStack.length - 1]
}

export function currentVarScope(p: Parser): Scope {
  for (let i = p.scopeStack.length - 1;; i--) {
    let scope = p.scopeStack[i]
    if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK)) return scope
  }
}

// Could be useful for `this`, `new.target`, `super()`, `super.property`, and `super[property]`.
export function currentThisScope(p: Parser): Scope {
  for (let i = p.scopeStack.length - 1;; i--) {
    let scope = p.scopeStack[i]
    if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK) &&
        !(scope.flags & SCOPE_ARROW)) return scope
  }
}

// ## Scope-derived predicates

export function inFunction(p: Parser): boolean { return (currentVarScope(p).flags & SCOPE_FUNCTION) > 0 }

export function inGenerator(p: Parser): boolean { return (currentVarScope(p).flags & SCOPE_GENERATOR) > 0 }

export function inAsync(p: Parser): boolean { return (currentVarScope(p).flags & SCOPE_ASYNC) > 0 }

export function canAwait(p: Parser): boolean {
  for (let i = p.scopeStack.length - 1; i >= 0; i--) {
    let {flags} = p.scopeStack[i]
    if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT)) return false
    if (flags & SCOPE_FUNCTION) return (flags & SCOPE_ASYNC) > 0
  }
  return (p.inModule && p.options.ecmaVersion >= 13) || !!p.options.allowAwaitOutsideFunction
}

export function allowReturn(p: Parser): boolean {
  if (inFunction(p)) return true
  if (p.options.allowReturnOutsideFunction && currentVarScope(p).flags & SCOPE_TOP) return true
  return false
}

export function allowSuper(p: Parser): boolean {
  const {flags} = currentThisScope(p)
  return (flags & SCOPE_SUPER) > 0 || !!p.options.allowSuperOutsideMethod
}

export function allowDirectSuper(p: Parser): boolean { return (currentThisScope(p).flags & SCOPE_DIRECT_SUPER) > 0 }

export function treatFunctionsAsVar(p: Parser): boolean { return treatFunctionsAsVarInScope(p, currentScope(p)) }

export function allowNewDotTarget(p: Parser): boolean {
  for (let i = p.scopeStack.length - 1; i >= 0; i--) {
    let {flags} = p.scopeStack[i]
    if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT) ||
        ((flags & SCOPE_FUNCTION) && !(flags & SCOPE_ARROW))) return true
  }
  return false
}

export function allowUsing(p: Parser): boolean {
  const {flags} = currentScope(p)
  if (flags & SCOPE_SWITCH) return false
  if (!p.inModule && flags & SCOPE_TOP) return false
  return true
}

export function inClassStaticBlock(p: Parser): boolean {
  return (currentVarScope(p).flags & SCOPE_CLASS_STATIC_BLOCK) > 0
}
