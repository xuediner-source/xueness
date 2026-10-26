/** Assert the real platform permission boundary of a secret-bearing test file. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

export function assertPrivateFile(path: string): void {
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    return;
  }
  // Read the NTFS DACL, rather than Node's emulated POSIX mode bits on Windows.
  const script = `
    $ErrorActionPreference = 'Stop'
    $acl = [System.IO.File]::GetAccessControl($env:XUENESS_ACL_TEST_FILE)
    $rules = @($acl.Access | ForEach-Object {
      @{ Sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;
         Type = [string]$_.AccessControlType; Inherited = $_.IsInherited; Rights = [int]$_.FileSystemRights }
    })
    @{ Protected = $acl.AreAccessRulesProtected;
       Owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
       Rules = $rules } | ConvertTo-Json -Depth 4 -Compress
  `;
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, XUENESS_ACL_TEST_FILE: path },
  });
  const acl = JSON.parse(raw.replace(/^\uFEFF/, "")) as {
    Protected: boolean; Owner: string; Rules: { Sid: string; Type: string; Inherited: boolean; Rights: number }[];
  };
  assert.equal(acl.Protected, true, "private file must refuse inherited grants");
  const allowed = new Set([acl.Owner, "S-1-5-18", "S-1-5-32-544"]);
  assert.deepEqual(new Set(acl.Rules.map((rule) => rule.Sid)), allowed);
  for (const rule of acl.Rules) {
    assert.equal(rule.Type, "Allow");
    assert.equal(rule.Inherited, false);
    assert.equal(rule.Rights & 0x1f01ff, 0x1f01ff, "owner, SYSTEM and Administrators require full control");
  }
}
