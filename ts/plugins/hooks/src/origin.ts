/** Private provenance carried from discovery to the final process dispatch. */
export const WORKSPACE_HOOK_ORIGIN: unique symbol = Symbol("workspace-hook-origin");
export interface WorkspaceHookOrigin { workspace: string; digest: string; path: string }
