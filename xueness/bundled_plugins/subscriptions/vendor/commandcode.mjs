// Adapted from dsh-plugin-suite, MIT, copyright 2026 xuediner-source and contributors.
// Source commit 3e70973ecd390d93e5b092e14f09026c1bef9df2. See LICENSE-MIT.txt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const COMMANDCODE_API_BASE = "https://api.commandcode.ai";
const COMMANDCODE_GENERATE_URL = `${COMMANDCODE_API_BASE}/alpha/generate`;
const COMMANDCODE_WHOAMI_URL = `${COMMANDCODE_API_BASE}/alpha/whoami`;
const COMMANDCODE_CREDITS_URL = `${COMMANDCODE_API_BASE}/alpha/billing/credits`;
const COMMANDCODE_CLI_VERSION = "1.62.0";
const HEADER_TIMEOUT_MS = 3e4;
const COMMANDCODE_MODELS = [
  {
    id: "meta/muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor (Go)",
    description: "Meta Muse Spark 1.3 Contributor \xB7 1M \u4E0A\u4E0B\u6587 \xB7 \u652F\u6301\u601D\u8003\u4E0E\u591A\u6A21\u6001",
    contextWindow: 1048576,
    maxTokens: 64e3,
    supportsImage: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high"
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash (Go)",
    description: "DeepSeek V4.1 Flash \xB7 1M \u4E0A\u4E0B\u6587 \xB7 \u652F\u6301\u601D\u8003\u4E0E\u591A\u6A21\u6001",
    contextWindow: 1e6,
    maxTokens: 64e3,
    supportsImage: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high"
  },
  {
    id: "xiaomi/mimo-v2.6-pro",
    name: "MiMo V2.6 Pro (Go)",
    description: "Xiaomi MiMo V2.6 Pro \xB7 1M \u4E0A\u4E0B\u6587 \xB7 \u652F\u6301\u601D\u8003\u4E0E\u591A\u6A21\u6001",
    contextWindow: 1e6,
    maxTokens: 64e3,
    supportsImage: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high"
  },
  {
    id: "poolside/laguna-s-2.1-free",
    name: "Laguna S 2.1 (Free) (Go)",
    description: "Poolside Laguna S 2.1 (Free) \xB7 256K \u4E0A\u4E0B\u6587 \xB7 \u514D\u8D39\u989D\u5EA6",
    contextWindow: 262144,
    maxTokens: 64e3,
    supportsImage: false,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "low"
  },
  {
    id: "inclusionai/ling-3.0-flash-sante:free",
    name: "Ling 3.0 Flash Sante (Free) (Go)",
    description: "Ling 3.0 Flash Sante (Free) \xB7 256K \u4E0A\u4E0B\u6587 \xB7 \u514D\u8D39\u989D\u5EA6",
    contextWindow: 256e3,
    maxTokens: 64e3,
    supportsImage: false,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "low"
  }
];
function findCommandCodeModel(id) {
  const exact = COMMANDCODE_MODELS.find((m) => m.id === id);
  if (exact !== void 0) return exact;
  const bySuffix = COMMANDCODE_MODELS.find(
    (m) => typeof id === "string" && (m.id.endsWith(id) || id.endsWith(m.id))
  );
  return bySuffix ?? COMMANDCODE_MODELS[0];
}
function readCommandCodeAuthFile() {
  try {
    const file = path.join(os.homedir(), ".commandcode", "auth.json");
    if (!fs.existsSync(file)) return void 0;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed.apiKey !== "string" || parsed.apiKey.length === 0) return void 0;
    return parsed.apiKey;
  } catch {
    return void 0;
  }
}
function readSubscriptionToken() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || "", ".dsh");
  try {
    const file = path.join(home, "plugins", "subscriptions", "auth.json");
    if (!fs.existsSync(file)) return void 0;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const entry = parsed?.commandcode;
    if (!entry) return void 0;
    for (const field of ["accessToken", "access_token", "apiKey", "api_key", "key"]) {
      const value = entry[field];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return void 0;
  } catch {
    return void 0;
  }
}
function resolveCommandCodeKey() {
  const fromEnv = process.env.COMMANDCODE_API_KEY?.trim();
  if (fromEnv !== void 0 && fromEnv.length > 0) return fromEnv;
  return readCommandCodeAuthFile() ?? readSubscriptionToken();
}
function headers(apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-command-code-version": COMMANDCODE_CLI_VERSION,
    "x-cli-environment": "production",
    "x-project-slug": "xueness",
    "x-taste-learning": "false",
    "x-co-flag": "false"
  };
}
async function commandCodeChat(apiKey, req, fetchImpl = fetch) {
  const body = {
    config: {
      workingDir: process.cwd(),
      date: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
      environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: []
    },
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: req.model,
      messages: req.messages,
      system: req.system,
      stream: true,
      ...req.tools !== void 0 && req.tools.length > 0 ? { tools: req.tools } : {},
      ...req.temperature !== void 0 ? { temperature: req.temperature } : {},
      ...req.maxTokens !== void 0 ? { max_tokens: req.maxTokens } : {},
      ...req.reasoningEffort !== void 0 ? { reasoning_effort: req.reasoningEffort } : {}
    },
    threadId: req.threadId
  };
  const controller = new AbortController();
  const onAbort = () => controller.abort(req.signal?.reason);
  if (req.signal) {
    if (req.signal.aborted) controller.abort(req.signal.reason);
    else req.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`commandcode header timeout after ${HEADER_TIMEOUT_MS}ms`)),
    HEADER_TIMEOUT_MS
  );
  try {
    return await fetchImpl(COMMANDCODE_GENERATE_URL, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
    if (req.signal) req.signal.removeEventListener("abort", onAbort);
  }
}
export {
  COMMANDCODE_API_BASE,
  COMMANDCODE_CLI_VERSION,
  COMMANDCODE_CREDITS_URL,
  COMMANDCODE_GENERATE_URL,
  COMMANDCODE_MODELS,
  COMMANDCODE_WHOAMI_URL,
  commandCodeChat,
  findCommandCodeModel,
  resolveCommandCodeKey
};
