/** The desktop packager builds a fixed executable; end users need no compiler. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

if (process.platform === "darwin") {
  const arch = { arm64: "arm64", x64: "x86_64" }[process.arch];
  if (!arch) throw new Error("Unsupported macOS computer-use build architecture");
  const native = import.meta.dirname;
  const target = join(native, "../../../dist/node_modules/@xueness/plugin-os_cua/native");
  if (!existsSync(join(target, "Worker.swift"))) throw new Error("Build the TypeScript desktop runtime first");
  execFileSync("/usr/bin/xcrun", [
    "swiftc", "-target", arch + "-apple-macosx14.0", "-O", "-parse-as-library",
    ...["Worker.swift", "Windows.swift", "Screen.swift", "Input.swift"].map((file) => join(native, file)),
    "-o", join(target, "xueness-os-cua"),
  ], { stdio: "inherit" });
}
