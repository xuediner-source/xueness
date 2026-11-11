/**
 * Recognising a published DeepSeek Harness plugin.
 *
 * Plugins in the DSH ecosystem (GitHub topic `dsh-plugin`) are code: an npm
 * package whose `package.json` carries a `dsh` block. `dsh.bundle.patch`
 * points at a `cordis.patch.yml` that mounts the package's main entry into
 * the DSH host as a Cordis plugin, `dsh.client` loads a browser half into the
 * DSH web app, and `dsh.profile.bundles` composes several such packages. They
 * call DSH runtime services (`@deepseek-ai/dsh-*`, Cordis) that exist only
 * inside a DSH host.
 *
 * Xueness loads plugin code only from its build allowlist and has no Cordis
 * host, so such a package cannot run here. This module reads the manifest as
 * data and describes it, so the import surface can say exactly that instead
 * of "unknown package". Nothing from the package is loaded or executed.
 */
type Row = Record<string, unknown>;
const isObject = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const line = (value: unknown, max: number): string => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "";
const MAX_SERVICES = 60;

export interface CordisPlugin {
  id: string; name: string; version: string; description: string; author: string; license: string;
  kind: "bundle" | "profile";
  /** DSH runtime packages the plugin needs from its host. */
  services: string[];
  /** Packages a profile composes. */
  bundles: string[];
  hasClient: boolean;
}

/** The `dsh` block of a `package.json`, when it declares a host bundle, a browser half or a profile. */
export function cordisPlugin(document: unknown): CordisPlugin | null {
  if (!isObject(document) || !isObject(document.dsh)) return null;
  const dsh = document.dsh;
  const profile = isObject(dsh.profile) && Array.isArray(dsh.profile.bundles);
  if (!isObject(dsh.bundle) && !isObject(dsh.client) && !profile) return null;
  const name = line(document.name, 120);
  const inject = isObject(dsh.client) && Array.isArray(dsh.client.inject) ? dsh.client.inject : [];
  const peers = isObject(document.peerDependencies) ? Object.keys(document.peerDependencies) : [];
  const host = (pkg: unknown): pkg is string => typeof pkg === "string" && (/^@deepseek-ai\//.test(pkg) || /^(@[\w-]+\/)?cordis$/.test(pkg) || /^dsh-/.test(pkg));
  const author = isObject(document.author) ? document.author.name : document.author;
  return {
    id: name.replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "dsh-plugin",
    name: name || "DSH plugin", version: line(document.version, 40), description: line(document.description, 400), author: line(author, 80), license: line(document.license, 60),
    kind: profile ? "profile" : "bundle",
    services: [...new Set([...inject, ...peers].filter(host).map(pkg => line(pkg, 100)))].sort().slice(0, MAX_SERVICES),
    bundles: profile ? (dsh.profile as Row & { bundles: unknown[] }).bundles.map(item => line(item, 100)).filter(Boolean).slice(0, MAX_SERVICES) : [],
    hasClient: isObject(dsh.client),
  };
}

/** A preview that shows what the package is and why it stays unimported. */
export function cordisPluginPreview(plugin: CordisPlugin): Row {
  return {
    id: plugin.id, version: plugin.version, name: plugin.name, description: plugin.description, author: plugin.author,
    facts: [{ label: "清单", value: "package.json" }, { label: "类型", value: plugin.kind === "profile" ? "DSH profile" : "DSH Cordis bundle" }, ...(plugin.license ? [{ label: "许可", value: plugin.license }] : [])],
    counts: [{ label: "所需 DSH 运行时服务", count: plugin.services.length }, ...(plugin.kind === "profile" ? [{ label: "组合的插件", count: plugin.bundles.length }] : [])],
    sections: [
      ...(plugin.services.length ? [{ title: "所需 DSH 运行时服务", rows: plugin.services.map(name => ({ name })) }] : []),
      ...(plugin.bundles.length ? [{ title: "组合的插件", rows: plugin.bundles.map(name => ({ name })) }] : []),
    ],
    replaces: null, missing: [], blocked: true,
    notes: [
      { tone: "danger", text: "这是 DeepSeek Harness 的代码插件：它的代码要在 DSH 的 Cordis 宿主里运行，并调用上面列出的 DSH 运行时服务。Xueness 只从构建时确定的清单加载插件代码，也没有 Cordis 宿主，所以不能导入或运行它。" },
      { tone: "warn", text: "包里的技能文件夹（含 SKILL.md）是纯文本，可以单独选择该文件夹，按「技能文件夹」导入。" },
    ],
  };
}
