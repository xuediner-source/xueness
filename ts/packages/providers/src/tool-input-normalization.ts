import { pyEncodeUtf8, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";

/** Serialize finite JSON using the same Unicode and number checks as the provider protocol. */
function finiteJsonText(value: unknown): string {
  const text = pyJsonDumps(value, { allowNan: false });
  pyEncodeUtf8(text);
  return text;
}

/** Normalize model arguments without turning malformed input into an executable empty object. */
export function normalizeModelToolArguments(input: unknown): string {
  if (input === undefined || input === null || input === "") return "{}";
  if (typeof input !== "string") return finiteJsonText(input);
  const source = input.startsWith("\ufeff") ? input.slice(1) : input;
  let value: unknown;
  try {
    value = pyJsonLoads(source, { rejectDuplicates: true, rejectNonFinite: true });
  } catch {
    return input;
  }
  return value === null ? "{}" : finiteJsonText(value);
}
