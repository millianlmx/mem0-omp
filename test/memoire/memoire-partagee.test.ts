// Feature memoire-partagee : `~/.omp/mem0.json` donne au plugin mémoire, comme à
// l'app OMP Console, l'adresse de la mémoire partagée avec le serveur de pipelines.
// L'environnement l'emporte (les agents du serveur reçoivent le leur), et le jeton du
// fichier ne part jamais vers une autre adresse.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveMem0Target } from "../../omp-mem0-memory/config.ts";
import { tmpdir } from "../support/repo.ts";

function home(settings: unknown): string {
  const dir = tmpdir("memoire-partagee-");
  if (settings !== undefined) {
    fs.mkdirSync(path.join(dir, ".omp"));
    fs.writeFileSync(
      path.join(dir, ".omp", "mem0.json"),
      typeof settings === "string" ? settings : JSON.stringify(settings),
    );
  }
  return dir;
}

test("memoire-partagee/AC-3 : le plugin lit ~/.omp/mem0.json sans MEM0_HTTP_URL ; l'environnement l'emporte, sans jamais recevoir le jeton du fichier", () => {
  const shared = home({ url: "https://vps.tailnet.ts.net:8443/", token: "jeton-vps" });
  assert.deepEqual(resolveMem0Target({}, shared), { url: "https://vps.tailnet.ts.net:8443", token: "jeton-vps" });
  assert.deepEqual(resolveMem0Target({ MEM0_HTTP_URL: "http://127.0.0.1:9000" }, shared), {
    url: "http://127.0.0.1:9000",
    token: "",
  });
  assert.deepEqual(resolveMem0Target({ MEM0_HTTP_TOKEN: "autre" }, shared), {
    url: "https://vps.tailnet.ts.net:8443",
    token: "autre",
  });
  // Pas de fichier, un fichier illisible ou sans adresse : le service local.
  for (const settings of [undefined, "{pas du json", { token: "orphelin" }]) {
    assert.deepEqual(resolveMem0Target({}, home(settings)), { url: "http://localhost:8321", token: "" });
  }
});
