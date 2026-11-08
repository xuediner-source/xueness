/**
 * providers.default_selection in the composer's model menu: "set as default"
 * forwards the current selection to the existing backend route (validation and
 * storage stay on the server), and "edit" opens provider settings focused on
 * that saved profile. Moved unchanged out of XuenessWorkbenchContainer.
 */
import { useCallback, useEffect, useState } from "react";
import { saveDefaultModelSelection } from "../../xuenessApi";
import type { RunChoices } from "../../xuenessBridge";
import type { ComposerModel } from "../../xuenessComposer";
import type { WorkbenchPanel } from "../../xuenessPluginRegistry";

type DefaultModelSelectionInput = {
  choices: RunChoices;
  isPluginEffective: (id: string) => boolean;
  setPanel: (panel: WorkbenchPanel) => void;
  setError: (message: string) => void;
};

export function useDefaultModelSelection({ choices, isPluginEffective, setPanel, setError }: DefaultModelSelectionInput) {
  // 「设为默认」属于 providers.default_selection：容器只在插件生效时把菜单里的
  // 当前选择转发到既有后端接口，校验与存储都在服务端完成。
  const [defaultSaved, setDefaultSaved] = useState(false);
  // Edit on a model row opens provider settings focused on that saved profile.
  const [providerFocusId, setProviderFocusId] = useState<string | undefined>(undefined);
  const openModelSettings = useCallback((model?: ComposerModel) => {
    setProviderFocusId(model?.id || undefined);
    setPanel(isPluginEffective("providers") ? "providers" : "plugins");
  }, [isPluginEffective]);
  const saveDefaultModel = useCallback(async (model: ComposerModel) => {
    if (!isPluginEffective("providers")) return;
    try {
      const saved = await saveDefaultModelSelection({
        providerId: model.id || null,
        model: choices.model || model.model || null,
        reasoningEffort: choices.reasoning_effort ?? null,
      });
      setDefaultSaved(saved !== null);
    } catch (reason) {
      setDefaultSaved(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [choices.model, choices.reasoning_effort, isPluginEffective]);
  useEffect(() => setDefaultSaved(false), [choices.provider_id, choices.model, choices.reasoning_effort]);
  return { defaultSaved, providerFocusId, openModelSettings, saveDefaultModel };
}
