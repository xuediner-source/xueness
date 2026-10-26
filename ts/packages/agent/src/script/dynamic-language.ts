/**
 * The published dynamic-workflow language contract: what the compiler accepts,
 * what the evaluator actually executes, and every diagnostic code either side
 * can emit. Hosts may render this surface to users; nothing outside the lists
 * below is a default capability of the runtime.
 */

export const DYNAMIC_LANGUAGE_VERSION = "1.1";

export interface DynamicLanguageSurface {
  version: string;
  statements: readonly string[];
  expressions: readonly string[];
  operators: readonly string[];
  spread: readonly string[];
  destructuring: readonly string[];
  calls: readonly string[];
  namespaces: readonly string[];
  globals: readonly string[];
  typeAnnotations: readonly string[];
  /** Ambient capabilities that stay unavailable to scripts. */
  forbidden: { globals: readonly string[]; properties: readonly string[] };
}

/** Everything a public compatible sample may use without being rejected. */
export const DYNAMIC_LANGUAGE: DynamicLanguageSurface = {
  version: DYNAMIC_LANGUAGE_VERSION,
  statements: [
    "const/let declarations (with destructuring patterns)",
    "expression statements",
    "return",
    "if/else",
    "for",
    "for..of (arrays and strings)",
    "while",
    "do..while",
    "switch (case/default, terminated by break or return)",
    "block",
    "break/continue (unlabeled)",
    "empty statement",
    "interface/type alias declarations (top level, non-generic)",
  ],
  expressions: [
    "identifiers",
    "string/number/boolean/null literals",
    "template literals",
    "array literals (with spread)",
    "object literals (with spread)",
    "property and element access",
    "optional chaining",
    "calls (approved surface only)",
    "arrow functions (map/filter callbacks and values)",
    "await",
    "conditional (ternary)",
    "parenthesized expressions",
    "type assertions: `as T`, `as const`, `as satisfies T` (erased at runtime)",
    "comma expressions",
  ],
  operators: [
    "= += -= *= /= %= **= &&= ||= ??=",
    "+ - * / % **",
    "== === != !== < <= > >=",
    "&& || ??",
    "in (own property test)",
    "! + - ~ typeof void (prefix) and ++ -- (prefix/postfix)",
  ],
  spread: ["array literal elements", "call arguments", "object literal properties"],
  destructuring: [
    "array patterns (with rest elements)",
    "object patterns (literal keys, with rest elements)",
    "default values",
    "declarations, for..of bindings and arrow parameters",
  ],
  calls: [
    "agent(name?, persona?)",
    "actor.ask<T>(instructions)",
    "ask(actor, instructions)",
    "files.read / files.glob",
    "report(item)",
    "log(message)",
    "phase(name)",
    "hole(name, prompt?)",
    "Promise.all(values)",
    "JSON.parse / JSON.stringify",
    "Math.min max round floor ceil abs",
    "String / Number / Boolean conversions",
    "array: map filter join includes slice concat",
    "string: trim slice includes toLowerCase toUpperCase split",
  ],
  namespaces: ["JSON", "Math", "Promise", "files"],
  globals: ["args", "undefined", "agent", "ask", "report", "log", "phase", "hole", "files", "JSON", "Math", "Promise", "String", "Number", "Boolean"],
  typeAnnotations: [
    "interface/type alias members (top level)",
    "variable, parameter and for..of annotations",
    "ask<T> schema synthesis",
  ],
  forbidden: {
    globals: ["process", "require", "fetch", "Date", "global", "globalThis", "console", "Function", "eval"],
    properties: ["constructor", "prototype", "__proto__"],
  },
};

export interface DynamicDiagnosticDescriptor {
  code: string;
  phase: "compile" | "evaluate";
  description: string;
}

/** Every diagnostic code the compiler and evaluator can report. */
export const DYNAMIC_DIAGNOSTICS: readonly DynamicDiagnosticDescriptor[] = [
  { code: "DYN_SOURCE_LENGTH", phase: "compile", description: "Source must contain 1 to 32000 characters." },
  { code: "DYN_UNSUPPORTED_SYNTAX", phase: "compile", description: "The statement, expression or operator is outside the published language surface." },
  { code: "DYN_UNSUPPORTED_TYPE", phase: "compile", description: "Type annotations may not use any, unknown, function, Date or Function types." },
  { code: "DYN_UNSUPPORTED_CALL", phase: "compile", description: "The call target is not part of the approved workflow or value surface." },
  { code: "DYN_FORBIDDEN_GLOBAL", phase: "compile", description: "Ambient globals such as process, Date or console are not available to scripts." },
  { code: "DYN_FORBIDDEN_PROPERTY", phase: "compile", description: "constructor, prototype and __proto__ are blocked at compile time." },
  { code: "DYN_DUPLICATE_ACTOR_NAME", phase: "compile", description: "Two agent() sites declared the same actor name." },
  { code: "DYNAMIC_BUDGET", phase: "evaluate", description: "The operation or port-call budget was exhausted." },
  { code: "DYNAMIC_CANCELLED", phase: "evaluate", description: "Evaluation was cancelled through the host signal." },
  { code: "DYNAMIC_TIMEOUT", phase: "evaluate", description: "The wall-clock deadline configured on the harness elapsed before evaluation finished." },
  { code: "DYNAMIC_PORT", phase: "evaluate", description: "A world-port call was malformed: unknown port or operation." },
  { code: "DYNAMIC_EVALUATION", phase: "evaluate", description: "A runtime rule rejected the operation (unsupported node, invalid handle, bad operand)." },
  { code: "DYNAMIC_PROPERTY", phase: "evaluate", description: "A property read or write touched a blocked, accessor or non-data property." },
  { code: "DYNAMIC_ASSIGNMENT", phase: "evaluate", description: "An assignment targeted a constant, an opaque handle or a non-data object." },
];

/** Human-readable one-screen summary of the published surface, for hosts. */
export function describeDynamicLanguage(): string {
  const surface = DYNAMIC_LANGUAGE;
  const lines = [
    `dynamic workflow language ${surface.version}`,
    `statements: ${surface.statements.join("; ")}`,
    `expressions: ${surface.expressions.join("; ")}`,
    `operators: ${surface.operators.join("; ")}`,
    `spread: ${surface.spread.join("; ")}`,
    `destructuring: ${surface.destructuring.join("; ")}`,
    `calls: ${surface.calls.join("; ")}`,
    `namespaces: ${surface.namespaces.join(", ")}`,
    `globals: ${surface.globals.join(", ")}`,
    `type annotations: ${surface.typeAnnotations.join("; ")}`,
    `unavailable globals: ${surface.forbidden.globals.join(", ")}`,
    `blocked properties: ${surface.forbidden.properties.join(", ")}`,
  ];
  return lines.join("\n");
}
