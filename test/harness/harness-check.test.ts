// Feature harness-check : `main.ts --check` vérifie l'installation point par point —
// omp, modèles, oracle, jeton, chaque dépôt et son accès en écriture au distant — et
// donne pour chaque manque le geste qui le corrige. Il ne modifie rien.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderChecks, runChecks } from "../../omp-harness/check.ts";
import { Git } from "../../omp-harness/git.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { git, harnessRepo, testConfig } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

/** Un faux `omp` qui répond à --version comme le vrai binaire. */
function fakeOmp(): string {
  const file = path.join(tmpdir("harness-check-omp-"), "omp");
  fs.writeFileSync(file, "#!/bin/sh\necho omp/18.6.0\n", { mode: 0o755 });
  return file;
}

/** Le clone du harness, avec un distant nu poussable (`origin`). */
function cloneWithRemote(): { clone: string; remote: string } {
  const source = harnessRepo("harness-check-src-");
  const remote = path.join(tmpdir("harness-check-remote-"), "remote.git");
  git(source, "clone", "-q", "--bare", source, remote);
  const clone = path.join(tmpdir("harness-check-clone-"), "demo.git");
  git(source, "clone", "-q", "--bare", remote, clone);
  return { clone, remote };
}

function deps(config: ReturnType<typeof testConfig>, healthy = true) {
  return {
    exec: execProcess,
    git: new Git(execProcess, config.git),
    oracleHealth: async () => healthy,
    env: { HOME: "/var/lib/omp-harness" },
  };
}

test("harness-check/AC-1 : une installation complète passe — omp, modèles, oracle, clone et écriture sur le distant — sans rien pousser", async () => {
  const { clone, remote } = cloneWithRemote();
  const config = testConfig(clone, (c) => {
    c.ompBin = fakeOmp();
    c.models.standard = [{ provider: "anthropic", model: "claude-sonnet-5-5" }];
    c.models.heavy = [{ provider: "anthropic", model: "claude-opus-5-5" }];
    c.oracle = { url: "http://127.0.0.1:8321", token: null };
    (c.repos[0] as { remote: string | null }).remote = "origin";
  });
  const before = git(remote, "for-each-ref", "--format=%(refname)");
  const lines = await runChecks(config, deps(config));
  const report = renderChecks(lines);
  assert.ok(
    lines.every((line) => line.status !== "fail"),
    report,
  );
  assert.match(report, /✓ omp : omp\/18\.6\.0/);
  assert.match(report, /✓ modèles : req heavy, specs heavy, impl standard/);
  assert.match(report, /✓ dépôt demo — écriture sur origin : authentifiée/);
  assert.equal(git(remote, "for-each-ref", "--format=%(refname)"), before, "l'essai à blanc ne pousse rien");
});

test("harness-check/AC-2 : chaque manque est un ✗ avec son geste — omp absent, oracle muet, distant injoignable, clone absent", async () => {
  const { clone } = cloneWithRemote();
  const config = testConfig(clone, (c) => {
    c.ompBin = "/nonexistent/omp";
    c.oracle = { url: "http://127.0.0.1:8321", token: null };
    (c.repos[0] as { remote: string | null }).remote = "nulle-part";
    c.repos.push({
      ...(c.repos[0] as (typeof c.repos)[number]),
      name: "absent",
      path: path.join(tmpdir("harness-check-none-"), "x.git"),
    });
  });
  const lines = await runChecks(config, deps(config, false));
  const failed = lines.filter((line) => line.status === "fail").map((line) => line.label);
  assert.deepEqual(failed, ["omp", "mémoire (oracle)", "dépôt demo — lecture de nulle-part", "dépôt absent — clone"]);
  const report = renderChecks(lines);
  assert.match(report, /→ Debian : relance `sudo bash omp-harness\/deploy\/install\.sh`/);
  assert.match(
    report,
    /→ Ajoute \/var\/lib\/omp-harness\/\.ssh\/id_ed25519\.pub comme clé de déploiement AVEC écriture/,
  );
  assert.match(report, /→ sudo -u omp-harness git clone --bare <url> /);
  // Sans modèles déclarés : un avertissement, pas un échec.
  assert.equal(lines.find((line) => line.label === "modèles")?.status, "warn");
});
