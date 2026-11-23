import React from "react";
import { t as tr } from '../../i18n';
import { IconPaperclip } from "../../ui/icons";
import type { ComposerCapability } from "../../xuenessComposer";
import { Search, Target, Workflow, Blocks } from 'lucide-react';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
import { ComposerCapabilityMenu } from './ComposerCapabilityMenu';
import type { ComposerMention, ComposerStartActions } from './composerInputHelpers';
import type { ComposerDraftState } from './composerTypes';

export function ComposerPlusMenu({
  plusRef, plusButtonRef, menuRef, plusMenuId, plusOpen, setPlusOpen, disabled, attachmentsEnabled, legacyAttachmentBusy,
  openAttachmentPicker, handlePlusMenuKeyDown, closePlusMenu, addSearch, setAddSearch, canOfferGoal, canOfferWorkflow,
  goal, startActions, setGoal, localInputRef, visibleCapabilities, selectedCapabilities, toggleCapability, visibleMentions,
  selectedContext, toggleContext, availableMentions,
}: {
  plusRef: React.MutableRefObject<HTMLDivElement | null>;
  plusButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
  menuRef: React.MutableRefObject<HTMLDivElement | null>;
  plusMenuId: string;
  plusOpen: boolean;
  setPlusOpen: (value: boolean | ((open: boolean) => boolean)) => void;
  disabled: boolean;
  attachmentsEnabled: boolean;
  legacyAttachmentBusy: boolean;
  openAttachmentPicker: () => void;
  handlePlusMenuKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  closePlusMenu: (restoreFocus?: boolean) => void;
  addSearch: string;
  setAddSearch: (value: string) => void;
  canOfferGoal: boolean;
  canOfferWorkflow: boolean;
  goal: boolean;
  startActions?: ComposerStartActions;
  setGoal: (value: boolean | ((previous: boolean) => boolean)) => unknown;
  localInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  visibleCapabilities: ComposerCapability[];
  selectedCapabilities: string[];
  toggleCapability: (item: ComposerCapability) => void;
  visibleMentions: ComposerMention[];
  selectedContext: ComposerDraftState['selectedContext'];
  toggleContext: (mention: ComposerMention) => void;
  availableMentions: ComposerMention[];
}) {
  return (
          <div className="xn-composer__actions" role="group" aria-label={tr("输入辅助")}>
            <div className="xn-composer__plus-wrap" ref={plusRef}>
              {/* 附件一级入口（ZCode attachmentAction 式）：直接调现有附件逻辑，
                  「+」菜单保留给 mentions/命令，减少一次点击。 */}
              <button
                type="button"
                className="xn-composer__chip"
                aria-label={tr("添加附件")}
                title={tr("添加附件")}
                data-testid="composer-attachment"
                disabled={disabled || !attachmentsEnabled || legacyAttachmentBusy}
                onClick={openAttachmentPicker}
              >
                <IconPaperclip size={16} />
              </button>
              <button
                ref={plusButtonRef}
                type="button"
                className="xn-composer__chip xn-composer__plus"
                aria-label={tr("添加上下文或能力")}
                aria-haspopup="menu"
                aria-expanded={plusOpen}
                aria-controls={plusOpen ? plusMenuId : undefined}
                data-testid="composer-plus"
                disabled={disabled}
                onClick={() => setPlusOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (isImeComposingEvent(event)) return;
                  if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setPlusOpen(true);
                  }
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              {plusOpen && (
                <div
                  ref={menuRef}
                  id={plusMenuId}
                  className="xn-composer__plus-menu"
                  role="menu"
                  aria-label={tr("添加上下文或能力")}
                  onKeyDown={handlePlusMenuKeyDown}
                  onBlur={(event) => {
                    // Native mouse/touch focus loss can report null before click.
                    // Outside pointerdown and a real Tab focus destination dismiss it.
                    if (event.relatedTarget && !plusRef.current?.contains(event.relatedTarget as Node)) closePlusMenu();
                  }}
                >
                  <div className="xn-composer-add-search"><Search size={15} aria-hidden="true" /><input
                    type="search" value={addSearch} data-testid="composer-add-search"
                    aria-label={tr('搜索能力或上下文')} placeholder={tr('搜索能力或上下文')}
                    onChange={event => setAddSearch(event.target.value)} /></div>
                  <div className="xn-composer__plus-heading">{tr("添加")}</div>
                  <button type="button" role="menuitem" disabled={!attachmentsEnabled || legacyAttachmentBusy} onClick={openAttachmentPicker}>
                    <IconPaperclip size={16} />{tr("附件")}
                  </button>
                  {canOfferGoal && (
                    <button
                      type="button"
                      role="menuitem"
                      aria-pressed={goal}
                      onClick={() => {
                        if (startActions?.onGoal) startActions.onGoal();
                        else setGoal((current) => !current);
                        closePlusMenu();
                        localInputRef.current?.focus();
                      }}
                    ><Target size={16} aria-hidden="true" />{goal ? tr("移除目标标记") : tr("添加为目标")}</button>
                  )}
                  {canOfferWorkflow && startActions && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        startActions.onWorkflow();
                        closePlusMenu();
                        localInputRef.current?.focus();
                      }}
                    ><Workflow size={16} aria-hidden="true" />{tr("创建工作流")}</button>
                  )}
                  {startActions && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        startActions.onPlugins();
                        closePlusMenu();
                      }}
                    ><Blocks size={16} aria-hidden="true" />{tr("管理插件")}</button>
                  )}
                  <ComposerCapabilityMenu items={visibleCapabilities} selected={selectedCapabilities} onToggle={item => {
                    toggleCapability(item); closePlusMenu(); localInputRef.current?.focus();
                  }} />
                  {(["plugin", "file", "session", "skill"] as const).map((kind) => {
                    const items = visibleMentions.filter((mention) => mention.kind === kind).slice(0, addSearch.trim() ? 50 : 8);
                    if (items.length === 0) return null;
                    const field = kind === "file" ? "files" : kind === "session" ? "sessions" : kind === "skill" ? "skills" : "plugins";
                    const heading = kind === "plugin" ? tr("插件") : kind === "file" ? tr("文件") : kind === "session" ? tr("任务") : tr("技能");
                    return (
                      <div className="xn-composer__plus-group" role="group" aria-label={heading} key={kind}>
                        <div className="xn-composer__plus-heading">{heading}</div>
                        {items.map((mention) => (
                          <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={selectedContext[field].includes(mention.id)}
                            key={mention.id}
                            title={mention.description}
                            onClick={() => {
                              toggleContext(mention);
                              closePlusMenu();
                              localInputRef.current?.focus();
                            }}
                          >{mention.label}</button>
                        ))}
                      </div>
                    );
                  })}
                  {addSearch.trim() && !visibleCapabilities.length && !visibleMentions.length && <div className="xn-composer__plus-empty" role="status">{tr('没有匹配的能力或上下文')}</div>}
                  {availableMentions.length === 0 && !startActions && (
                    <div className="xn-composer__plus-empty">{tr("暂无可添加的上下文")}</div>
                  )}
                  <div className="xn-composer__plus-help">{tr("@ 文件、插件或会话 · $ 技能 · / 命令")}</div>
                </div>
              )}
            </div>
          </div>
  );
}
