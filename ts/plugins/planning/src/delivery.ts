/** Immutable delivery requirements and checks of actual bounded file content. */
import { extname, isAbsolute, relative, resolve } from "node:path";
import { isDict, isPyIntValue, pyEquals, pyLen, pyStr, pyStrip, pyTruthy, PyValueError } from "@xueness/contracts";
import { readRegularBeneath } from "@xueness/sessions";
import { explicitOutputPaths } from "./delivery-intent.ts";
export { explicitOutputPaths, requestsFileOutput } from "./delivery-intent.ts";
export type Row = Record<string, unknown>;
export const MAX_DELIVERY_ITEMS = 40, MAX_DELIVERY_BYTES = 2_000_000;
export const OFFICE_SUFFIXES = new Set([".docx", ".pptx", ".xlsx", ".pdf"]);
export interface DeliveryRequirement extends Row { id: string; label: string; path: string | null; contains: string[]; min_links: number }
export function normalizeDelivery(items: unknown): DeliveryRequirement[] {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_DELIVERY_ITEMS) throw new PyValueError("delivery requirements must contain 1..40 items");
  const out: DeliveryRequirement[] = [], ids = new Set<string>();
  for (const item of items) {
    if (!isDict(item)) throw new PyValueError("invalid delivery requirement");
    const { id, label } = item, path = item.path ?? null, markers = Object.hasOwn(item, "contains") ? item.contains : [], links = Object.hasOwn(item, "min_links") ? item.min_links : 0;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new PyValueError("invalid or duplicate delivery id");
    if (typeof label !== "string" || !pyStrip(label) || pyLen(label) > 500) throw new PyValueError("invalid delivery label");
    if (path !== null && (typeof path !== "string" || !pyStrip(path) || pyLen(path) > 4096)) throw new PyValueError("invalid delivery path");
    if (!Array.isArray(markers) || markers.length > 100 || markers.some((s) => typeof s !== "string" || !pyStrip(s) || pyLen(s) > 300)) throw new PyValueError("invalid delivery markers");
    if (!isPyIntValue(links) || Number(links) < 0 || Number(links) > 100) throw new PyValueError("invalid minimum source links");
    if (path === null && !markers.length && !Number(links)) throw new PyValueError("delivery must specify a path, at least one required content marker, or min_links >= 1");
    ids.add(id); out.push({ id, label: pyStrip(label), path, contains: (markers as string[]).map(pyStrip), min_links: Number(links) });
  }
  return out;
}
export function seedDelivery(session: Row): void {
  if (pyTruthy(session.delivery_seeded)) return;
  session.delivery_seeded = true;
  const task = Object.hasOwn(session, "task") ? session.task : "";
  if (typeof task !== "string") return;
  const paths = explicitOutputPaths(task);
  if (!Object.hasOwn(session, "delivery_requirements")) session.delivery_requirements = [];
  const current = session.delivery_requirements;
  if (!Array.isArray(current)) return;
  const ids = new Set(current.filter(isDict).map((item) => item.id).filter((id) => typeof id === "string")); let next = 1;
  for (const path of paths) {
    if (current.length >= MAX_DELIVERY_ITEMS) break;
    if (current.some((item) => isDict(item) && item.path === path)) continue;
    while (ids.has(`output_${next}`)) next++;
    const id = `output_${next++}`; ids.add(id);
    current.push({ id, label: "目标文件：" + path, path, contains: [], min_links: 0 });
  }
}
export function planDelivery(session: Row | null, items: unknown): DeliveryRequirement[] {
  if (!session) throw new PyValueError("delivery plan needs a session");
  const incoming = normalizeDelivery(items), current = new Map((pyTruthy(session.delivery_requirements) ? normalizeDelivery(session.delivery_requirements) : []).map((item) => [item.id, item]));
  for (const item of incoming) { const old = current.get(item.id); if (old && !pyEquals(old, item)) throw new PyValueError("existing delivery requirement cannot be rewritten by the model"); current.set(item.id, item); }
  if (current.size > MAX_DELIVERY_ITEMS) throw new PyValueError("too many delivery requirements");
  session.delivery_requirements = [...current.values()]; return session.delivery_requirements as DeliveryRequirement[];
}
function hasHostname(candidate: string): boolean {
  const authority = candidate.replace(/^https?:\/\//, "").split(/[/?#]/, 1)[0]!;
  const at = authority.lastIndexOf("@");
  if (at > 0 && authority.slice(0, at) !== ":") return false;
  const host = authority.slice(at + 1);
  if (host.startsWith("[")) {
    const end = host.indexOf("]"), ip = host.slice(1, end);
    if (end < 0) return false;
    if (/^v[0-9a-f]+\..+/i.test(ip)) return true;
    try { return new URL(`http://[${ip}]/`).hostname.startsWith("["); } catch { return false; }
  }
  return !!host.split(":", 1)[0] && !/[\[\]]/.test(host);
}
export function deliveryLinkCount(text: string): number {
  return new Set([...text.matchAll(/https?:\/\/[^\s<>\[\]）)]+/g)].map((match) => match[0]).filter((candidate) => hasHostname(candidate.replace(/[.,;，。]+$/, "")))).size;
}
export interface DeliveryCheckOptions {
  enabled(id: string): boolean;
  canRead(path: string): boolean | Promise<boolean>;
  /** Supplied only by the enabled Office plugin; no parser may bypass its state. */
  officeText?: (raw: Buffer, suffix: string) => string | Promise<string>;
}
export async function checkDelivery(root: string, session: Row, summary: string, options: DeliveryCheckOptions): Promise<Row> {
  const raw = session.delivery_requirements;
  if (!pyTruthy(raw)) return { status: "not_assessed", items: [], reason: "未登记交付清单，尚未检查任务内容是否齐全。" };
  let requirements: DeliveryRequirement[];
  try { requirements = normalizeDelivery(raw); } catch { return { status: "failed", items: [], reason: "交付清单无效，请由用户修正。" }; }
  const checked: Row[] = [];
  for (const item of requirements) {
    let text = summary || ""; const missing: string[] = [];
    if (item.path !== null) {
      try {
        const suffix = extname(item.path).toLowerCase(), office = OFFICE_SUFFIXES.has(suffix);
        if (!options.enabled("files") || office && (!options.enabled("office") || !options.officeText)) throw new Error("plugin disabled or unavailable");
        if (!await options.canRead(item.path) || !options.enabled("planning") || !options.enabled("files") || office && !options.enabled("office")) throw new Error("read refused");
        const path = relative(resolve(root), resolve(root, item.path));
        if (!path || isAbsolute(path) || path === ".." || path.startsWith("../") || path.startsWith("..\\")) throw new Error("path outside workspace");
        const read = readRegularBeneath(root, process.platform === "win32" ? path.replace(/\\/g, "/") : path, MAX_DELIVERY_BYTES + 1);
        if (!read || read.size > MAX_DELIVERY_BYTES || read.raw.length > MAX_DELIVERY_BYTES) throw new Error("unreadable delivery file");
        text = office ? await options.officeText!(read.raw, suffix) : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.raw);
      } catch { missing.push("文件不存在、不可读取、插件已禁用、内容被截断或不支持文本检查"); text = ""; }
      if (!missing.length && /\.json$/i.test(item.path)) {
        try { JSON.parse(text.replace(/^\ufeff/, "")); } catch { missing.push("JSON 文件语法无效或内容为空"); }
      }
      if (!missing.length && !pyStrip(text.replace(/^\ufeff+/, "")) && /报告|资料|research|report/i.test(pyStr(session.task ?? "") + " " + item.label)) missing.push("报告文件为空");
    }
    for (const marker of item.contains) if (!text.includes(marker)) missing.push("缺少内容：" + marker);
    const count = deliveryLinkCount(text); if (count < item.min_links) missing.push(`来源链接不足：${count}/${item.min_links}`);
    checked.push({ ...item, passed: !missing.length, missing, link_count: count });
  }
  return { status: checked.every((item) => item.passed) ? "passed" : "failed", items: checked, scope: "文件存在、JSON语法、文本必需条目和链接数量；不证明完整程序行为、来源真实性或链接可达。" };
}
