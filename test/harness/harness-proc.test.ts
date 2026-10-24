// Feature harness-proc : un process lancé par le service (git, gh, docker, un job de
// tests) ne retient jamais son appelant — un délai ou un arrêt tue tout son groupe,
// petits-enfants compris, et un descendant qui garde ses sorties ne bloque pas l'issue.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { CLOSE_GRACE_MS, execProcess } from "../../omp-harness/proc.ts";

/** Le process `pid` vit-il encore ? Un zombie (tué, pas encore récolté par init) ne vit plus. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return stat !== "" && !stat.startsWith("Z");
}

/** Attend la fin de `pid`. */
async function gone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (alive(pid)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/** Le pid du petit-enfant, que le shell écrit en première ligne. */
function grandchild(stdout: string): number {
  const pid = Number(stdout.split("\n")[0]);
  assert.ok(Number.isInteger(pid) && pid > 0, `pid du petit-enfant illisible : ${stdout}`);
  return pid;
}

// Le petit-enfant hérite de stdout : sans tuer le groupe, `close` attendrait ses 30 s.
const HOLDER = "sleep 30 & echo $!; wait";

test("harness-proc/AC-1 : un délai dépassé tue le groupe entier — le petit-enfant qui garde stdout meurt et l'issue `timedOut` arrive tout de suite", async () => {
  const started = Date.now();
  const result = await execProcess("sh", ["-c", HOLDER], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.ok(Date.now() - started < 10_000, `issue rendue en ${Date.now() - started} ms`);
  assert.ok(await gone(grandchild(result.stdout)), "le petit-enfant est tué avec son parent");
});

test("harness-proc/AC-2 : un arrêt demandé (signal) tue le groupe entier — l'issue `aborted` n'attend pas le petit-enfant", async () => {
  const stop = new AbortController();
  const lines: string[] = [];
  const pending = execProcess("sh", ["-c", HOLDER], {
    signal: stop.signal,
    killGraceMs: 200,
    onOutput: (chunk) => lines.push(chunk),
  });
  while (lines.join("").trim() === "") await new Promise((resolve) => setTimeout(resolve, 10));
  const started = Date.now();
  stop.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.ok(Date.now() - started < 10_000, `issue rendue en ${Date.now() - started} ms`);
  assert.ok(await gone(grandchild(result.stdout)), "le petit-enfant est tué avec son parent");
});

test("harness-proc/AC-3 : un process sorti normalement dont un descendant garde stdout rend son issue après le délai de grâce, sortie comprise", async () => {
  const started = Date.now();
  const result = await execProcess("sh", ["-c", "sleep 30 & echo $!; echo fini"]);
  const elapsed = Date.now() - started;
  const pid = grandchild(result.stdout);
  try {
    assert.deepEqual([result.code, result.timedOut, result.aborted], [0, false, false]);
    assert.match(result.stdout, /fini/);
    assert.ok(elapsed >= CLOSE_GRACE_MS - 50 && elapsed < 10_000, `issue rendue en ${elapsed} ms`);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});

test("harness-proc/AC-4 : le process est chef de son propre groupe, jamais celui du service — tuer ce groupe épargne le service", async () => {
  const result = await execProcess("sh", ["-c", "echo $$; ps -o pgid= -p $$"]);
  const [pid, pgid] = result.stdout.trim().split(/\s+/).map(Number);
  assert.equal(pgid, pid, "pgid = pid : le process mène son groupe");
  const own = Number(spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim());
  assert.notEqual(pgid, own, "le groupe n'est pas celui du service");
});
