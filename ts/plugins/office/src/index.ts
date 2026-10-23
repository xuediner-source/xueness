/**
 * Office documents without a Python sidecar: bounded DOCX/PPTX/XLSX/PDF
 * reading, structured creation and proof-gated replacement, plus the
 * delivery content extractor the planning plugin checks Office outputs with.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { officeTools, type OfficeToolsOptions } from "./tools.ts";

export { deliveryContentText, buildDocument, readDocument, safeZip } from "./read.ts";
export { previewBytes } from "./preview.ts";
export { documentObject, FORMATS, type OfficeFormat } from "./document.ts";
export { officeTools, officeTarget, type OfficeToolsOptions } from "./tools.ts";
export { formatG16 } from "./write-xlsx.ts";

export function createOffice(options: OfficeToolsOptions): BundledPlugin {
  return { manifest, plugin: definePlugin({ name: "office", apply(ctx) { for (const tool of officeTools(options)) ctx.tool(tool); } }) };
}
export const office = createOffice({ session: () => null });
export const officePlugin = office.plugin;
