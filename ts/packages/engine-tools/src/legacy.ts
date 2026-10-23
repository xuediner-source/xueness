/**
 * Argument names from the Python tools, accepted while both backends run.
 * Python `edit` used `old`/`new`; grep's `include` is accepted natively.
 * Python `read` paged by characters and is not mapped: its pages differ.
 */
export function normalizeLegacyArgs(name: string, args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  if (name === "edit" && !("old_string" in record) && ("old" in record || "new" in record)) {
    const { old, new: replacement, ...rest } = record;
    return { ...rest, old_string: old, new_string: replacement };
  }
  return args;
}
