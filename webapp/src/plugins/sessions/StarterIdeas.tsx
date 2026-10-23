import React from 'react';
import { BookOpen, Table2, WandSparkles, ArrowUpRight } from 'lucide-react';
import { t } from '../../i18n';
import './starter-ideas.css';

const ideas = [
  { id: 'understand', Icon: BookOpen, title: '看懂一份资料', detail: '抓重点，解释术语，给出下一步',
    prompt: '请帮我读懂接下来附上的资料。我是新手，请先用三句话说明重点，再解释必要的术语，最后告诉我可以怎么做。' },
  { id: 'organize', Icon: Table2, title: '整理一张表格', detail: '清理数据，算出结果，保存新文件',
    prompt: '请帮我整理接下来附上的表格：找出重复或缺失的数据，汇总关键数字，把结果保存为一个新文件，并告诉我改了什么。' },
  { id: 'create', Icon: WandSparkles, title: '做出一个小工具', detail: '从想法开始，一起做出可用的成果',
    prompt: '我想做一个帮我解决日常问题的小工具。我没有编程经验，请先问我最想解决什么问题，再帮我一步步做出可用的版本。' },
] as const;

export function StarterIdeas({ onSelect, disabled = false }: { onSelect(prompt: string): void; disabled?: boolean }) {
  return <div className="xn-starter-ideas" role="group" aria-label={t('从一个想法开始')} data-testid="starter-ideas">
    {ideas.map(({ id, Icon, title, detail, prompt }) => <button type="button" key={id}
      data-testid={`starter-idea-${id}`} disabled={disabled} onClick={() => onSelect(t(prompt))}>
      <span className="xn-starter-ideas__top"><Icon size={17} aria-hidden="true" /><ArrowUpRight size={14} aria-hidden="true" /></span>
      <strong>{t(title)}</strong><span className="xn-starter-ideas__detail">{t(detail)}</span>
    </button>)}
  </div>;
}
