/**
 * The parts of Python's `argparse` the Xueness CLI uses, ported with its
 * parsing algorithm (option/positional interleaving, greedy `?` positionals,
 * `--`, unique long-option prefixes, subparsers that hand unknown arguments
 * back to the root parser) and its messages, usage lines and exit codes:
 * `usage: …` then `prog: error: …` on stderr with exit 2, help with exit 0.
 */
export const REMAINDER = "...";
const PARSER = "A...";
type Nargs = "?" | "*" | "+" | typeof REMAINDER | typeof PARSER | number | null;
type Kind = "store" | "store_const" | "store_true" | "store_false" | "append" | "help" | "parsers";
export type Args = Record<string, any>;

export interface ArgOptions {
  dest?: string;
  action?: Exclude<Kind, "parsers">;
  const?: unknown;
  default?: unknown;
  /** `int`, `float`, or a converter; a thrown message becomes `argument NAME: message`. */
  type?: "int" | "float" | ((raw: string) => unknown);
  choices?: readonly unknown[];
  nargs?: "?" | "*" | "+" | typeof REMAINDER;
  required?: boolean;
  help?: string;
  metavar?: string;
}

interface Action {
  flags: string[]; dest: string; kind: Kind; nargs: Nargs; const: unknown; default: unknown;
  type: ArgOptions["type"]; choices: readonly unknown[] | null; required: boolean; help: string | undefined; metavar: string | undefined;
  parsers?: Map<string, Parser>; helps?: [string, string | undefined][];
}

/** Raised to end the CLI with an exit status (argparse's `SystemExit`). */
export class CliExit extends Error {
  readonly code: number;
  constructor(code: number) { super(`exit ${code}`); this.code = code; }
}

class ArgumentError extends Error {
  constructor(action: Action | null, message: string) { super(action && actionName(action) ? `argument ${actionName(action)}: ${message}` : message); }
}

/** Python `repr` of a string or number, for argparse messages. */
export function pyRepr(value: unknown): string {
  if (typeof value !== "string") return Array.isArray(value) ? `[${value.map(pyRepr).join(", ")}]` : String(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const body = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
}

function actionName(action: Action): string | null {
  if (action.flags.length) return action.flags.join("/");
  if (action.metavar !== undefined) return action.metavar;
  if (action.dest) return action.dest;
  if (action.choices) return "{" + action.choices.join(",") + "}";
  return null;
}

const UNRECOGNIZED = Symbol("unrecognized");
/** `shutil.get_terminal_size().columns - 2`: COLUMNS, the terminal, else 80. */
const WIDTH = (): number => Math.max(11, (Number.parseInt(process.env.COLUMNS ?? "", 10) || (process.stdout.isTTY ? process.stdout.columns : 0) || 80) - 2);
const PART = /\(.*?\)+(?=\s|$)|\[.*?\]+(?=\s|$)|\S+/g;

function convert(action: Action, raw: string): unknown {
  const type = action.type;
  if (type === undefined) return raw;
  if (type === "int") {
    const text = raw.trim().replace(/_/g, "");
    if (!/^[+-]?\d+$/.test(text) || /^_|_$|__/.test(raw.trim())) throw new ArgumentError(action, `invalid int value: ${pyRepr(raw)}`);
    return Number.parseInt(text, 10);
  }
  if (type === "float") {
    const text = raw.trim().toLowerCase();
    const value = /^[+-]?(inf|infinity)$/.test(text) ? (text.startsWith("-") ? -Infinity : Infinity) : /^[+-]?nan$/.test(text) ? NaN
      : /^[+-]?(\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)(e[+-]?\d+)?$/.test(text) ? Number(text.replace(/_/g, "")) : null;
    if (value === null) throw new ArgumentError(action, `invalid float value: ${pyRepr(raw)}`);
    return value;
  }
  try { return type(raw); } catch (error) { throw new ArgumentError(action, error instanceof Error ? error.message : String(error)); }
}

function check(action: Action, value: unknown): void {
  if (action.choices && !action.choices.includes(value)) {
    throw new ArgumentError(action, `invalid choice: ${pyRepr(value)} (choose from ${action.choices.map(pyRepr).join(", ")})`);
  }
}

function nargsPattern(action: Action): string {
  const n = action.nargs;
  let pattern = n === null ? "(-*A-*)" : n === "?" ? "(-*A?-*)" : n === "*" ? "(-*[A-]*)" : n === "+" ? "(-*A[A-]*)"
    : n === REMAINDER ? "([-AO]*)" : n === PARSER ? "(-*A[-AO]*)" : `(-*${Array.from({ length: n }, () => "A").join("-*")}-*)`;
  if (action.flags.length) pattern = pattern.replace(/-\*/g, "").replace(/-/g, "");
  return pattern;
}

export class Parser {
  readonly prog: string;
  readonly description: string | undefined;
  readonly actions: Action[] = [];
  readonly #defaults: Args = {};

  constructor(prog: string, description?: string) {
    this.prog = prog; this.description = description;
    this.add(["-h", "--help"], { action: "help", help: "show this help message and exit" });
  }

  /** `add_argument`; returns the parser so declarations chain. */
  add(names: string | readonly string[], options: ArgOptions = {}): this {
    const flags = (typeof names === "string" ? [names] : [...names]).filter((name) => name.startsWith("-"));
    const positional = typeof names === "string" ? names : names[0]!;
    const kind = options.action ?? "store";
    const long = flags.find((flag) => flag.startsWith("--")) ?? flags[0];
    const dest = options.dest ?? (flags.length ? long!.replace(/^-+/, "").replace(/-/g, "_") : positional);
    const zero = kind === "store_true" || kind === "store_false" || kind === "store_const" || kind === "help";
    this.actions.push({ flags, dest, kind, nargs: zero ? 0 : options.nargs ?? null,
      const: kind === "store_true" ? true : kind === "store_false" ? false : options.const,
      default: options.default !== undefined ? options.default : Object.hasOwn(this.#defaults, dest) ? this.#defaults[dest] : kind === "store_true" ? false : kind === "store_false" ? true : null,
      type: options.type, choices: options.choices ?? null, required: flags.length ? options.required === true : options.nargs !== "?" && options.nargs !== "*",
      help: options.help, metavar: options.metavar });
    return this;
  }

  setDefaults(values: Args): this {
    Object.assign(this.#defaults, values);
    for (const action of this.actions) if (Object.hasOwn(values, action.dest)) action.default = values[action.dest];
    return this;
  }

  /** `add_subparsers(dest=…, required=…)`. */
  subparsers(dest: string, required = false): { add(name: string, help?: string): Parser; reorder(names: readonly string[]): void } {
    const parsers = new Map<string, Parser>(), helps: [string, string | undefined][] = [];
    const action: Action = { flags: [], dest, kind: "parsers", nargs: PARSER, const: undefined, default: null, type: undefined, choices: null, required, help: undefined, metavar: undefined, parsers, helps };
    this.actions.push(action);
    return { add: (name: string, help?: string): Parser => {
      const parser = new Parser(`${this.prog} ${name}`, help);
      parsers.set(name, parser); helps.push([name, help]); action.choices = [...parsers.keys()];
      return parser;
    }, reorder: (names: readonly string[]): void => {
      // Registration order across modules, as Python's plugin order lists them; unknown names keep their place at the end.
      const rank = (name: string): number => { const at = names.indexOf(name); return at < 0 ? names.length : at; };
      const sorted = [...parsers.entries()].sort((left, right) => rank(left[0]) - rank(right[0]));
      parsers.clear();
      for (const [name, parser] of sorted) parsers.set(name, parser);
      helps.sort((left, right) => rank(left[0]) - rank(right[0]));
      action.choices = [...parsers.keys()];
    } };
  }

  /** `parse_args`: unknown arguments end the run through this (the root) parser. */
  parse(argv: readonly string[]): Args {
    const [args, extras] = this.parseKnown(argv);
    if (extras.length) this.error(`unrecognized arguments: ${extras.join(" ")}`);
    return args;
  }

  parseKnown(argv: readonly string[], namespace: Args = {}): [Args, string[]] {
    for (const action of this.actions) if (action.kind !== "help" && !Object.hasOwn(namespace, action.dest)) namespace[action.dest] = action.default;
    for (const [key, value] of Object.entries(this.#defaults)) if (!Object.hasOwn(namespace, key)) namespace[key] = value;
    try {
      const extras = this.#parse([...argv], namespace);
      const nested = (namespace as Record<symbol, string[]>)[UNRECOGNIZED];
      if (nested) { extras.push(...nested); delete (namespace as Record<symbol, string[]>)[UNRECOGNIZED]; }
      return [namespace, extras];
    } catch (error) {
      if (error instanceof ArgumentError) this.error(error.message);
      throw error;
    }
  }

  #optionMap(): Map<string, Action> {
    const map = new Map<string, Action>();
    for (const action of this.actions) for (const flag of action.flags) map.set(flag, action);
    return map;
  }

  #parseOptional(arg: string, map: Map<string, Action>): [Action | null, string, string | null] | null {
    if (!arg || arg[0] !== "-") return null;
    if (map.has(arg)) return [map.get(arg)!, arg, null];
    if (arg.length === 1) return null;
    if (arg.includes("=")) {
      const at = arg.indexOf("="), flag = arg.slice(0, at);
      if (map.has(flag)) return [map.get(flag)!, flag, arg.slice(at + 1)];
    }
    const matches: [Action, string, string | null][] = [];
    if (arg.startsWith("--")) {
      const at = arg.indexOf("="), prefix = at >= 0 ? arg.slice(0, at) : arg, explicit = at >= 0 ? arg.slice(at + 1) : null;
      for (const [flag, action] of map) if (flag.startsWith(prefix)) matches.push([action, flag, explicit]);
    } else {
      const short = arg.slice(0, 2), rest = arg.slice(2);
      for (const [flag, action] of map) {
        if (flag === short) matches.push([action, flag, rest]);
        else if (flag.startsWith(arg)) matches.push([action, flag, null]);
      }
    }
    if (matches.length > 1) this.error(`ambiguous option: ${arg.split("=")[0]} could match ${matches.map((m) => m[1]).join(", ")}`);
    if (matches.length === 1) return matches[0]!;
    if (/^-\d+$|^-\d*\.\d+$/.test(arg)) return null;
    if (arg.includes(" ")) return null;
    return [null, arg, null];
  }

  #parse(args: string[], ns: Args): string[] {
    const map = this.#optionMap();
    const indices = new Map<number, [Action | null, string, string | null]>();
    let pattern = "";
    let rest = false;
    args.forEach((arg, index) => {
      if (rest) { pattern += "A"; return; }
      if (arg === "--") { rest = true; pattern += "-"; return; }
      const tuple = this.#parseOptional(arg, map);
      if (tuple === null) pattern += "A"; else { indices.set(index, tuple); pattern += "O"; }
    });
    const seen = new Set<Action>(), extras: string[] = [];
    const take = (action: Action, strings: string[], flag?: string): void => {
      seen.add(action);
      this.#apply(action, this.#values(action, strings), ns, flag);
    };
    const consumeOptional = (start: number): number => {
      const [action, flag, explicit] = indices.get(start)!;
      if (action === null) { extras.push(args[start]!); return start + 1; }
      if (explicit !== null) {
        const count = this.#match(action, "A");
        if (count !== 1) throw new ArgumentError(action, `ignored explicit argument ${pyRepr(explicit)}`);
        take(action, [explicit], flag);
        return start + 1;
      }
      const count = this.#match(action, pattern.slice(start + 1));
      take(action, args.slice(start + 1, start + 1 + count), flag);
      return start + 1 + count;
    };
    let positionals = this.actions.filter((action) => !action.flags.length);
    const consumePositionals = (start: number): number => {
      const counts = this.#matchPartial(positionals, pattern.slice(start));
      counts.forEach((count, index) => { take(positionals[index]!, args.slice(start, start + count)); start += count; });
      positionals = positionals.slice(counts.length);
      return start;
    };
    let start = 0;
    const maxOption = indices.size ? Math.max(...indices.keys()) : -1;
    while (start <= maxOption) {
      const next = Math.min(...[...indices.keys()].filter((index) => index >= start));
      if (start !== next) {
        const end = consumePositionals(start);
        if (end > start) { start = end; continue; }
        start = end;
      }
      if (!indices.has(start)) { extras.push(...args.slice(start, next)); start = next; }
      start = consumeOptional(start);
    }
    const stop = consumePositionals(start);
    extras.push(...args.slice(stop));
    const missing: string[] = [];
    for (const action of this.actions) {
      if (seen.has(action)) continue;
      if (action.required) missing.push(actionName(action) ?? action.dest);
      else if (typeof action.default === "string" && action.type !== undefined && ns[action.dest] === action.default) ns[action.dest] = convert(action, action.default);
    }
    if (missing.length) this.error(`the following arguments are required: ${missing.join(", ")}`);
    return extras;
  }

  #match(action: Action, pattern: string): number {
    const match = new RegExp("^" + nargsPattern(action)).exec(pattern);
    if (!match) {
      const n = action.nargs;
      throw new ArgumentError(action, n === null ? "expected one argument" : n === "?" ? "expected at most one argument" : n === "+" ? "expected at least one argument" : `expected ${n} argument${n === 1 ? "" : "s"}`);
    }
    return match[1]!.length;
  }

  #matchPartial(actions: Action[], pattern: string): number[] {
    for (let size = actions.length; size > 0; size--) {
      const match = new RegExp("^" + actions.slice(0, size).map(nargsPattern).join("")).exec(pattern);
      if (match) return match.slice(1).map((group) => group.length);
    }
    return [];
  }

  #values(action: Action, strings: string[]): unknown {
    if (action.nargs !== PARSER && action.nargs !== REMAINDER) { const at = strings.indexOf("--"); if (at >= 0) strings = [...strings.slice(0, at), ...strings.slice(at + 1)]; }
    if (!strings.length && action.nargs === "?") {
      let value = action.flags.length ? action.const : action.default;
      if (typeof value === "string") { value = convert(action, value); check(action, value); }
      return value ?? null;
    }
    if (!strings.length && action.nargs === "*" && !action.flags.length) return action.default ?? [];
    if (strings.length === 1 && (action.nargs === null || action.nargs === "?")) { const value = convert(action, strings[0]!); check(action, value); return value; }
    if (action.nargs === REMAINDER) return strings.map((raw) => convert(action, raw));
    if (action.nargs === PARSER) { const value = strings.map((raw) => convert(action, raw)); check(action, value[0]); return value; }
    if (action.nargs === 0) return null;
    const values = strings.map((raw) => convert(action, raw));
    for (const value of values) check(action, value);
    return values;
  }

  #apply(action: Action, value: unknown, ns: Args, _flag?: string): void {
    if (action.kind === "help") { process.stdout.write(this.formatHelp()); throw new CliExit(0); }
    if (action.kind === "store_true" || action.kind === "store_false" || action.kind === "store_const") { ns[action.dest] = action.const; return; }
    if (action.kind === "append") { ns[action.dest] = [...(Array.isArray(ns[action.dest]) ? ns[action.dest] : []), value]; return; }
    if (action.kind === "parsers") {
      const [name, ...rest] = value as string[];
      ns[action.dest] = name;
      const parser = action.parsers!.get(name!)!;
      const [sub, extras] = parser.parseKnown(rest, {});
      Object.assign(ns, sub);
      if (extras.length) ((ns as Record<symbol, string[]>)[UNRECOGNIZED] ??= []).push(...extras);
      return;
    }
    ns[action.dest] = value;
  }

  /** `error`: usage and the message on stderr, exit 2. */
  error(message: string): never {
    process.stderr.write(this.formatUsage() + `${this.prog}: error: ${message}\n`);
    throw new CliExit(2);
  }

  #metavar(action: Action): string {
    if (action.metavar !== undefined) return action.metavar;
    if (action.choices) return "{" + action.choices.map(String).join(",") + "}";
    return action.flags.length ? action.dest.toUpperCase() : action.dest;
  }

  #formatArgs(action: Action): string {
    const metavar = this.#metavar(action), n = action.nargs;
    return n === null ? metavar : n === "?" ? `[${metavar}]` : n === "*" ? `[${metavar} ...]` : n === "+" ? `${metavar} [${metavar} ...]`
      : n === REMAINDER ? "..." : n === PARSER ? `${metavar} ...` : Array.from({ length: n }, () => metavar).join(" ");
  }

  #usagePart(action: Action): string {
    if (!action.flags.length) return this.#formatArgs(action);
    const part = action.nargs === 0 ? action.flags[0]! : `${action.flags[0]} ${this.#formatArgs(action)}`;
    return action.required ? part : `[${part}]`;
  }

  formatUsage(): string {
    const prefix = "usage: ", width = WIDTH();
    const optionalText = this.actions.filter((a) => a.flags.length).map((a) => this.#usagePart(a)).join(" ");
    const positionalText = this.actions.filter((a) => !a.flags.length).map((a) => this.#usagePart(a)).join(" ");
    const usage = [this.prog, optionalText, positionalText].filter(Boolean).join(" ");
    if (prefix.length + usage.length <= width) return prefix + usage + "\n";
    const lines = (parts: string[], indent: string, first?: string): string[] => {
      const out: string[] = []; let line: string[] = [];
      let size = (first ?? indent).length - 1;
      for (const part of parts) {
        if (size + 1 + part.length > width && line.length) { out.push(indent + line.join(" ")); line = []; size = indent.length - 1; }
        line.push(part); size += part.length + 1;
      }
      if (line.length) out.push(indent + line.join(" "));
      if (first !== undefined && out.length) out[0] = out[0]!.slice(indent.length);
      return out;
    };
    const optionals = optionalText.match(PART) ?? [], positionals = positionalText.match(PART) ?? [];
    let result: string[];
    if (prefix.length + this.prog.length <= 0.75 * width) {
      const indent = " ".repeat(prefix.length + this.prog.length + 1);
      result = optionals.length ? [...lines([this.prog, ...optionals], indent, prefix), ...lines(positionals, indent)]
        : positionals.length ? lines([this.prog, ...positionals], indent, prefix) : [this.prog];
    } else {
      const indent = " ".repeat(prefix.length);
      result = [this.prog, ...lines([...optionals, ...positionals], indent)];
    }
    return prefix + result.join("\n") + "\n";
  }

  formatHelp(): string {
    const width = WIDTH(), column = Math.min(24, Math.max(width - 20, 11 * 2));
    const row = (invocation: string, help: string | undefined, indent = 2): string => {
      const head = " ".repeat(indent) + invocation;
      if (!help) return head + "\n";
      const words = help.split(/\s+/).filter(Boolean), lines: string[] = []; let line = "";
      for (const word of words) { if (line && line.length + 1 + word.length > width - column) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word; }
      if (line) lines.push(line);
      const pad = " ".repeat(column);
      return (head.length + 2 <= column ? head.padEnd(column) + lines[0] : head + "\n" + pad + lines[0]) + "\n" + lines.slice(1).map((l) => pad + l + "\n").join("");
    };
    let text = this.formatUsage();
    if (this.description) text += `\n${this.description}\n`;
    const positionals = this.actions.filter((a) => !a.flags.length), optionals = this.actions.filter((a) => a.flags.length);
    if (positionals.length) {
      text += "\npositional arguments:\n";
      for (const action of positionals) {
        text += row(this.#metavar(action), action.help);
        for (const [name, help] of action.helps ?? []) if (help) text += row(name, help, 4);
      }
    }
    text += "\noptions:\n";
    for (const action of optionals) text += row(action.nargs === 0 ? action.flags.join(", ") : action.flags.map((flag) => `${flag} ${this.#formatArgs(action)}`).join(", "), action.help);
    return text;
  }
}
