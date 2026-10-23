import React from 'react';
import { t as tr } from '../../i18n';
import { nativeToolPayload } from './nativeToolPayload';
import type { ToolRendererId, ToolRow } from './toolRenderers';

/** Pure, bounded native payload card. No requests, effects or child transcripts. */
export function NativeToolCallCard({ kind, row }: { kind: ToolRendererId; row: ToolRow }): React.JSX.Element {
  const payload = nativeToolPayload(kind, row);
  return <section className="xn-zc-native-tool" data-native-tool-card={kind}>
    {payload.fields.length > 0 && <dl>{payload.fields.map((field, index) => <React.Fragment key={index}>
      <dt>{tr(field.label)}</dt><dd>{['执行方式', '截图'].includes(field.label) ? tr(field.value) : field.value}</dd>
    </React.Fragment>)}</dl>}
    {payload.url && <p><a href={payload.url} target="_blank" rel="noopener noreferrer">{payload.url}</a></p>}
    {payload.lines.length > 0 && <pre>{payload.lines.join('\n')}</pre>}
    {!payload.fields.length && !payload.lines.length && !payload.url && <p>{tr('无可显示的结构化结果')}</p>}
    {payload.truncated && <p role="note">{tr('[输出已截断]')}</p>}
  </section>;
}
