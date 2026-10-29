/** Independent receipts are tied to the actual file bytes, never model claims. */
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { isDict } from "@xueness/contracts";
import { readRegularBeneath } from "@xueness/sessions";
import { seedDelivery, MAX_DELIVERY_BYTES, type Row } from "./delivery.ts";

export function importContract(session: Row): { paths: string[]; silent: boolean } {
  const task = String(session.task ?? "");
  const required = /\bimportable\b|可导入|模块导出|\bexport\s+(?:function|const|async)|\bimport\b[^\n]{0,80}(?:silent|no output|不产生输出|无输出)|silent[^\n]{0,30}\bimport\b/i.test(task);
  const silent = /\bimport\b[^\n]{0,80}(?:silent|no output|不产生输出|无输出)|silent[^\n]{0,30}\bimport\b/i.test(task);
  seedDelivery(session);
  const paths = (Array.isArray(session.delivery_requirements) ? session.delivery_requirements : []).filter(isDict).map(item => item.path)
    .filter((path): path is string => required && typeof path === "string" && /\.[cm]js$/i.test(path) && !/(?:^|[\\/])(?:tests?|__tests__)[\\/]|\.(?:test|spec)\.[cm]js$/i.test(path));
  return { paths: [...new Set(paths)], silent };
}

export function deliveryFingerprint(root: string, path: string): string | null {
  const rel = relative(resolve(root), resolve(root, path));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) return null;
  const read = readRegularBeneath(root, process.platform === "win32" ? rel.replaceAll("\\", "/") : rel, MAX_DELIVERY_BYTES + 1);
  return read && read.size <= MAX_DELIVERY_BYTES ? createHash("sha256").update(read.raw).digest("hex") : null;
}

export function importChecks(root: string, session: Row): Row {
  const { paths, silent } = importContract(session);
  if (!paths.length) return { status: "not_assessed", items: [], scope: "No explicit Node module import contract" };
  const stored = isDict(session.delivery_verification) ? session.delivery_verification : {};
  const prior = stored.codeVersion === Number(session.delivery_code_version ?? 0) && Array.isArray(stored.items) ? stored.items.filter(isDict) : [];
  const items = paths.map(path => {
    const sha256 = deliveryFingerprint(root, path);
    const receipt = prior.find(item => item.path === path && item.sha256 === sha256 && item.silent === silent);
    return receipt && sha256 ? { ...receipt } : { path, passed: false, assessed: false, reason: sha256 ? "Current file version has not passed independent import verification" : "Module file is missing or unreadable" };
  });
  return { status: items.every(item => item.passed === true) ? "passed" : "failed", items, scope: "Real .mjs consumer import, return-to-caller and requested silence; not full program behavior" };
}
