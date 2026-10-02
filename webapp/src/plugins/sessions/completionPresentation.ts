import { t } from '../../i18n';

const JSON_PROTOCOL_ERROR = 'The local model could not follow the configured JSON tool protocol within the configured response limit.';

/** An end-of-run record is terminal, even when its evidence did not pass. */
export function completionPresentation(completion: { verified: boolean; summary: string }) {
  if (completion.summary === JSON_PROTOCOL_ERROR) return {
    title: t('运行结束 · 模型工具协议失败'),
    status: 'error',
    label: t('工具协议错误'),
    summary: t('本地模型未能在响应限制内生成符合 JSON 工具协议的输出，本轮已停止。'),
  };
  return {
    title: t(completion.verified ? '运行结束 · 工具成功证据通过' : '运行结束 · 工具证据未通过验证'),
    status: completion.verified ? 'ok' : 'review',
    label: t(completion.verified ? '已结束' : '未通过验证'),
    summary: completion.summary || t('无完成总结'),
  };
}
