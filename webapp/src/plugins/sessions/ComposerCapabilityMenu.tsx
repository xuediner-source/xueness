import React from 'react';
import { BookOpen, Blocks, FileText, FileSpreadsheet, Presentation, Globe, Image, Pencil, Check } from 'lucide-react';
import { getLocale, t } from '../../i18n';
import type { ComposerCapability } from '../../xuenessComposer';
import './ComposerCapabilityMenu.css';

export const MAX_SELECTED_COMPOSER_CAPABILITIES = 8;

export function capabilityLabel(item: ComposerCapability): string {
  return getLocale() === 'en' ? item.labelEn : item.label;
}

export function matchesComposerSearch(query: string, ...fields: (string | undefined)[]): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = fields.filter(Boolean).join(' ').toLocaleLowerCase();
  return words.every(word => haystack.includes(word));
}

const icons = { 'extensions.plugin_creator': Blocks, 'skills.skill_creator': Pencil,
  'sessions.usage_guide': BookOpen, 'office.pdf_authoring': FileText,
  'office.docx_authoring': FileText, 'office.pptx_authoring': Presentation,
  'office.xlsx_authoring': FileSpreadsheet, 'browser.composer_operation': Globe,
  'network.image_search': Image };

/** Pure presentation of the server's enabled, statically bundled contributions. */
export function ComposerCapabilityMenu({ items, selected, onToggle }: {
  items: ComposerCapability[]; selected: string[]; onToggle(item: ComposerCapability): void;
}) {
  if (!items.length) return null;
  const atLimit = selected.length >= MAX_SELECTED_COMPOSER_CAPABILITIES;
  const limitHint = t('最多选择 8 项能力；取消一项后可继续选择。');
  return <div role="group" aria-label={t('能力')} className="xn-composer__plus-group xn-composer-capabilities">
    <div className="xn-composer__plus-heading">{t('能力')}</div>
    {atLimit && <div className="xn-composer__plus-help" role="status">{limitHint}</div>}
    {items.map(item => {
      const Icon = icons[item.id as keyof typeof icons] ?? Blocks;
      const description = getLocale() === 'en' ? item.descriptionEn : item.description;
      const isSelected = selected.includes(item.id);
      const blockedByLimit = atLimit && !isSelected;
      const unavailable = item.available === false;
      const title = [unavailable ? t('启用所属插件后可用') : description,
        blockedByLimit ? limitHint : ''].filter(Boolean).join(' · ');
      return <button key={item.id} type="button" role="menuitemcheckbox"
        aria-checked={isSelected} title={title} disabled={unavailable || blockedByLimit}
        data-testid={`composer-capability-${item.id}`} onClick={() => onToggle(item)}>
        <span className="xn-composer-capabilities__icon"><Icon size={17} aria-hidden="true" /></span>
        <span className="xn-composer-capabilities__copy"><strong>{capabilityLabel(item)}</strong><small>{description}</small></span>
        {isSelected && <Check size={15} className="xn-composer-capabilities__check" aria-hidden="true" />}
      </button>;
    })}
  </div>;
}
