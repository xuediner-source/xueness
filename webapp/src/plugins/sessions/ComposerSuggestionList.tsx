import { t as tr } from '../../i18n';
import type { ContextComposerSuggestion } from './composerInputHelpers';

export function ComposerSuggestionList({ suggestions, suggestionListId, currentSuggestion, acceptSuggestion, setActiveSuggestion }: {
  suggestions: ContextComposerSuggestion[];
  suggestionListId: string;
  currentSuggestion: number;
  acceptSuggestion: (suggestion: ContextComposerSuggestion) => void;
  setActiveSuggestion: (index: number) => void;
}) {
  return (
        <ul id={suggestionListId} role="listbox" className="xn-composer__suggest" aria-label={tr("输入建议")} data-testid="composer-suggestions">
          {suggestions.map((s, index) => (
            <li key={`${s.kind}-${s.token}`}>
              <button
                type="button"
                className={`xn-composer__suggest-item ${index === currentSuggestion ? "xn-composer__suggest-item--active" : ""}`}
                data-testid={`composer-suggestion-${s.kind}-${s.token}`}
                aria-selected={index === currentSuggestion ? "true" : undefined}
                id={`${suggestionListId}-option-${index}`}
                role="option"
                onClick={() => {
                  acceptSuggestion(s);
                  setActiveSuggestion(0);
                }}
              >
                <code>{(s.kind === "command" || s.kind === "goal" || s.kind === "workflow" ? "/" : s.kind === "skill" ? "$" : "@") + (s.label ?? s.token)}</code>
                {s.description && <span>{s.description}</span>}
              </button>
            </li>
          ))}
        </ul>
  );
}
