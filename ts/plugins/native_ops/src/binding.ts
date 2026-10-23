import { NATIVE_OPS_DEFAULT_SELECTED, NATIVE_OPS_TOOL_NAMES, type NativeOpsBinding } from "./types.ts";

const DEFAULT_OWNER = "__default__";
const ownerKey = (owner?: string): string => owner && owner.length <= 256 ? owner : "session";

export function createNativeOpsBinding(): NativeOpsBinding {
  const selected = new Map<string, Set<string>>([[DEFAULT_OWNER, new Set(NATIVE_OPS_DEFAULT_SELECTED)]]);
  const binding: NativeOpsBinding = {
    selected,
    selectedFor(owner) {
      const key = owner ? ownerKey(owner) : DEFAULT_OWNER;
      let names = selected.get(key);
      if (!names) {
        names = new Set(selected.get(DEFAULT_OWNER) ?? NATIVE_OPS_DEFAULT_SELECTED);
        selected.set(key, names);
      }
      return names;
    },
    select(owner, names) {
      const current = binding.selectedFor(owner);
      for (const name of names) current.add(name);
      return [...current].filter((name) => NATIVE_OPS_TOOL_NAMES.includes(name));
    },
  };
  return binding;
}
