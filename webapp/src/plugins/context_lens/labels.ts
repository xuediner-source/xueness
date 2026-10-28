import { getLocale } from '../../i18n';
import type { Category } from './types';
export const words = {
  dashboard: ['上下文面板', 'Context dashboard'], statistics: ['上下文统计', 'Context statistics'],
  io: ['输入输出', 'Input & output'], session: ['当前会话', 'Current session'], turns: ['用户消息', 'User messages'], answers: ['模型回复', 'Model replies'],
  injectedCount: ['注入', 'Injections'], compactCount: ['压缩', 'Compactions'], maskedCount: ['掩码', 'Masked'],
  pluginInfo: ['插件信息', 'Plugin information'], nativePlugin: ['Xueness 原生插件', 'Xueness native plugin'], pluginSettings: ['插件偏好', 'Plugin preferences'],
  tokenStats: ['Token 统计', 'Token statistics'], totalTokens: ['已报告总量', 'Reported total'], uncached: ['未缓存输入', 'Uncached input'],
  timingStats: ['耗时统计', 'Timing statistics'], recordedTime: ['已记录历时', 'Recorded duration'],
  waiting: ['模型等待', 'Model wait'], thinking: ['模型思考', 'Model thinking'], generating: ['模型生成', 'Model generation'], overhead: ['其它请求时间', 'Other request time'], toolElapsed: ['工具历时', 'Tool elapsed'],
  timingScope: ['仅统计保留的活动样本；工具历时包含审批等待，并发工具会重叠。', 'Retained activity samples only; tool elapsed includes approval wait and parallel tools may overlap.'],
  noTiming: ['该会话尚未记录请求耗时。', 'No request timing recorded for this session.'], requestSpeed: ['请求平均速度', 'Average request speed'],
  currentContext: ['当前上下文', 'Current context'], contextUsage: ['上下文占用', 'Context occupancy'], available: ['可用空间', 'Available space'],
  previousStep: ['上一步', 'Previous step'], nextStep: ['下一步', 'Next step'], nextRequest: ['当前（下一次请求）', 'Current (next request)'],
  dna: ['DNA 模式', 'DNA mode'], usageMode: ['实际用量', 'Reported usage'], full: ['全量', 'Full'], delta: ['增量', 'Delta'],
  requestInput: ['输入', 'Input'], requestOutput: ['输出', 'Output'], itemCount: ['项', 'items'], compositionTotal: ['组成估算合计', 'Estimated composition total'],
  unavailableBody: ['该历史内容已不在现存上下文中；仅保留指纹与估算。', 'This historical content is no longer retained; only its fingerprint and estimate remain.'],
  sampleCount: ['活动样本', 'Activity samples'], captureCount: ['组成快照', 'Composition snapshots'],
  contextEmpty: ['没有可显示的上下文内容。', 'No context content to display.'], missingCapture: ['未记录组成', 'No composition capture'],
  toolsScope: ['当前浏览器展示保留消息；工具定义可在已有的请求快照中查看。', 'The current browser shows retained messages; tool definitions are available in captured requests.'],
  subtitle: ['看清每一步带入了什么，以及用量花在了哪里。', 'See what each request carries and where your tokens go.'],
  preferences: ['偏好设置', 'Preferences'], settingsOff: ['启用设置插件后可修改偏好。', 'Enable the Settings plugin to edit preferences.'],
  preferenceScope: ['提示词前后缀从下一次模型请求起生效，包含子代理；留空即关闭。', 'Prompt prefix and suffix apply to subsequent model requests, including subagents. Leave empty to disable.'],
  prefix: ['系统提示词前缀', 'System prompt prefix'], suffix: ['系统提示词后缀', 'System prompt suffix'], captureSwitch: ['记录后续请求的上下文组成', 'Capture composition for future requests'],
  save: ['保存偏好', 'Save preferences'], saved: ['偏好已保存', 'Preferences saved'],
  title: ['上下文透镜', 'Context Lens'], overview: ['会话洞察', 'Session insights'], context: ['上下文', 'Context'], activity: ['文件与命令', 'Files & commands'], fleet: ['代理关系', 'Agent family'],
  search: ['搜索会话', 'Search sessions'], refresh: ['刷新', 'Refresh'], loading: ['正在读取上下文…', 'Loading context…'], empty: ['还没有会话记录。', 'No session records yet.'],
  requests: ['模型请求', 'Model requests'], input: ['实际输入 Token', 'Reported input tokens'], output: ['实际输出 Token', 'Reported output tokens'], cached: ['缓存命中', 'Cache hits'], unknown: ['未知', 'Unknown'],
  current: ['当前保留内容', 'Current retained content'], composition: ['上下文组成估算', 'Estimated composition'], source: ['估算使用 dsh-context 的字符 / 4 方法；占用率使用 Xueness 宿主计量。', 'Composition uses dsh-context’s characters / 4 estimate; occupancy uses Xueness host metering.'],
  tools: ['工具调用', 'Tool calls'], files: ['文件活动', 'File activity'], events: ['上下文事件', 'Context events'], trend: ['逐请求趋势', 'Per-request trend'],
  browse: ['内容浏览器', 'Context browser'], filter: ['搜索内容或工具', 'Search content or tools'], all: ['全部', 'All'], step: ['步骤', 'Step'], model: ['模型', 'Model'],
  actual: ['供应商报告', 'Provider reported'], captured: ['已记录的请求组成', 'Captured request composition'], missing: ['安装前的请求没有组成快照，保留为未知。', 'Requests before installation have no composition snapshots and remain unknown.'],
  clip: ['内容预览已截断', 'Content preview truncated'], estimated: ['估算', 'Estimated'], status: ['状态', 'Status'], passed: ['成功', 'Succeeded'], failed: ['失败', 'Failed'], pending: ['未结束', 'Unsettled'],
  execution: ['执行耗时', 'Execution time'], elapsed: ['工具总历时（含审批等待）', 'Tool elapsed time (includes approval wait)'], exit: ['退出码', 'Exit code'], owner: ['所属插件', 'Plugin owner'],
  noTools: ['没有已记录的工具调用。', 'No recorded tool calls.'], noEvents: ['没有已记录的上下文事件。', 'No recorded context events.'],
  read: ['读取', 'Read'], write: ['写入', 'Written'], searched: ['搜索', 'Searched'], footprint: ['行数变化估算', 'Estimated line changes'],
  historical: ['历史快照只记录组成和内容指纹，不重复保存全文。当前浏览器展示现存会话内容。', 'Historical snapshots retain composition and content fingerprints without duplicating full text. The browser shows retained session content.'],
  limits: ['最多保留 160 次请求组成与最近 800 个工具详情；历史供应商用量仍按已存记录统计。', 'Retains up to 160 composition snapshots and the latest 800 tool details; reported usage covers all stored request records.'],
  self: ['当前代理', 'Current agent'], parent: ['父代理', 'Parent'], child: ['子代理', 'Child'], noFamily: ['仅显示会话记录中能够确认的代理关系。', 'Only relationships attested by session records are shown.'],
  allTime: ['全部时间', 'All time'], week: ['最近 7 天', 'Last 7 days'], month: ['最近 30 天', 'Last 30 days'], occupancy: ['宿主上下文占用', 'Host context occupancy'],
  unknownRequests: ['缺少用量的请求', 'Requests missing usage'], provenance: ['基于 dsh-context 0.77.0 · Apache-2.0', 'Adapted from dsh-context 0.77.0 · Apache-2.0'], openChat: ['打开会话', 'Open conversation'],
  showMore: ['显示更多', 'Show more'], requestDetails: ['请求详情', 'Request details'], cacheNote: ['缓存 Token 是输入的子集，不重复计入总量。', 'Cached tokens are a subset of input and are not added again.'],
} as const;
export const label = (key: keyof typeof words) => words[key][getLocale() === 'en' ? 1 : 0];
export const categories: Category[] = ['system', 'tools', 'user', 'injected', 'assistant', 'reasoning', 'tool'];
const categoryLabels: Record<Category, [string, string]> = { system: ['系统提示词', 'System prompt'], tools: ['工具定义', 'Tool schemas'], user: ['用户消息', 'User messages'], injected: ['注入内容', 'Injected'], assistant: ['助手消息', 'Assistant messages'], reasoning: ['推理', 'Reasoning'], tool: ['工具结果', 'Tool results'] };
export const categoryLabel = (key: Category) => categoryLabels[key][getLocale() === 'en' ? 1 : 0];
export const format = (value: number | null | undefined) => value == null ? label('unknown') : value.toLocaleString();
export const compact = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(Math.round(value));
export const duration = (ms: number) => ms >= 3600000 ? `${Math.floor(ms / 3600000)}h ${Math.floor(ms % 3600000 / 60000)}m` : ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
