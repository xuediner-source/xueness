/**
 * The DSH package type for the host's general package import surface.
 *
 * Xueness imports several package formats through one registry owned by the
 * extensions plugin; this adapter is the entry for DeepSeek Harness plugins.
 * A published DSH plugin is Cordis code and is recognised and declined with
 * the reason (`cordis-plugin.ts`). The declarative harness manifest
 * (`deepseek-harness.json`, or a `package.json` with an `xuenessHarness`
 * block) was a Xueness format that no DSH plugin uses; it is retired, so a
 * manifest in it is shown and refused with a pointer to the native format,
 * while packages imported earlier stay listed, usable and removable. The
 * shape matches the registry's importer contract structurally; this plugin
 * does not depend on the plugin that owns the registry.
 */
import { cordisPlugin, cordisPluginPreview, type CordisPlugin } from "./cordis-plugin.ts";
import { MAX_MANIFEST_BYTES } from "./loader.ts";
import { listLibrary, packageTexts, previewImport, removePackage } from "./library.ts";

type Row = Record<string, unknown>;
const isObject = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(isObject) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** A DSH manifest carries `sdkApiVersion`; a `package.json` carries an `xuenessHarness` block. */
function looksLikeHarness(body: Row): boolean {
  const manifest = body.manifest;
  if (typeof manifest !== "string" || Buffer.byteLength(manifest, "utf8") > MAX_MANIFEST_BYTES) return false;
  try {
    const document = JSON.parse(manifest.replace(/^﻿/, "")) as unknown;
    return isObject(document) && (document.sdkApiVersion !== undefined || isObject(document.xuenessHarness));
  } catch { return false; }
}

const CHECK_LABELS: Record<string, string> = { sdk_supported: "SDK 版本兼容", source_present: "本地副本完整", manifest_current: "清单未变化", contributions_resolved: "技能文件齐全", mounted: "已挂载" };
const NEVER_RUN = { text: "不会执行" };

/** Contributions (a library row or a parsed manifest) as counts and sections; `missing` marks absent skill files. */
function contributions(source: Row, missing: readonly string[] = []) {
  const tools = rows(source.tools), hooks = rows(source.hooks), verifiers = rows(source.verifiers), skills = rows(source.skills), templates = rows(source.promptTemplates);
  const sections = [
    { title: "工具声明", rows: tools.map(tool => ({ name: text(tool.name), note: text(tool.description),
      chips: [{ text: text(tool.gate) }, ...(tool.mutating === true ? [{ text: "会修改", tone: "warn" as const }] : [])] })) },
    { title: "钩子声明", rows: hooks.map(hook => ({ name: `${text(hook.event)} → ${text(hook.handler)}`, chips: [NEVER_RUN] })) },
    { title: "校验命令", rows: verifiers.map(verifier => ({ name: text(verifier.name), body: text(verifier.command), chips: [NEVER_RUN] })) },
    { title: "技能", rows: skills.map(skill => {
      const path = text(skill.path);
      const absent = !!path && (skill.present === false || missing.includes(path));
      return { name: text(skill.id), note: path, ...(absent ? { chips: [{ text: "缺少文件", tone: "warn" as const }] } : {}) };
    }) },
    { title: "提示模板", rows: templates.map(template => ({ name: text(template.id), note: text(template.preview ?? template.template).slice(0, 240) })) },
  ];
  return {
    counts: [["工具", tools], ["钩子", hooks], ["校验命令", verifiers], ["技能", skills], ["提示模板", templates]].map(([label, list]) => ({ label: label as string, count: (list as Row[]).length })),
    sections: sections.filter(section => section.rows.length),
  };
}

const sourceFact = (kind: unknown) => [{ label: "清单", value: kind === "package" ? "package.json" : "deepseek-harness.json" }];

function itemView(item: Row, report?: Row): Row {
  const checks = rows(report?.checks).map(check => ({ label: CHECK_LABELS[text(check.name)] ?? text(check.name), ok: check.ok === true, detail: text(check.detail) }));
  return { id: item.id, version: item.version, name: text(item.name) || item.id, description: text(item.description), author: text(item.author),
    facts: sourceFact(item.kind), ...contributions(item), status: report?.status === "degraded" ? "attention" : "ok", checks,
    importedAt: text(item.importedAt), fileName: text(item.fileName) };
}

const RETIRED = "the declarative harness format (deepseek-harness.json or a package.json xuenessHarness block) is retired: no DeepSeek Harness plugin uses it. Use a Xueness package (xueness-plugin.json) or import the skill folders";
const RETIRED_NOTE = { tone: "danger", text: "这种声明式清单（deepseek-harness.json，或 package.json 里的 xuenessHarness 块）是 Xueness 早先自定的格式，DeepSeek Harness 插件并不使用，已停止导入。技能和提示模板请写成 Xueness 扩展包（xueness-plugin.json），带文件的技能请按「技能文件夹」导入。已经导入的包仍可启用和移除。" };

function publishedPlugin(body: Row): CordisPlugin | null {
  const manifest = body.manifest;
  if (typeof manifest !== "string" || Buffer.byteLength(manifest, "utf8") > MAX_MANIFEST_BYTES) return null;
  try { return cordisPlugin(JSON.parse(manifest.replace(/^﻿/, ""))); } catch { return null; }
}

export function harnessImporter(options: { stateDir: string }) {
  return {
    type: "dsh", owner: "deepseek_harness", name: "DeepSeek Harness 插件", nameEn: "DeepSeek Harness plugin",
    manifestNames: ["package.json", "deepseek-harness.json"],
    detect: (body: Row): boolean => looksLikeHarness(body) || publishedPlugin(body) !== null,
    list(): Row[] {
      const library = listLibrary(options.stateDir);
      const reports = new Map(rows(isObject(library.report) ? library.report.items : []).map(report => [report.id, report]));
      return rows(library.items).map(item => itemView(item, reports.get(item.id)));
    },
    preview(body: Row): Row {
      // A published DSH plugin is code for a DSH host: describe it and leave it unimported.
      const published = looksLikeHarness(body) ? null : publishedPlugin(body);
      if (published) return { ok: true, preview: cordisPluginPreview(published) };
      // A retired declarative manifest: show what it holds and why it is not imported.
      const result = previewImport(options.stateDir, body) as Row;
      if (result.ok !== true || !isObject(result.preview)) return { ok: false, error: { code: "format_retired", message: RETIRED } };
      const preview = result.preview;
      const info = isObject(preview.info) ? preview.info : {};
      const missing = Array.isArray(preview.missing) ? preview.missing.map(String) : [];
      return { ok: true, preview: { id: preview.id, version: preview.version, name: text(info.name) || preview.id, description: text(info.description), author: text(info.author),
        facts: sourceFact(preview.kind), ...contributions(isObject(preview.manifest) ? preview.manifest : {}, missing),
        replaces: null, missing, blocked: true, notes: [RETIRED_NOTE] } };
    },
    install(body: Row): Row {
      if (!looksLikeHarness(body) && publishedPlugin(body)) {
        return { ok: false, error: { code: "code_package", message: "a published DeepSeek Harness plugin is code for a DSH Cordis host and cannot be imported or run here" } };
      }
      return { ok: false, error: { code: "format_retired", message: RETIRED } };
    },
    remove: (id: unknown): Row => removePackage(options.stateDir, id),
    /** Skills and prompt templates are text the host may activate; tools, hooks and verifier commands name behaviour and are never offered. */
    contributions(id: string) {
      const texts = packageTexts(options.stateDir, id);
      if (!texts) return [];
      return [
        ...texts.skills.map((skill) => ({ kind: "skills" as const, id: skill.id, name: `${id}:${skill.id}`, description: `Skill from the imported package ${id}`, body: skill.text })),
        ...texts.promptTemplates.map((template) => ({ kind: "commands" as const, id: template.id, name: `${id}.${template.id}`, description: `Prompt template from the imported package ${id}`, body: template.text })),
      ];
    },
    version: (id: string): string => packageTexts(options.stateDir, id)?.version ?? "",
  };
}
