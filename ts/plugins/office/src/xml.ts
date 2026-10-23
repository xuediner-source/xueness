/**
 * A small non-validating XML reader with `xml.etree.ElementTree` results:
 * Clark-notation tags and attribute names (`{uri}local`), `.text` before the
 * first child, `.tail` after an element, comments and processing instructions
 * dropped (their surrounding text joins), expat's line-end and attribute
 * whitespace normalization. Callers reject DOCTYPE and ENTITY first; there is
 * no DTD and no external entity.
 */
export class XmlParseError extends Error { override name = "ParseError"; }

export interface XmlElement {
  tag: string;
  attrib: Record<string, string>;
  text: string | null;
  tail: string | null;
  children: XmlElement[];
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const NAME = /^[A-Za-z_\u00c0-\uffff][\w.\-\u00b7\u00c0-\uffff]*(?::[A-Za-z_\u00c0-\uffff][\w.\-\u00b7\u00c0-\uffff]*)?/;

function decode(raw: Uint8Array): string {
  const bytes = Buffer.from(raw);
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
    const head = bytes.subarray(0, 200).toString("latin1");
    const declared = /^(?:\xef\xbb\xbf)?<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/.exec(head)?.[1]?.toLowerCase();
    if (declared && !["utf-8", "utf8", "us-ascii", "ascii"].includes(declared)) throw new XmlParseError(`unsupported encoding: ${declared}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) { if (error instanceof XmlParseError) throw error; throw new XmlParseError("not well-formed (invalid token)"); }
}

function entities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z_][\w.-]*)?(;?)/g, (_match, body: string | undefined, semi: string) => {
    if (!body || !semi) throw new XmlParseError("not well-formed (invalid token)");
    if (body[0] === "#") {
      const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      const valid = code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff;
      if (!valid) throw new XmlParseError("reference to invalid character number");
      return String.fromCodePoint(code);
    }
    const value = PREDEFINED[body];
    if (value === undefined) throw new XmlParseError("undefined entity");
    return value;
  });
}

const INVALID_CHAR = /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** `ET.fromstring(raw)` for one document. */
/** expat: input ending inside a start tag is an "unclosed token", anything else there is invalid. */
const tagError = (source: string, at: number): XmlParseError => new XmlParseError(/^[ \t\n]*$/.test(source.slice(at)) ? "unclosed token" : "not well-formed (invalid token)");

export function parseXml(raw: Uint8Array): XmlElement {
  const source = decode(raw).replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  if (INVALID_CHAR.test(source)) throw new XmlParseError("not well-formed (invalid token)");
  let at = 0, root: XmlElement | null = null, pending = "";
  const stack: { element: XmlElement; namespaces: Map<string, string>; raw: string }[] = [];
  const flush = (): void => {
    if (!pending) return;
    const top = stack.at(-1);
    if (!top) { if (/[^ \t\n]/.test(pending)) throw new XmlParseError(root ? "junk after document element" : "syntax error"); pending = ""; return; }
    const last = top.element.children.at(-1);
    if (last) last.tail = (last.tail ?? "") + pending; else top.element.text = (top.element.text ?? "") + pending;
    pending = "";
  };
  const resolve = (qname: string, namespaces: Map<string, string>, attribute: boolean): string => {
    const colon = qname.indexOf(":");
    if (colon < 0) { const uri = attribute ? "" : namespaces.get("") ?? ""; return uri ? `{${uri}}${qname}` : qname; }
    const prefix = qname.slice(0, colon), local = qname.slice(colon + 1);
    const uri = prefix === "xml" ? XML_NS : namespaces.get(prefix);
    if (!uri) throw new XmlParseError("unbound prefix");
    return `{${uri}}${local}`;
  };
  while (at < source.length) {
    const lt = source.indexOf("<", at);
    if (lt < 0) { pending += entities(source.slice(at)); at = source.length; break; }
    if (lt > at) { const chunk = source.slice(at, lt); if (chunk.includes("]]>")) throw new XmlParseError("not well-formed (invalid token)"); pending += entities(chunk); }
    if (source.startsWith("<!--", lt)) { const end = source.indexOf("-->", lt + 4); if (end < 0) throw new XmlParseError("unclosed token"); at = end + 3; continue; }
    if (source.startsWith("<![CDATA[", lt)) { const end = source.indexOf("]]>", lt + 9); if (end < 0 || !stack.length) throw new XmlParseError("unclosed CDATA section"); pending += source.slice(lt + 9, end); at = end + 3; continue; }
    if (source.startsWith("<?", lt)) { const end = source.indexOf("?>", lt + 2); if (end < 0) throw new XmlParseError("unclosed token"); at = end + 2; continue; }
    if (source.startsWith("<!", lt)) throw new XmlParseError("XML entities are not supported");
    if (source[lt + 1] === "/") {
      const end = source.indexOf(">", lt);
      if (end < 0) throw new XmlParseError("unclosed token");
      const name = source.slice(lt + 2, end).replace(/[ \t\n]+$/, "");
      if (NAME.exec(name)?.[0] !== name) throw new XmlParseError("not well-formed (invalid token)");
      flush();
      const top = stack.pop();
      if (!top || top.raw !== name) throw new XmlParseError("mismatched tag");
      at = end + 1;
      continue;
    }
    if (root && !stack.length) throw new XmlParseError("junk after document element");
    let cursor = lt + 1;
    const nameMatch = NAME.exec(source.slice(cursor, cursor + 512));
    if (!nameMatch) throw tagError(source, cursor);
    const rawName = nameMatch[0]; cursor += rawName.length;
    const rawAttributes: [string, string][] = [];
    let selfClosing = false;
    for (;;) {
      const space = /^[ \t\n]*/.exec(source.slice(cursor, cursor + 4096))![0]; cursor += space.length;
      if (source[cursor] === ">") { cursor += 1; break; }
      if (source.startsWith("/>", cursor)) { cursor += 2; selfClosing = true; break; }
      if (!space) throw source.slice(cursor) === "/" ? new XmlParseError("unclosed token") : tagError(source, cursor);
      const attribute = NAME.exec(source.slice(cursor, cursor + 512));
      if (!attribute) throw tagError(source, cursor);
      cursor += attribute[0].length;
      const eq = /^[ \t\n]*=[ \t\n]*/.exec(source.slice(cursor, cursor + 256));
      if (!eq) throw tagError(source, cursor);
      cursor += eq[0].length;
      const quote = source[cursor];
      if (quote !== '"' && quote !== "'") throw tagError(source, cursor);
      const close = source.indexOf(quote, cursor + 1);
      if (close < 0) throw new XmlParseError("unclosed token");
      const value = source.slice(cursor + 1, close);
      if (value.includes("<")) throw new XmlParseError("not well-formed (invalid token)");
      if (rawAttributes.some(([name]) => name === attribute[0])) throw new XmlParseError("duplicate attribute");
      rawAttributes.push([attribute[0], entities(value.replace(/[\t\n]/g, " "))]);
      cursor = close + 1;
    }
    flush();
    const namespaces = new Map(stack.at(-1)?.namespaces ?? []);
    for (const [name, value] of rawAttributes) {
      if (name === "xmlns") namespaces.set("", value);
      else if (name.startsWith("xmlns:")) namespaces.set(name.slice(6), value);
    }
    const attrib: Record<string, string> = {};
    for (const [name, value] of rawAttributes) if (name !== "xmlns" && !name.startsWith("xmlns:")) attrib[resolve(name, namespaces, true)] = value;
    const element: XmlElement = { tag: resolve(rawName, namespaces, false), attrib, text: null, tail: null, children: [] };
    const parent = stack.at(-1);
    if (parent) parent.element.children.push(element); else root = element;
    if (!selfClosing) stack.push({ element, namespaces, raw: rawName });
    at = cursor;
  }
  flush();
  if (stack.length || !root) throw new XmlParseError("no element found");
  return root;
}

/** Python's `{prefix: uri}` map for `find`/`findall` paths such as `.//w:t` or `a:solidFill/a:srgbClr`. */
export type Namespaces = Readonly<Record<string, string>>;

function qualify(step: string, ns: Namespaces): string {
  const colon = step.indexOf(":");
  if (colon < 0) return step;
  const uri = ns[step.slice(0, colon)];
  if (uri === undefined) throw new SyntaxError(`prefix ${step.slice(0, colon)} not found in prefix map`);
  return `{${uri}}${step.slice(colon + 1)}`;
}

function collect(element: XmlElement, into: XmlElement[]): void {
  for (const child of element.children) { into.push(child); collect(child, into); }
}

/** `Element.findall(path, ns)` for child steps and a leading `.//`. */
export function findall(element: XmlElement, path: string, ns: Namespaces): XmlElement[] {
  const deep = path.startsWith(".//");
  const steps = (deep ? path.slice(3) : path).split("/");
  let current: XmlElement[] = [element];
  steps.forEach((step, index) => {
    const tag = qualify(step, ns), next: XmlElement[] = [];
    for (const node of current) {
      let pool = node.children;
      if (index === 0 && deep) { pool = []; collect(node, pool); }
      for (const child of pool) if (child.tag === tag) next.push(child);
    }
    current = next;
  });
  return current;
}

export function find(element: XmlElement, path: string, ns: Namespaces): XmlElement | null {
  return findall(element, path, ns)[0] ?? null;
}

/** `''.join(t.text or '' for t in element.findall(path))`. */
export function joinedText(element: XmlElement, path: string, ns: Namespaces): string {
  return findall(element, path, ns).map((node) => node.text ?? "").join("");
}

export function escapeXml(text: string, attribute = false): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return attribute ? escaped.replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\t/g, "&#09;") : escaped;
}
