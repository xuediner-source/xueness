import type { WorkbenchSession } from '../../xuenessWorkbench';
import type { ComposerModel } from '../../xuenessComposer';
import type { RunChoices } from '../../xuenessBridge';
import { contextUsageReading } from './ContextUsageRing';

/** The old request's count must not be paired with a newly selected model. */
export function sessionContextUsage(session: WorkbenchSession | null | undefined, model: ComposerModel | undefined, choices: RunChoices) {
  if (!session) return null;
  const selection = session.model_selection;
  if (!selection || (selection.provider_id ?? '') !== (choices.provider_id ?? '') ||
      selection.model !== (choices.model ?? model?.model)) return null;
  return contextUsageReading({
    reportedInputTokens: session.runtime_activity?.reportedInputTokens,
    estimatedInputTokens: session.runtime_budget?.estimatedInputTokens,
    contextWindow: session.runtime_budget?.contextWindow ?? model?.contextWindow,
    inputBudgetTokens: session.runtime_budget?.inputBudgetTokens,
  });
}
