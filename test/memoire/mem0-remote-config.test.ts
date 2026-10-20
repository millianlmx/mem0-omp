// Config du client omp-mem0-memory face à la mémoire hébergée du VPS (S-7 ; AC-7) :
// `mem0-remote.json` ({version:1, url, token}) remplace l'environnement absent, jamais
// l'inverse ; il pose `Authorization: Bearer` à la place de `x-mem0-token` ; un fichier
// inutilisable est ignoré avec un avertissement unique, muet sous MEM0_QUIET.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMem0Endpoint } from "../../omp-mem0-memory/config.ts";

const CONFIG = path.resolve(import.meta.dirname, "../../omp-mem0-memory/config.ts");

function agentDir(contenu: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-remote-config-"));
  if (contenu !== undefined) fs.writeFileSync(path.join(dir, "mem0-remote.json"), typeof contenu === "string" ? contenu : JSON.stringify(contenu));
  return dir;
}

const VALIDE = { version: 1, url: "http://100.64.0.1:8787/v1/mem0/", token: "bearer-d-un-appareil" };
const LOCAL = "http://localhost:8321";

test("mem0-remote-config/AC-7 : mem0-remote.json fournit l'URL du proxy (sans barre finale) et le Bearer, à la place de x-mem0-token", () => {
  const endpoint = resolveMem0Endpoint({ PI_CODING_AGENT_DIR: agentDir(VALIDE), MEM0_HTTP_TOKEN: "jeton-local-ignore" });
  assert.deepEqual(endpoint, { url: "http://100.64.0.1:8787/v1/mem0", authHeaders: { Authorization: "Bearer bearer-d-un-appareil" }, warning: null });
});

test("mem0-remote-config/AC-7 : l'environnement prime sur le fichier ; le fichier est cherché dans ~/.omp/agent sans PI_CODING_AGENT_DIR", () => {
  const dir = agentDir(VALIDE);
  assert.deepEqual(resolveMem0Endpoint({ PI_CODING_AGENT_DIR: dir, MEM0_HTTP_URL: "http://127.0.0.1:9999", MEM0_HTTP_TOKEN: "t" }), {
    url: "http://127.0.0.1:9999",
    authHeaders: { "X-Mem0-Token": "t" },
    warning: null,
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-remote-home-"));
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "mem0-remote.json"), JSON.stringify(VALIDE));
  assert.equal(resolveMem0Endpoint({}, home).url, "http://100.64.0.1:8787/v1/mem0");
});

test("mem0-remote-config/AC-7 : sans fichier ni environnement, mem0 local ; sans avertissement", () => {
  assert.deepEqual(resolveMem0Endpoint({ PI_CODING_AGENT_DIR: agentDir(undefined) }), { url: LOCAL, authHeaders: {}, warning: null });
  assert.deepEqual(resolveMem0Endpoint({ PI_CODING_AGENT_DIR: agentDir(undefined), MEM0_HTTP_TOKEN: "t" }).authHeaders, { "X-Mem0-Token": "t" });
});

test("mem0-remote-config/AC-7 : un fichier inutilisable est ignoré avec sa raison, le poste retombe sur mem0 local", () => {
  const cas: [unknown, string][] = [
    ["{pas du json", "JSON invalide"],
    [[], "objet JSON attendu"],
    [{ ...VALIDE, version: 2 }, "version 1 attendue"],
    [{ ...VALIDE, url: "ftp://x" }, "url http(s) attendue"],
    [{ ...VALIDE, url: 12 }, "url http(s) attendue"],
    [{ ...VALIDE, token: "" }, "token absent"],
    [{ version: 1, url: VALIDE.url }, "token absent"],
  ];
  for (const [contenu, raison] of cas) {
    const endpoint = resolveMem0Endpoint({ PI_CODING_AGENT_DIR: agentDir(contenu) });
    assert.equal(endpoint.warning, `mem0-remote.json illisible : ${raison}`, JSON.stringify(contenu));
    assert.equal(endpoint.url, LOCAL);
    assert.deepEqual(endpoint.authHeaders, {});
  }
});

/** Charge config.ts dans un processus neuf avec un fichier invalide : ce que le processus écrit sur stderr. */
async function stderrDuChargement(env: Record<string, string>): Promise<string> {
  const enfant = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `await import(${JSON.stringify(CONFIG)}); await import(${JSON.stringify(CONFIG)});`], {
    env: { PATH: process.env.PATH ?? "", PI_CODING_AGENT_DIR: agentDir("{pas du json"), ...env },
  });
  let stderr = "";
  enfant.stderr.on("data", (m: Buffer) => (stderr += m.toString("utf8")));
  const fin = Promise.withResolvers<void>();
  enfant.on("close", () => fin.resolve());
  await fin.promise;
  return stderr;
}

test("mem0-remote-config/AC-7 : l'avertissement du fichier illisible est émis une seule fois par processus, et muet sous MEM0_QUIET", async () => {
  const bruyant = await stderrDuChargement({});
  assert.equal(bruyant.match(/mem0-remote\.json illisible : JSON invalide/gu)?.length, 1, bruyant);
  const muet = await stderrDuChargement({ MEM0_QUIET: "1" });
  assert.doesNotMatch(muet, /mem0-remote\.json/u);
});
