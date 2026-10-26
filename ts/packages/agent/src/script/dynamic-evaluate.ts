import type { CompiledDynamicWorkflow, DynamicEvaluationOptions, DynamicScriptHost } from "./dynamic-types.ts";
import { createContext } from "./dynamic-evaluate-internal.ts";
import { evaluateProgram } from "./dynamic-evaluate-statement.ts";

/** Runs the compiler's restricted TypeScript AST using only explicit host ports. */
export async function evaluateDynamicWorkflow(
  compiled: CompiledDynamicWorkflow,
  host: DynamicScriptHost,
  options: DynamicEvaluationOptions = {},
): Promise<unknown> {
  const context = createContext(compiled, host, options);
  try {
    const result = await evaluateProgram(context);
    // Async callbacks can create further host tasks while an earlier batch settles.
    let observed = 0;
    while (observed < context.pending.length) {
      const batch = context.pending.slice(observed);
      observed = context.pending.length;
      const outcomes = await Promise.allSettled(batch);
      const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      if (failed) throw failed.reason;
    }
    return result;
  } finally {
    if (options.usage) options.usage.operations = context.operations;
  }
}
