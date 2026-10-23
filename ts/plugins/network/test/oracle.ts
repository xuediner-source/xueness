/**
 * The Python network plugin as an oracle, batched: page text, unescape, URL
 * checks, IP and IDNA rules, and whole tool calls against a scripted resolver
 * and HTTPS exchange (the same script drives `scriptedNet` on the TS side).
 */
import { runPython } from "../../../test-support/python-oracle.ts";
import type { HttpExchange, HttpResponse, Net } from "../src/net.ts";

const CODE = String.raw`
import base64, json, os, socket, sys, tempfile, time, ipaddress, ssl, http.client
from pathlib import Path
from unittest import mock
from xueness.bundled_plugins.network import tooling, transport
from xueness.tool_contract import bind_execution

GAI = {"EAI_AGAIN": socket.EAI_AGAIN, "EAI_NONAME": socket.EAI_NONAME, "EAI_NODATA": getattr(socket, "EAI_NODATA", socket.EAI_NONAME), "EAI_FAIL": socket.EAI_FAIL}
def raise_kind(kind):
    if kind == "timeout": raise socket.timeout("timed out")
    if kind == "cert": raise ssl.SSLCertVerificationError("bad cert")
    if kind == "ssl": raise ssl.SSLError("handshake")
    if kind == "http": raise http.client.HTTPException("bad")
    raise OSError("reset")

class Gate:
    def __init__(self, deny): self.checks, self.deny = [], deny
    def check(self, kind, subject):
        self.checks.append([kind, subject])
        if self.deny: raise PermissionError(kind + " requires explicit approval")

def run_tool(case):
    tmp = Path(tempfile.mkdtemp())
    for name, text in (case.get("files") or {}).items():
        path = tmp / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text, encoding="utf-8")
    lookups, requests = [], []
    dns, http = case.get("dns") or {}, case.get("http") or {}
    def getaddrinfo(host, port, *args, **kwargs):
        lookups.append(host)
        answer = dns.get(host, "EAI_NONAME")
        if isinstance(answer, str):
            if answer == "OSError": raise OSError("resolver")
            raise socket.gaierror(GAI[answer], answer)
        return [(socket.AF_INET6 if ":" in a else socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, 443)) for a in answer]
    class Response:
        def __init__(self, spec): self.spec = spec; self.status = spec.get("status", 200)
        def getheader(self, name, default=""):
            value = self.spec.get("contentType", "text/plain")
            return default if value is None else value
        def read(self, amount):
            if self.spec.get("readError"): raise_kind(self.spec["readError"])
            return base64.b64decode(self.spec.get("body", ""))[:amount]
    class Connection:
        def __init__(self, host, address, port=443, timeout=15): self.host, self.address, self.timeout = host, address, timeout
        def request(self, method, path, body=None, headers=None):
            requests.append({"host": self.host, "address": self.address, "method": method, "path": path, "headers": headers or {}, "body": body.decode("utf-8") if body else None, "timeout": self.timeout})
            self.spec = http.get(self.host + " " + path.split("?", 1)[0], http.get(self.host, {"error": "os"}))
            if self.spec.get("error"): raise_kind(self.spec["error"])
        def getresponse(self): return Response(self.spec)
        def close(self): pass
    clock = [0.0]
    def monotonic():
        clock[0] += case.get("clockStep", 0); return clock[0]
    env = {k: v for k, v in os.environ.items() if not k.startswith("XUENESS_")}
    env.update(case.get("env") or {})
    gate = Gate(case.get("deny", False))
    handler = {tool.name: tool.handler for tool in tooling.REGISTRY}[case["tool"]]
    with mock.patch.object(transport.socket, "getaddrinfo", getaddrinfo), mock.patch.object(transport, "_PinnedHTTPS", Connection), \
         mock.patch.dict(os.environ, env, clear=True), mock.patch.object(tooling.time, "monotonic", monotonic), bind_execution(state_dir=tmp):
        try: result = {"result": json.dumps(handler(tmp, gate, case["args"], None, "c1"), ensure_ascii=False)}
        except PermissionError: result = {"result": "gate_denied"}
    return dict(result, checks=gate.checks, lookups=lookups, requests=requests)

out = []
for line in sys.stdin.read().split("\n"):
    case = json.loads(line)
    op = case["op"]
    try:
        if op == "html":
            parser = transport._Text(); parser.feed(case["text"]); value = {"value": "\n".join(parser.parts)}
        elif op == "unescape":
            import html; value = {"value": html.unescape(case["text"])}
        elif op == "url":
            try: parsed, host = transport._parse_https_url(case["url"], allow_query=case["query"]); value = {"value": [host, parsed.path, parsed.query]}
            except transport.NetworkError as exc: value = {"value": exc.as_result()}
        elif op == "ip":
            try: ip = ipaddress.ip_address(case["value"]); value = {"value": [str(ip), ip.is_global]}
            except ValueError: value = {"value": None}
        elif op == "idna":
            try: value = {"value": case["host"].encode("idna").decode("ascii")}
            except UnicodeError: value = {"value": None}
        elif op == "tool":
            value = run_tool(case)
        else:
            value = {"value": [tool.schema() | {"gate": tool.gate_kind, "mutating": tool.mutating, "concurrency": tool.concurrency_safe, "subject": tool.approval_subject({"url": "u", "query": "q"})} for tool in tooling.REGISTRY]}
    except Exception as exc:
        value = {"error": type(exc).__name__, "message": str(exc)}
    out.append(value)
sys.stdout.write(json.dumps(out, ensure_ascii=True))
`;

export interface HttpSpec { status?: number; contentType?: string | null; body?: string; error?: string; readError?: string }
export interface ToolCase { tool: "web_fetch" | "web_search" | "image_search"; args: Record<string, unknown>; files?: Record<string, string>; env?: Record<string, string>; dns?: Record<string, string[] | string>; http?: Record<string, HttpSpec>; deny?: boolean; clockStep?: number }
export type OracleCase = { op: "html" | "unescape"; text: string } | { op: "url"; url: unknown; query: boolean } | { op: "ip"; value: unknown } | { op: "idna"; host: string } | ({ op: "tool" } & ToolCase) | { op: "tools" };
export interface OracleResult { value?: any; result?: string; checks?: [string, string][]; lookups?: string[]; requests?: unknown[]; error?: string; message?: string }

export function pythonNetwork(cases: OracleCase[]): OracleResult[] {
  return JSON.parse(runPython(CODE, cases.map((item) => JSON.stringify(item)).join("\n"))) as OracleResult[];
}

const CODES: Record<string, string> = { EAI_AGAIN: "EAI_AGAIN", EAI_NONAME: "ENOTFOUND", EAI_NODATA: "ENOTFOUND", EAI_FAIL: "EAI_FAIL", OSError: "EIO" };
const FAILURES: Record<string, string> = { timeout: "ETIMEDOUT", cert: "CERT_HAS_EXPIRED", ssl: "EPROTO", http: "HPE_INVALID_CONSTANT", os: "ECONNRESET" };
const coded = (code: string): Error => Object.assign(new Error(code), { code });

/** The TS side of a scripted case: the same answers, the same recorded exchanges. */
export function scriptedNet(script: Pick<ToolCase, "dns" | "http">): Net & { lookups: string[]; requests: unknown[] } {
  const lookups: string[] = [], requests: unknown[] = [];
  return { lookups, requests,
    async lookup(host) {
      lookups.push(host);
      const answer = script.dns?.[host] ?? "EAI_NONAME";
      if (typeof answer === "string") throw coded(CODES[answer]!);
      return answer;
    },
    async request(exchange: HttpExchange): Promise<HttpResponse> {
      requests.push({ host: exchange.host, address: exchange.address, method: exchange.method, path: exchange.path, headers: exchange.headers, body: exchange.body ? exchange.body.toString("utf8") : null, timeout: exchange.timeoutMs / 1000 });
      const spec = script.http?.[exchange.host + " " + exchange.path.split("?", 1)[0]] ?? script.http?.[exchange.host] ?? { error: "os" };
      if (spec.error) throw coded(FAILURES[spec.error]!);
      return { status: spec.status ?? 200, contentType: spec.contentType === null ? "" : spec.contentType ?? "text/plain",
        async read(limit) { if (spec.readError) throw coded(FAILURES[spec.readError]!); return Buffer.from(spec.body ?? "", "base64").subarray(0, limit); }, close() {} };
    } };
}
