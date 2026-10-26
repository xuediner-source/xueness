import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fstatSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import koffi from "koffi";
import { NativeFileLocks, SessionStore } from "../src/index.ts";

const sid = "1234567890abcdef1234567890abcdef";
describe("native operating-system locks", () => {
  it("opens POSIX lock descriptors atomically close-on-exec", { skip: process.platform === "win32" ? "POSIX descriptor flags" : false }, async () => {
    const base = mkdtempSync(join(tmpdir(), "xue-native-cloexec-")), locks = new NativeFileLocks();
    try {
      const held = await locks.tryAcquire(base, "cloexec.lock");
      const directory = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";
      const fcntl = koffi.load(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null).func("int fcntl(int, int)");
      const target = statSync(join(base, "cloexec.lock"));
      assert.equal(target.mode & 0o777, 0o600 & ~process.umask(), "openat must receive the private creation mode through its variadic ABI");
      const descriptors = readdirSync(directory).filter((fd) => { try { const actual = fstatSync(Number(fd)); return actual.dev === target.dev && actual.ino === target.ino; } catch { return false; } });
      assert.equal(descriptors.length, 1);
      assert.equal(Number(fcntl(Number(descriptors[0]), 1)) & 1, 1, "FD_CLOEXEC must already be set on the live lock");
      await held.release();
    } finally { await locks.close(); rmSync(base, { recursive: true, force: true }); }
  });
  it("excludes independent providers, releases on close and validates lock names", async () => {
    const base = mkdtempSync(join(tmpdir(), "xue-native-lock-"));
    const a = new NativeFileLocks(), b = new NativeFileLocks();
    try {
      const first = await a.tryAcquire(base, "lease.lock");
      await assert.rejects(b.tryAcquire(base, "lease.lock"), { name: "BlockingIOError" });
      await assert.rejects(b.acquire(base, "lease.lock", 0.02), { name: "TimeoutError" });
      await assert.rejects(a.acquire(base, "../escape", 0), { name: "ValueError" });
      await assert.rejects(a.acquire(base, "ok", -1), { name: "ValueError" });
      const waiting = b.acquire(base, "lease.lock", 1);
      await first.release();
      const second = await waiting;
      await b.close();
      await second.release();
      await (await a.tryAcquire(base, "lease.lock")).release();
      await assert.rejects(b.tryAcquire(base, "x"), { name: "OSError" });
    } finally { await a.close(); await b.close(); rmSync(base, { recursive: true, force: true }); }
  });

  it("releases native locks after abrupt Node process termination", async () => {
    const base = mkdtempSync(join(tmpdir(), "xue-native-exit-"));
    const native = new NativeFileLocks();
    const source = `import { NativeFileLocks } from ${JSON.stringify(new URL("../src/native-locks.ts", import.meta.url).href)};
      await new NativeFileLocks().tryAcquire(process.argv[1], 'crash.lock');
      console.log('held'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, base], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    try {
      const ready = await once(child.stdout, "data", { signal: AbortSignal.timeout(10_000) });
      assert.match(String(ready[0]), /held/);
      await assert.rejects(native.tryAcquire(base, "crash.lock"), { name: "BlockingIOError" });
      child.kill();
      await exited;
      await (await native.acquire(base, "crash.lock", 1)).release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      await native.close(); rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses directory redirects, including Windows junctions", async () => {
    const base = mkdtempSync(join(tmpdir(), "xue-native-link-"));
    const locks = new NativeFileLocks();
    try {
      symlinkSync(base, join(base, "redirect"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(locks.tryAcquire(join(base, "redirect"), "outside.lock"));
      await assert.rejects(locks.tryAcquire(base, "redirect"));
    } finally { await locks.close(); rmSync(base, { recursive: true, force: true }); }
  });

  it("publishes Windows journals with protected private ACLs", { skip: process.platform !== "win32" }, async () => {
    const base = mkdtempSync(join(tmpdir(), "xue-native-acl-"));
    try {
      const store = new SessionStore(base);
      const session = await store.new("private", base, { sessionId: sid });
      session.task = "private revision";
      await store.save(session);
      const command = "$ErrorActionPreference='Stop'; $a=[System.IO.File]::GetAccessControl($env:XUENESS_ACL_TEST_PATH); $owner=([System.Security.Principal.NTAccount]$a.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value; [pscustomobject]@{Protected=$a.AreAccessRulesProtected; OwnerSid=$owner; Rules=@($a.Access | ForEach-Object { [pscustomobject]@{Sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; Inherited=$_.IsInherited; Type=[string]$_.AccessControlType; Rights=[string]$_.FileSystemRights} })} | ConvertTo-Json -Depth 5 -Compress";
      for (const path of [store.pathFor(sid), store.pathFor(sid) + ".bak", join(base, `${sid}.history.jsonl`)]) {
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, env: { ...process.env, XUENESS_ACL_TEST_PATH: path } });
        assert.equal(result.status, 0, `${path}: ${result.stderr}`);
        const acl = JSON.parse(result.stdout);
        assert.equal(acl.Protected, true, path);
        assert.equal(acl.Rules.length, 3, path);
        assert(acl.Rules.every((r: { Inherited: boolean; Type: string; Rights: string }) => !r.Inherited && r.Type === "Allow" && r.Rights === "FullControl"), path);
        assert.deepEqual(acl.Rules.map((r: { Sid: string }) => r.Sid).sort(),
          [acl.OwnerSid, "S-1-5-18", "S-1-5-32-544"].sort(), path);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
