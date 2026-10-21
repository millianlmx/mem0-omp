// Feature harness-install : ce que install.sh pose en plus du service — omp à la
// version de l'app Mac, vérifié contre des empreintes épinglées, la clé SSH du
// service et `omp-harness-check`. Séparé de harness-deploy : ce fichier lit le
// manifeste Swift de l'app, donc tourne aussi sur macOS, où le lanceur root (GNU
// realpath) n'a pas cours.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";

const DEPLOY = path.join(ROOT, "omp-harness", "deploy");
const read = (name: string) => fs.readFileSync(path.join(DEPLOY, name), "utf8");
const directive = (text: string, key: string) => new RegExp(`^${key}=(.+)$`, "m").exec(text)?.[1]?.trim() ?? null;

test("harness-install/AC-1 : install.sh pose omp à la version de l'app Mac, vérifié contre des empreintes épinglées, la clé SSH du service et `omp-harness-check`", () => {
  const install = read("install.sh");
  const manifest = fs.readFileSync(
    path.join(ROOT, "omp-console/Sources/OMPConsole/Setup/ComponentManifest.swift"),
    "utf8",
  );
  const macVersion = /ompVersion: "([^"]+)"/.exec(manifest)?.[1];
  assert.equal(directive(install, "OMP_VERSION"), macVersion, "le VPS et le Mac font tourner le même omp");
  for (const asset of ["omp-linux-x64", "omp-linux-arm64"])
    assert.match(install, new RegExp(`OMP_ASSET=${asset}; OMP_SHA256=[0-9a-f]{64} ;;`), asset);
  assert.match(install, /sha256sum -c --quiet -/, "le binaire est vérifié avant d'être posé");
  assert.doesNotMatch(install, /SHA256SUMS/, "jamais l'empreinte publiée à côté du binaire");
  assert.match(
    install,
    /sudo -u omp-harness ssh-keygen -q -t ed25519 -N '' .* -f \/var\/lib\/omp-harness\/\.ssh\/id_ed25519/,
  );
  assert.match(install, /StrictHostKeyChecking accept-new/);
  assert.match(install, /install -m 0755 "\$HERE\/omp-harness-check" \/usr\/local\/bin\/omp-harness-check/);
  const check = read("omp-harness-check");
  assert.match(check, /sudo -u omp-harness -H/);
  assert.match(check, /\. \/etc\/omp-harness\/env/, "le jeton de mem0 du service, pour sonder l'oracle");
  assert.ok(
    check.includes(`${directive(read("omp-harness.service"), "ExecStart")} --check`),
    "la même ligne que le service, plus --check",
  );
});
