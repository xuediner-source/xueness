/**
 * Argv read-only policy, adapted from ZCode v3.15.1
 * apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-types.ts
 */
export type SafeFlagValue = "{}" | "EOF" | "char" | "none" | "number" | "optionalString" | "string";

/** One simple command, the slice of a shell line the argv policy can judge. */
export interface ReadonlyCommandPart {
  readonly argv: readonly string[];
  readonly commandText: string;
  readonly envAssignments: readonly { readonly name: string | undefined; readonly value: string | undefined }[];
  readonly redirects: readonly { readonly operator: string; readonly target: string }[];
}

export interface BashReadonlyCommandPolicy {
  additionalCommandIsDangerousCallback?: (
    commandText: string,
    argsAfterPrefix: readonly string[],
  ) => boolean;
  allowAnyArgs?: boolean;
  allowCompactNumericCountFlag?: boolean;
  commandOnly?: boolean;
  regex?: RegExp;
  respectsDoubleDash?: boolean;
  safeFlags?: Readonly<Record<string, SafeFlagValue>>;
}
