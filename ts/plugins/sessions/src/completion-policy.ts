/** Sessions-owned distinction between ordinary chat and tool-dependent work. */
import { createHash } from "node:crypto";
import { isDict, pyJsonDumps } from "@xueness/contracts";
import type { AgentExtension } from "@xueness/agent";
type Row = Record<string, unknown>;
const GREETING = /^(?:hi|hello|hey|你好|您好|嗨|早上好|晚上好|下午好|早安|晚安|哈喽|在吗)/iu;
const TARGET = /\b(?:this|the|my|our)\s+(?:repo(?:sitory)?|workspace|project|codebase|file|folder|directory|branch|app|application)\b|\b(?:in|within|inside|against)\s+(?:the\s+)?(?:repo(?:sitory)?|workspace|project|codebase)\b|\b(?:src\/|tests?\/|docs\/|[\w.-]+\.(?:py|ts|tsx|js|jsx|json|md|txt|toml|yaml|yml))\b|(?:这个|该|当前)(?:仓库|代码库|工作区|项目|文件|目录|分支|应用)|(?:仓库|代码库|工作区)|(?:项目|文件|目录)里|(?:附件|附加文件)/iu;
const ACTION = /\b(?:implement|fix|debug|refactor|edit|modify|change|update|delete|remove|create|write|read|inspect|review|search|find|test|verify|run|execute|build|deploy|install|commit)\b|(?:实现|修复|调试|重构|编辑|修改|更改|更新|删除|移除|创建|写入|读取|查看|检查|审查|搜索|查找|测试|验证|运行|执行|构建|部署|安装|提交)/iu;
const EXPLICIT = /\b(?:fix\s+(?:the\s+)?(?:bug|issue|error)|run\s+(?:the\s+)?(?:tests?|command|script|server)|execute\s+(?:the\s+)?command|search\s+the\s+web|browse\s+the\s+web|look\s+up\s+(?:the\s+)?(?:latest|current)|research\s+(?:the\s+)?(?:latest|current))\b|(?:修复(?:一下)?(?:这个|该)?(?:问题|错误|bug)|运行(?:一下)?(?:测试|命令|脚本)|执行(?:命令|脚本)|联网搜索|搜索网页|查一下最新|研究最新)/iu;
const NETWORK = /\b(?:search|browse|look\s+up|research|check)\b.{0,50}\b(?:web|internet|online|latest|current|today|price|news|weather)\b|(?:搜索|浏览|查询|查找|研究).{0,30}(?:网页|网络|最新|当前|今天|价格|新闻|天气)/iu;

export function deliveryPlanSettled(session: Row): boolean {
  const requirements = session.delivery_requirements; const history = session.completion_history;
  if (!Array.isArray(requirements) || !requirements.length || !Array.isArray(history) || !history.length) return false;
  const latest = history.at(-1);
  if (!isDict(latest) || latest.delivery_status !== "passed" || !["verified", "not_applicable"].includes(String(latest.status))) return false;
  const users = (Array.isArray(session.messages) ? session.messages : []).filter((row) => isDict(row) && row.role === "user" && row._input_kind !== "background_notice").length;
  if (latest.turn_id === `turn-${Math.max(1, users)}` || typeof latest.turn_id !== "string" || !/^turn-[1-9][0-9]*$/.test(latest.turn_id)) return false;
  try { return latest.delivery_plan_digest === createHash("sha256").update(pyJsonDumps(requirements, { sortKeys: true, ensureAscii: true }), "ascii").digest("hex"); }
  catch { return false; }
}
export function requiresEvidence(session: Row, callIds: readonly string[] = []): boolean {
  if (callIds.length || session.delivery_requirements && !deliveryPlanSettled(session) && (!Array.isArray(session.delivery_requirements) || session.delivery_requirements.length)) return true;
  let text = (Array.isArray(session.messages) ? session.messages : []).filter(isDict).findLast((row) => row.role === "user" && row._input_kind !== "background_notice")?.content ?? "";
  if (Array.isArray(text)) text = text.filter(isDict).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
  if (typeof text !== "string" || !text.trim()) return false;
  const clean = text.trim();
  const greeting = GREETING.exec(clean);
  if (greeting) {
    const rest = clean.slice(greeting[0].length); const word = (char: string): boolean => /[\p{L}\p{N}_]/u.test(char);
    const boundary = !rest || /^[，,！!。．.？?\s]/u.test(rest) || word(greeting[0].at(-1)!) !== word(Array.from(rest)[0]!);
    if (boundary && !(TARGET.test(clean) || NETWORK.test(clean) || EXPLICIT.test(clean))) return false;
  }
  return NETWORK.test(clean) || EXPLICIT.test(clean) || TARGET.test(clean) && ACTION.test(clean);
}
export const sessionsCompletionExtension = (): AgentExtension => ({ id: "sessions", capabilities: ["sessions.completion_policy"], completionRequiresEvidence: (context, ids) => requiresEvidence(context.session, ids) });
