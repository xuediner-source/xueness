/** Inputs for `helpers-differential.test.ts`; every value must survive a JSON round trip. */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBase64(count: number): string[] {
  const random = mulberry32(20261018);
  const alphabet = ["A", "B", "Q", "g", "w", "/", "+", "0", "9", "=", "=", "=", " ", "\n", "-", "_", "é", "*"];
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = Math.floor(random() * 11);
    let text = "";
    for (let char = 0; char < length; char += 1) {
      // Mostly valid digits so that padding rules, not just bad digits, are exercised.
      text += random() < 0.8 ? (alphabet[Math.floor(random() * 10)] as string) : (alphabet[Math.floor(random() * alphabet.length)] as string);
    }
    out.push(text);
  }
  return out;
}

const CALL = { id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } };

export const CORPUS = {
  b64: ["", "QQ==", "QUI=", "QUJD", "QQ", "QQ=", "Q===", "=QQ", "QQ==QQ==", "QQ==\n", "Q Q==", "QUJD=", "QUJDRA",
    "QUJDRA=", "QUJDRA==", "QUJDR", "iVBORw0KGgo=", "-_8=", "+/8=", "é", "AAAA====", ...randomBase64(400)],
  retry: [null, "", "1", "1.5", "0", "-3", " 2 ", "abc", "nan", "inf", "-inf", "1e2", "0x10", "1_0", "١", "２",
    "Wed, 21 Oct 2015 07:28:00 GMT", "Fri, 31 Dec 9999 23:59:59 GMT", "Wed, 21 Oct 2015 07:28:00", "21 Oct 2015 07:28:00 +0000",
    "Wed, 32 Oct 2015 07:28:00 GMT", "garbage, 21 Oct 2015", "Sun, 06 Nov 1994 08:49:37 GMT", "Sunday, 06-Nov-94 08:49:37 GMT",
    "Sun Nov  6 08:49:37 1994", "Thu, 01 Jan 2099 00:00:00 -0800"],
  urls: ["https://api.example.com/v1", "HTTPS://Example.COM:443/v1/", "http://127.0.0.1:8080/v1;param?x=1#frag",
    "http://[::1]:11434/v1", "http://[::ffff:127.0.0.1]/v1", "https://user:pw@host.example/v1", "https://:pw@host.example",
    "https://user@host.example", "//host.example/path", "http:///path", "api.example.com/v1", "  https://lead.example/v1",
    "https://ex\tample.com/v1\n", "https://host.example/v1?", "https://host.example/v1#", "ftp://files.example",
    "https://[v1.fe]/x", "https://xn--bcher-kva.example/", "https://BÜCHER.example/", "http://127.0.0.1:99999/v1",
    "https://host.example:abc/v1", "file:///etc/passwd", "https://%75ser@host.example", "https://host.example\\path"],
  loopback: ["127.0.0.1", "127.255.255.254", "127.0.0.01", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "::1",
    "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "[::1]", "::1%lo", "fe80::1%eth0",
    "localhost", "1.2.3.4", "::", "", "127.0.0.1.", " 127.0.0.1", "::127.0.0.1", "0000:0000:0000:0000:0000:0000:0000:0001",
    "::0:1", "1::", "::ffff:127.0.0.256", "12345::1"],
  lw_options: [[{}, "openai"], [{ stepLimit: 10 }, "openai"], [{ stepLimit: true }, "openai"], [{ stepLimit: 10.5 }, "openai"],
    [{ stepLimit: 0 }, "openai"], [{ temperature: 1 }, "openai"], [{ temperature: "1" }, "openai"], [{ temperature: 0.5 }, "anthropic"],
    [{ topP: 0 }, "openai"], [{ topP: 1 }, "openai"], [{ overflowRetryRatio: 0.25 }, "openai"], [{ overflowRetryRatio: 0.9 }, "openai"],
    [{ initialTools: "core" }, "openai"], [{ initialTools: "all" }, "openai"], [{ overflowRetry: 1 }, "openai"],
    [{ overflowRetry: false }, "openai"], [{ reserveTokens: 9000 }, "openai"], [{ seed: 2147483647 }, "openai"],
    [{ seed: 2147483648 }, "openai"], [{ bogus: 1 }, "openai"], [[], "openai"], [null, "openai"], [{ wallTimeSeconds: 3600 }, "openai"]],
  effective: [{ value: {} }, { value: {}, context: 2048 }, { value: {}, context: 2048, output: 1024 }, { value: { reserveTokens: 0 }, context: 2048, output: 1792 },
    { value: { reserveTokens: 8192 } }, { value: {}, context: 4096 }, { value: {}, context: 4095 }, { value: { transportRetries: 2 } }],
  compat: [{}, { streamUsage: true }, { streamUsage: 1 }, { parallelToolCalls: false }, { maxTokensField: "max_tokens" },
    { maxTokensField: "max_output_tokens" }, { toolChoice: "auto" }, { toolChoice: "none" }, { think: true }, { think: "no" },
    { unknown: 1 }, [], null, "x"],
  runtime: [[{}, "openai"], [{ runtimeProfile: "lightweight" }, "openai"], [{ runtimeProfile: "lightweight" }, "anthropic"],
    [{ runtimeProfile: "standard", contextWindow: 4096, maxOutputTokens: 2048 }, "openai"],
    [{ runtimeProfile: "lightweight", toolCalling: "json" }, "openai"], [{ runtimeProfile: "lightweight", toolCalling: "json" }, "anthropic"],
    [{ toolCalling: "plain" }, "openai"], [{ contextWindow: true }, "openai"], [{ maxOutputTokens: 127 }, "openai"],
    [{ compatibility: { think: true } }, "openai"], [{ lightweightOptions: { stepLimit: 4 } }, "openai"],
    [{ runtimeProfile: "lightweight", lightweightOptions: { temperature: 0.1 } }, "anthropic"], [{ runtimeProfile: 7 }, "openai"],
    [[], "openai"]],
  native: [[{ content: "x" }, []], [{ content: "x", tool_calls: null }, []], [{ content: "x", tool_calls: {} }, []],
    [{ content: "x", tool_calls: [CALL] }, []], [{ content: "x", tool_calls: [CALL] }, ["c1"]], [{ content: "x", tool_calls: [CALL, CALL] }, []],
    [{ content: "", tool_calls: [{ ...CALL, id: "" }] }, []], [{ content: "", tool_calls: [{ ...CALL, type: "tool" }] }, []],
    [{ content: "", tool_calls: [{ ...CALL, function: { name: "", arguments: "{}" } }] }, []],
    [{ content: "", tool_calls: [{ ...CALL, function: { name: "read", arguments: { path: "a", n: 1.5 } } }] }, []],
    [{ content: "", tool_calls: [{ ...CALL, function: { name: "read", arguments: 5 } }] }, []],
    [{ content: "", tool_calls: [{ ...CALL, function: { name: "read" } }] }, []], [{ content: "", tool_calls: ["x"] }, []],
    [{ content: "日本語 😀", tool_calls: 3 }, []], [{ content: null, tool_calls: "x" }, []], ["string", []],
    [{ content: "", tool_calls: [{ ...CALL, function: { name: "read", arguments: "not json" } }] }, []]],
  envelope: ["{\"a\":1}", "  {\"a\":1}  ", "\ufeff{\"a\":1}", "```json\n{\"a\":1}\n```", "```JSON \r\n{\"a\":1}\r\n```",
    "```\n{\"a\":1}\n```", "```json{\"a\":1}```", "```json\n{\"a\":1}\n```\nextra", "text ```json\n{}\n```", "```json\n\n```",
    "```json\n  {\"a\":1}  \n```", " \ufeff ```json\n{}\n```"],
  strict_json: ["{\"a\":1}", "{\"a\":1,\"a\":2}", "{\"a\":NaN}", "{\"a\":Infinity}", "[1,2]", "{", "", "  {\"b\": {\"c\": 1, \"c\": 1}}",
    "1e400", "\"\\ud800\"", "{\"a\": -0}"],
  usage: [[{ role: "assistant", content: "x" }, {}],
    [{ content: "x", _usage: { spoof: 1 }, _finish_reason: "spoof" }, { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }],
    [{ content: "x" }, { model: "gpt-x", usage: { prompt_tokens: -1, completion_tokens: true, total_tokens: 1.5,
      prompt_tokens_details: { cached_tokens: 2, other: 3 } } }],
    [{ content: "x" }, { choices: [{ finish_reason: "length" }] }], [{ content: "x" }, { choices: [{ finish_reason: "weird" }] }],
    [{ content: "x" }, { stop_reason: "max_tokens", usage: { input_tokens: 4, output_tokens: 6 } }],
    [{ content: "x" }, { choices: ["bad"], stop_reason: "end_turn" }], ["not a dict", {}],
    [{ content: "x" }, { usage: { prompt_tokens: 1e300, completion_tokens: 2 ** 53, total_tokens: 7 } }],
    [{ content: "x" }, { model: ["list"], usage: "none" }]],
};
