/**
 * ZCode v3.15.1 (aac4755, Apache-2.0) ApplyPatch model contract
 * (`packages/contracts/src/tools/apply-patch.ts`). The tool itself is
 * `apply_patch` in @xueness/engine-tools; it already carries ZCode's text and schema.
 */
import type { JsonSchema } from "@xueness/contracts";
import { applyPatchTool } from "@xueness/engine-tools";

export const APPLY_PATCH_DESCRIPTION: string = applyPatchTool.description;
export const APPLY_PATCH_SCHEMA = applyPatchTool.inputSchema as unknown as JsonSchema;
