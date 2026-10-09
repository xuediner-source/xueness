import React, { useCallback, useEffect, useRef, useState } from "react";
import type { RunChoices } from "../../xuenessBridge";
import type { PermissionMode } from "./permissionModes";
import { FullAccessConfirmationDialog } from "./FullAccessConfirmationDialog";

/** A saved session's permission is not a confirmation for a different session. */
export function submissionNeedsFullAccessConfirmation(choices: RunChoices, savedMode?: PermissionMode): boolean {
  return choices.permission_mode === "yolo" && savedMode !== "yolo" && choices.acknowledge_yolo !== true;
}

type Pending = {
  scope: string;
  choices: RunChoices;
  resolve(value: RunChoices | null): void;
};

/** Confirm before accepting a message, not after creating an unusable task. */
export function useRunPermissionConfirmation(scope: string, enabled: boolean) {
  const pendingRef = useRef<Pending | null>(null);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    if (!pending) return;
    pending.resolve(confirmed && enabledRef.current && pending.scope === currentScope.current
      ? { ...pending.choices, acknowledge_yolo: true }
      : null);
  }, []);

  useEffect(() => {
    if (pendingRef.current && (!enabled || pendingRef.current.scope !== scope)) settle(false);
  }, [enabled, scope, settle]);
  useEffect(() => () => {
    pendingRef.current?.resolve(null);
    pendingRef.current = null;
  }, []);

  const ensure = useCallback((choices: RunChoices, savedMode?: PermissionMode): Promise<RunChoices | null> => {
    if (!enabledRef.current || pendingRef.current) return Promise.resolve(null);
    if (!submissionNeedsFullAccessConfirmation(choices, savedMode)) return Promise.resolve({ ...choices });
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise(resolve => {
      pendingRef.current = { scope: currentScope.current, choices: { ...choices }, resolve };
      setOpen(true);
    });
  }, []);

  return {
    ensure,
    dialog: <FullAccessConfirmationDialog open={open} returnFocusTo={opener.current}
      onCancel={() => settle(false)} onConfirm={() => settle(true)} />,
  };
}
