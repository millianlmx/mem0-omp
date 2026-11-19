// DIAGNOSTIC JETABLE — à supprimer.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ROOT, listTestFiles } from "./support/repo.ts";

test("zz-diag : détail des échecs", () => {
  // /tmp exécutable ?
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zzdiag-"));
  const s = path.join(d, "x");
  fs.writeFileSync(s, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  const ex = spawnSync(s, [], { encoding: "utf8" });
  const mounts = spawnSync("sh", ["-c", "grep ' /tmp ' /proc/mounts; id -u"], { encoding: "utf8" }).stdout;
  const files = listTestFiles(ROOT).filter((f) => !f.includes("zz-diag") && !f.includes("renommage-memoire.test"));
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--test", "--test-concurrency=3", "--test-reporter=tap", ...files],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 29, timeout: 1500_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  const lines = (r.stdout ?? "").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]!);
    if (!m) continue;
    const buf: string[] = [];
    for (let j = i + 1; j < Math.min(i + 40, lines.length) && buf.length < 4; j++) {
      if (/^\s*(stack|code|name|expected|actual|operator):/.test(lines[j]!)) break;
      if (/^\s*(---|duration_ms|type|location|failureType|error:)/.test(lines[j]!)) continue;
      if (lines[j]!.trim() === "") continue;
      buf.push(lines[j]!.trim().slice(0, 100));
    }
    if (/non exécuté|macOS/.test(buf.join(" "))) continue;
    out.push(`## ${m[1]!.slice(0, 60)}\n  ${buf.join("\n  ")}`);
  }
  const head = `exec tmp: status=${ex.status} err=${ex.error?.message}; mounts=${mounts.trim()}; spawn: err=${r.error?.message} status=${r.status} stdout=${(r.stdout ?? "").length}`;
  assert.fail(`${head}\n${out.join("\n")}`);
});
