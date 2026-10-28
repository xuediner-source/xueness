import React from "react";
import { tf } from "../../i18n";

// Loaded with this chunk, so the startup catalog does not carry the phrase.

/** Plain step count from the parent snapshot. There is no work-item list here. */
export function SubagentStepProgress({ steps }: { steps: number }): React.JSX.Element {
  return <span className="xn-zc-subagent__steps" data-testid="subagent-row-steps">{tf("已进行 {0} 步", [steps])}</span>;
}
