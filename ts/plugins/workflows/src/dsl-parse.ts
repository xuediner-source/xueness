/**
 * Recursive-descent parser for the workflow expression DSL. It rebuilds the
 * tree shape Python's `ast.parse` hands `dsl.py`, so the interpreter in
 * `dsl.ts` can walk it exactly as `expression()` / `literal()` do.
 *
 * Only node *classes* matter downstream, never operator precedence: anything
 * that is valid Python but not a constant, list, tuple, dict, call or name is
 * parsed as `other`, which the interpreter rejects with Python's own message.
 */
import { EOF, fail, SYNTAX, type Tok } from "./dsl-lex.ts";

/** The AST subset the interpreter understands; `other` is valid Python it rejects. */
export type Expr =
  | { readonly k: "const"; readonly v: unknown }
  | { readonly k: "name"; readonly id: string }
  | { readonly k: "list"; readonly items: Expr[] }
  | { readonly k: "tuple"; readonly items: Expr[] }
  | { readonly k: "dict"; readonly entries: Array<[Expr | null, Expr]> }
  | { readonly k: "call"; readonly fn: Expr; readonly args: Expr[]; readonly kw: Array<{ key: string | null; value: Expr }> }
  | { readonly k: "await"; readonly value: Expr }
  | { readonly k: "other" };

export type Stmt =
  | { readonly k: "expr"; readonly v: Expr }
  | { readonly k: "assign"; readonly target: string; readonly v: Expr }
  | { readonly k: "bad" };

export const OTHER: Expr = { k: "other" };
const BAD: Stmt = { k: "bad" };
/** Tokens that end an expression at bracket depth 0. */
const DELIMS = new Set([",", ";", ":", "="]);
const AUGMENTED = new Set(["+=", "-=", "*=", "/=", "//=", "%=", "@=", "&=", "|=", "^=", ">>=", "**="]);
/** Statement keywords Python parses but this DSL rejects (`match`/`case` are soft). */
const KEYWORDS = new Set(["if", "elif", "else", "for", "while", "def", "class", "with", "try", "except",
  "finally", "import", "from", "del", "pass", "raise", "assert", "global", "nonlocal", "return", "break",
  "continue", "async"]);
/** Operators that make an expression non-literal and non-DSL. */
const BINARY = new Set(["+", "-", "*", "/", "//", "%", "@", "**", "|", "^", "&", "<<", ">>", "<", ">", "<=",
  ">=", "==", "!=", ":=", "and", "or", "if", "is", "in", "not"]);

export class Parser {
  readonly #tokens: Tok[];
  #at = 0;

  constructor(tokens: Tok[]) {
    this.#tokens = tokens;
  }

  /** Parse the whole script first, as `ast.parse` does: a syntax error outranks a semantic one. */
  parse(): Stmt[] {
    const body: Stmt[] = [];
    for (;;) {
      this.#skipNewlines();
      if (this.#peek().k === "eof") break;
      body.push(this.#statement());
      this.#endStatement();
    }
    return body;
  }

  #statement(): Stmt {
    const first = this.#peek();
    const second = this.#peekAt(1);
    if (first.k === "name" && KEYWORDS.has(first.t)) return this.#discard();
    if (first.k === "name" && second.k === "op") {
      if (second.t === "=") {
        this.#at += 2;
        const value = this.#testList();
        if (this.#isOp("=")) return this.#discard();
        return { k: "assign", target: first.t, v: value };
      }
      if (AUGMENTED.has(second.t) || second.t === ":") return this.#discard();
    }
    return { k: "expr", v: this.#testList() };
  }

  /** Parse past a statement this DSL rejects; it fails when the body runs. */
  #discard(): Stmt {
    while (this.#peek().k !== "nl" && this.#peek().k !== "eof") this.#at += 1;
    return BAD;
  }

  #endStatement(): void {
    if (this.#isOp(";")) { this.#at += 1; return; }
    if (this.#peek().k === "nl") { this.#at += 1; return; }
    if (this.#peek().k !== "eof") fail(SYNTAX);
  }

  #testList(): Expr {
    const first = this.#test();
    if (!this.#isOp(",")) return first;
    const items = [first];
    while (this.#isOp(",")) {
      this.#at += 1;
      if (this.#atEnd()) break;
      items.push(this.#test());
    }
    return { k: "tuple", items };
  }

  /** One `test`: a literal or DSL call, or `other` for any other valid Python expression. */
  #test(): Expr {
    const value = this.#unary();
    const token = this.#peek();
    const operator = token.k === "op" || token.k === "name" ? token.t : "";
    if (!BINARY.has(operator)) return value;
    this.#skipTo();
    return OTHER;
  }

  #unary(): Expr {
    const token = this.#peek();
    if (token.k === "name" && token.t === "await") { this.#at += 1; return { k: "await", value: this.#unary() }; }
    if ((token.k === "name" && token.t === "not") || (token.k === "op" && "-+~".includes(token.t))) {
      this.#at += 1;
      this.#skipTo();
      return OTHER;
    }
    return this.#primary();
  }

  #primary(): Expr {
    let value = this.#atom();
    for (;;) {
      if (this.#isOp(".")) {
        this.#at += 1;
        if (this.#peek().k !== "name") fail(SYNTAX);
        this.#at += 1;
        value = OTHER;
        continue;
      }
      if (this.#isOp("(")) { value = this.#call(value); continue; }
      if (this.#isOp("[")) { this.#at += 1; this.#skipToClose("]"); value = OTHER; continue; }
      return value;
    }
  }

  #call(fn: Expr): Expr {
    this.#at += 1;
    const args: Expr[] = [];
    const kw: Array<{ key: string | null; value: Expr }> = [];
    while (!this.#isOp(")")) {
      const token = this.#peek();
      if (token.k === "eof" || token.k === "nl") fail(SYNTAX);
      if (this.#isOp("**")) { this.#at += 1; kw.push({ key: null, value: this.#test() }); }
      else if (this.#isOp("*")) { this.#at += 1; this.#skipTo(); args.push(OTHER); }
      else if (token.k === "name" && this.#peekAt(1).k === "op" && this.#peekAt(1).t === "=") {
        this.#at += 2;
        kw.push({ key: token.t, value: this.#test() });
      } else {
        args.push(this.#test());
        // A generator argument is one GeneratorExp, never a stage list.
        if (this.#isName("for")) { this.#skipToClose(")"); return { k: "call", fn, args: [OTHER], kw: [] }; }
      }
      if (this.#isOp(",")) { this.#at += 1; continue; }
      break;
    }
    this.#expectOp(")");
    return { k: "call", fn, args, kw };
  }

  #atom(): Expr {
    const token = this.#peek();
    if (token.k === "num") { this.#at += 1; return { k: "const", v: token.v }; }
    if (token.k === "str") {
      let value = token.v as string;
      this.#at += 1;
      // Adjacent literals concatenate, as in Python.
      while (this.#peek().k === "str") { value += this.#peek().v as string; this.#at += 1; }
      return { k: "const", v: value };
    }
    if (token.k === "other") { this.#at += 1; return OTHER; }
    if (token.k === "name") {
      this.#at += 1;
      if (token.t === "True") return { k: "const", v: true };
      if (token.t === "False") return { k: "const", v: false };
      if (token.t === "None") return { k: "const", v: null };
      if (token.t === "lambda") {
        let level = 0;
        for (;;) {
          const inner = this.#peek();
          if (inner.k === "eof" || inner.k === "nl") fail(SYNTAX);
          if (inner.k === "op" && "([{".includes(inner.t)) level += 1;
          else if (inner.k === "op" && ")]}".includes(inner.t)) level -= 1;
          else if (level === 0 && inner.k === "op" && inner.t === ":") break;
          this.#at += 1;
        }
        this.#at += 1;
        this.#test();
        return OTHER;
      }
      if (token.t === "yield") { this.#skipTo(); return OTHER; }
      return { k: "name", id: token.t };
    }
    if (this.#isOp("...")) { this.#at += 1; return OTHER; }
    if (this.#isOp("(")) return this.#group();
    if (this.#isOp("[")) return this.#list();
    if (this.#isOp("{")) return this.#brace();
    return fail(SYNTAX);
  }

  #group(): Expr {
    this.#at += 1;
    if (this.#isOp(")")) { this.#at += 1; return { k: "tuple", items: [] }; }
    const first = this.#element();
    if (this.#isName("for") || this.#isOp(":=")) { this.#skipToClose(")"); return OTHER; }
    // `(x)` is just `x`; only a comma makes it a tuple.
    if (!this.#isOp(",")) { this.#expectOp(")"); return first; }
    const items = [first];
    while (this.#isOp(",")) {
      this.#at += 1;
      if (this.#isOp(")")) break;
      items.push(this.#element());
    }
    this.#expectOp(")");
    return { k: "tuple", items };
  }

  #list(): Expr {
    this.#at += 1;
    if (this.#isOp("]")) { this.#at += 1; return { k: "list", items: [] }; }
    const first = this.#element();
    if (this.#isName("for") || this.#isOp(":=")) { this.#skipToClose("]"); return OTHER; }
    const items = [first];
    while (this.#isOp(",")) {
      this.#at += 1;
      if (this.#isOp("]")) break;
      items.push(this.#element());
    }
    this.#expectOp("]");
    return { k: "list", items };
  }

  #brace(): Expr {
    this.#at += 1;
    if (this.#isOp("}")) { this.#at += 1; return { k: "dict", entries: [] }; }
    const entries: Array<[Expr | null, Expr]> = [];
    while (!this.#isOp("}")) {
      if (this.#isOp("**")) { this.#at += 1; entries.push([null, this.#test()]); }
      else {
        const key = this.#element();
        // A set display or any comprehension is not a Dict.
        if (this.#isName("for") || this.#isOp(":=") || !this.#isOp(":")) { this.#skipToClose("}"); return OTHER; }
        this.#at += 1;
        entries.push([key, this.#test()]);
      }
      if (this.#isOp(",")) { this.#at += 1; continue; }
      break;
    }
    this.#expectOp("}");
    return { k: "dict", entries };
  }

  #element(): Expr {
    if (this.#isOp("*")) { this.#at += 1; this.#skipTo(); return OTHER; }
    return this.#test();
  }

  #atEnd(): boolean {
    const token = this.#peek();
    return token.k === "eof" || token.k === "nl" || (token.k === "op" && DELIMS.has(token.t));
  }

  /** Consume the rest of an expression we only need to reject, stopping at depth 0. */
  #skipTo(): void {
    let depth = 0;
    for (;;) {
      const token = this.#peek();
      if (token.k === "eof" || token.k === "nl") return;
      if (token.k === "op") {
        if ("([{".includes(token.t)) depth += 1;
        else if (")]}".includes(token.t)) {
          if (depth === 0) return;
          depth -= 1;
        } else if (depth === 0 && DELIMS.has(token.t)) return;
      }
      this.#at += 1;
    }
  }

  /** Consume through the bracket closing the group we are already inside. */
  #skipToClose(close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.#peek();
      if (token.k === "eof") fail(SYNTAX);
      if (token.k === "op") {
        if ("([{".includes(token.t)) depth += 1;
        else if (")]}".includes(token.t)) {
          if (depth === 0) {
            if (token.t !== close) fail(SYNTAX);
            this.#at += 1;
            return;
          }
          depth -= 1;
        }
      }
      this.#at += 1;
    }
  }

  #peek(): Tok { return this.#tokens[this.#at] ?? EOF; }
  #peekAt(offset: number): Tok { return this.#tokens[this.#at + offset] ?? EOF; }
  #isOp(text: string): boolean { const token = this.#peek(); return token.k === "op" && token.t === text; }
  #isName(text: string): boolean { const token = this.#peek(); return token.k === "name" && token.t === text; }

  #expectOp(text: string): void {
    if (!this.#isOp(text)) fail(SYNTAX);
    this.#at += 1;
  }

  #skipNewlines(): void { while (this.#peek().k === "nl") this.#at += 1; }
}
