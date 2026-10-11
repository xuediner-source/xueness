// Adapted from dsh-plugin-suite, MIT, copyright 2026 xuediner-source and contributors.
// Source commit 3e70973ecd390d93e5b092e14f09026c1bef9df2. See LICENSE-MIT.txt.
import crypto from "node:crypto";
const QODER_CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";
const QODER_ORIGIN = "https://api3.qoder.sh";
const QODER_JOB_ORIGIN = "https://api2.qoder.sh";
const QODER_OPENAPI = "https://openapi.qoder.sh";
const QODER_MODEL_QWEN_FLASH = "qfmodel";
const QODER_MODEL_QWEN_MAX = "qmodel_38max";
const QODER_MODEL_DEEPSEEK_FLASH = "dfmodel";
const QODER_HIDDEN_UPSTREAMS = [
  `qd/${QODER_MODEL_QWEN_FLASH}`,
  `qd/${QODER_MODEL_QWEN_MAX}`,
  `qd/${QODER_MODEL_DEEPSEEK_FLASH}`
];
const QODER_QWEN_FLASH_ID = "qwen3.8-flash";
const QODER_QWEN_MAX_ID = "qwen3.8-max";
function qoderDirectModel(uiModel) {
  if (uiModel === QODER_QWEN_FLASH_ID) return QODER_MODEL_QWEN_FLASH;
  if (uiModel === QODER_QWEN_MAX_ID) return QODER_MODEL_QWEN_MAX;
  return void 0;
}
const QODER_ENTRIES = [
  {
    id: QODER_QWEN_FLASH_ID,
    upstream: QODER_MODEL_QWEN_FLASH,
    name: "Qwen3.8-Flash (Qoder)",
    description: "Qwen3.8-Flash \xB7 1M \u4E0A\u4E0B\u6587 \xB7 \u652F\u6301\u56FE\u7247\uFF08Qoder \u8BA2\u9605\u76F4\u8FDE\uFF09"
  },
  {
    id: QODER_QWEN_MAX_ID,
    upstream: QODER_MODEL_QWEN_MAX,
    name: "Qwen3.8-Max (Qoder)",
    description: "Qwen3.8-Max \xB7 1M \u4E0A\u4E0B\u6587 \xB7 \u652F\u6301\u56FE\u7247\uFF08Qoder \u8BA2\u9605\u76F4\u8FDE\uFF09"
  }
];
const COSY_VERSION = "1.0.0";
const COSY_CLIENT_TYPE = "5";
const COSY_MACHINE_TYPE = "5";
const COSY_MACHINE_OS = "x86_64_windows";
const COSY_DATA_POLICY = "disagree";
const LOGIN_VERSION = "v2";
const COSY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
async function resolveQoderCredential() {
  const accessToken = process.env.QODER_ACCESS_TOKEN?.trim();
  const userId = process.env.QODER_USER_ID?.trim();
  return accessToken && userId ? { accessToken, userId } : void 0;
}
function aesCbcEncrypt(plain, key16) {
  const data = Buffer.from(plain, "utf8");
  const pad = 16 - data.length % 16;
  const padded = Buffer.alloc(data.length + pad, pad);
  data.copy(padded, 0);
  const cipher = crypto.createCipheriv("aes-128-cbc", key16.subarray(0, 16), key16.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}
function md5(input) {
  return crypto.createHash("md5").update(input).digest("hex");
}
function sigPath(url) {
  try {
    const p = new URL(url).pathname || "";
    return p.startsWith("/algo") ? p.slice(5) : p;
  } catch {
    return "";
  }
}
function cosyHeaders(body, cred, url) {
  const aesKey = Buffer.from(crypto.randomBytes(16).toString("hex").slice(0, 16), "utf8");
  const identity = JSON.stringify({
    uid: cred.userId,
    security_oauth_token: cred.accessToken,
    name: cred.name ?? "",
    aid: "",
    email: cred.email ?? ""
  });
  const info = aesCbcEncrypt(identity, aesKey).toString("base64");
  const cosyKey = crypto.publicEncrypt(
    { key: COSY_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    aesKey
  ).toString("base64");
  const seconds = String(Math.floor(Date.now() / 1e3));
  const envelope = JSON.stringify({
    version: "v1",
    requestId: crypto.randomUUID(),
    info,
    cosyVersion: COSY_VERSION,
    ideVersion: ""
  });
  const encoded = Buffer.from(envelope, "utf8").toString("base64");
  const bodyDigest = md5(body);
  const path2 = sigPath(url);
  const toSign = [
    encoded,
    cosyKey,
    seconds,
    body.toString("latin1"),
    path2
  ].join("\n");
  const sig = md5(Buffer.from(toSign, "latin1"));
  const machineId = crypto.randomUUID();
  return {
    Authorization: `Bearer COSY.${encoded}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": cred.userId,
    "Cosy-Date": seconds,
    "Cosy-Version": COSY_VERSION,
    "Cosy-Machineid": machineId,
    "Cosy-Machinetoken": machineId,
    "Cosy-Machinetype": COSY_MACHINE_TYPE,
    "Cosy-Machineos": COSY_MACHINE_OS,
    "Cosy-Clienttype": COSY_CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": bodyDigest,
    "Cosy-Bodylength": String(body.length),
    "Cosy-Sigpath": path2,
    "Cosy-Data-Policy": COSY_DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": LOGIN_VERSION,
    "X-Request-Id": crypto.randomUUID(),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "qodercli/1.0.0"
  };
}
function selectOrigin(accessToken) {
  return accessToken.startsWith("jt-") ? QODER_JOB_ORIGIN : QODER_ORIGIN;
}
const QODER_MAX_TOKENS_CEILING = 32768;
const QODER_DEFAULT_MAX_TOKENS = 32e3;
const QODER_EFFORT_NONE = "none";
function thinkingDisabledByEffort(reasoningEffort) {
  return reasoningEffort === QODER_EFFORT_NONE;
}
function unwrapQoderEvent(payload) {
  try {
    const outer = JSON.parse(payload);
    if (outer === null || typeof outer !== "object" || !("body" in outer)) return outer;
    const inner = outer.body;
    if (typeof inner !== "string") return inner;
    if (inner === "[DONE]") return void 0;
    return JSON.parse(inner);
  } catch {
    return void 0;
  }
}
async function qoderChat(cred, req, fetchImpl = fetch, targetOrigin) {
  const requestId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  const promptText = typeof lastUser?.content === "string" ? lastUser.content : "";
  const thinkingOff = thinkingDisabledByEffort(req.reasoningEffort);
  const modelConfig = { key: req.model, is_reasoning: !thinkingOff };
  const requestedMaxTokens = req.maxTokens ?? QODER_DEFAULT_MAX_TOKENS;
  const effectiveMaxTokens = Math.min(requestedMaxTokens, QODER_MAX_TOKENS_CEILING);
  const parameters = {
    max_tokens: effectiveMaxTokens,
    enable_thinking: !thinkingOff
  };
  if (req.reasoningEffort) parameters.reasoning_effort = req.reasoningEffort;
  const payload = {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    messages: req.messages,
    tools: Array.isArray(req.tools) ? req.tools : [],
    parameters,
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig,
        originalContent: promptText
      },
      features: [],
      text: promptText
    },
    model_config: modelConfig,
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: requestId,
      name: promptText.slice(0, 30),
      begin_at: Date.now()
    }
  };
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const baseOrigin = targetOrigin ?? selectOrigin(cred.accessToken);
  const url = `${baseOrigin}${QODER_CHAT_PATH}`;
  const headers = cosyHeaders(raw, cred, url);
  return fetchImpl(url, {
    method: "POST",
    headers,
    body: raw,
    ...req.signal ? { signal: req.signal } : {}
  });
}
export {
  QODER_CHAT_PATH,
  QODER_ENTRIES,
  QODER_HIDDEN_UPSTREAMS,
  QODER_JOB_ORIGIN,
  QODER_MAX_TOKENS_CEILING,
  QODER_MODEL_DEEPSEEK_FLASH,
  QODER_MODEL_QWEN_FLASH,
  QODER_MODEL_QWEN_MAX,
  QODER_OPENAPI,
  QODER_ORIGIN,
  QODER_QWEN_FLASH_ID,
  QODER_QWEN_MAX_ID,
  cosyHeaders,
  qoderChat,
  qoderDirectModel,
  resolveQoderCredential,
  selectOrigin,
  unwrapQoderEvent
};
