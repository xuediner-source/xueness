/** Match explicit saved outputs without turning input paths or URLs into checks. */
const URLS = /https?:\/\/[^\s<>"'，。；、（）)\]]+/giu;
const WORD = "\\p{L}\\p{N}_";
const PATHS = new RegExp(`(?<![${WORD}.\\-])(?:[A-Za-z]:[\\\\/])?(?:[${WORD}.\\-]+[\\\\/])*[${WORD}.\\-]+\\.(?:md|txt|csv|json|html|docx|pptx|xlsx|pdf|mjs|cjs|js|jsx|ts|tsx|py|rs|go|java|cpp|hpp|c|h|sh|ps1|sql|yaml|yml)(?![${WORD}])`, "giu");
const INTENT = /(?<output>(?<![A-Za-z0-9_])(?:交付|撰写|保存(?:到|为|成)?|另存(?:为|到)?|存成|写入|写到|写成|输出(?:到|为)?|导出(?:到|为)?|创建|新建|生成|制作|报告到|报告为|deliver(?:ables)?|save(?:\s+(?:as|to))?|export(?:\s+(?:to|as))?|write(?:\s+(?:to|into|as))?|generate|create|produce|store|output(?:\s+(?:to|as))?|report\s+(?:to|as))(?![A-Za-z0-9_]))|(?<input>(?<![A-Za-z0-9_])(?:输入|只读|不包括|不包含|不含|排除|扫描|核对|阅读|读取|查看|打开|分析|提取|总结|研究|依据|参考|从|基于|根据|scan|verify|check|read|inspect|open|analy[sz]e|extract|summari[sz]e|research|from|based\s+on|using|inputs?|source(?:s)?|reference|about|exclude)(?![A-Za-z0-9_]))/giu;
const ARTIFACT = /文件|文档|产物|file|document|artifact|spreadsheet|workbook|pdf|docx|pptx|xlsx/giu;
const PERSIST = /保存|另存|存成|写入|写到|save(?![\p{L}\p{N}_])|export(?![\p{L}\p{N}_])|store(?![\p{L}\p{N}_])/giu;
const NEGATED = /(?:不要(?:去)?|无需|不必|别(?:去)?|do\s+not|don['’]t|no\s+need\s+to)\s*$/iu;
const mask = (text: string, pattern: RegExp): string => text.replace(pattern, (match) => " ".repeat(match.length));
const negates = (text: string, start: number): boolean => NEGATED.test(text.slice(0, start));
function isOutput(text: string, before: number): boolean {
  const intent = [...text.slice(0, before).matchAll(INTENT)].at(-1);
  return !!intent?.groups?.output && !negates(text, intent.index!);
}
export function explicitOutputPaths(task: string): string[] {
  const text = mask(task, URLS), paths = [...text.matchAll(PATHS)], masked = mask(text, PATHS);
  return [...new Set(paths.filter((path) => !/^\.(?:d\.)?[a-z]+$/iu.test(path[0]) && isOutput(masked, path.index!)).map((path) => path[0]))];
}
export function requestsFileOutput(task: unknown): boolean {
  if (typeof task !== "string") return false;
  if (explicitOutputPaths(task).length) return true;
  const text = mask(mask(task, URLS), PATHS);
  return [...text.matchAll(PERSIST)].some((match) => !negates(text, match.index!))
    || [...text.matchAll(ARTIFACT)].some((artifact) => isOutput(text, artifact.index!));
}
