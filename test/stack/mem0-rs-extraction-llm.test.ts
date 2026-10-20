// Test de câblage de mem0-rs-extraction-llm (S-8) : ce que ni `cargo test` ni le
// contrat boîte noire ne peuvent constater de l'intérieur.
//
// - AC-7 : la section `rust` de scripts/check.sh joue le groupe infer=true du
//   contrat contre mem0-rs (sans MEM0_CONTRAT_INFER=0) et échoue quand un cas
//   infer échoue. La faute est injectée par une enveloppe du binaire qui lui
//   impose un modèle chat autre que celui du contrat : le cas AC-2, qui compare
//   la requête chat reçue par le faux OpenAI, échoue, et seul le groupe infer
//   appelle chat/completions.
//
// Le test lourd (cargo, vrais serveurs) ne tourne qu'au premier niveau
// (`MEM0_CHECK_DEPTH` 0) : une copie jetable du dépôt ne le rejoue pas. cargo
// manquant est un saut annoncé, ou un échec sous MEM0_OMP_REQUIRE_RUST=1.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { prerequisAbsent } from "../support/prerequis.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

/** Profondeur d'imbrication : 0 = suite lancée à la main ou par check.sh racine. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

/** Délai d'un test qui compile la crate ou démarre de vrais serveurs. */
const DELAI_LOURD = 1_200_000;

/**
 * Environnement d'un enfant : celui du processus, sans les marqueurs de
 * travailleur de `node:test`, sans aucune `MEM0_CONTRAT_*` héritée de l'opérateur
 * ni de binaire mem0-rs imposé (`MEM0_RS_BIN`) — seules les variables posées par
 * le test comptent.
 */
function envEnfant(poses: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [cle, valeur] of Object.entries(process.env)) {
    if (valeur === undefined) continue;
    if (cle === "NODE_TEST_CONTEXT" || cle === "NODE_TEST_WORKER_ID" || cle === "MEM0_RS_BIN") continue;
    if (cle.startsWith("MEM0_CONTRAT_")) continue;
    env[cle] = valeur;
  }
  return { ...env, ...poses };
}

type Resultat = { code: number | null; sortie: string };

/** `bash <args>` dans `cwd`, asynchrone, stdout et stderr mêlés. */
function lancer(args: string[], env: Record<string, string>, cwd = ROOT): Promise<Resultat> {
  const fin = Promise.withResolvers<Resultat>();
  const enfant = spawn("bash", args, { cwd, env });
  let sortie = "";
  const collecter = (morceau: Buffer): void => {
    sortie += morceau.toString("utf8");
  };
  enfant.stdout.on("data", collecter);
  enfant.stderr.on("data", collecter);
  enfant.on("error", fin.reject);
  enfant.on("close", (code) => fin.resolve({ code, sortie }));
  return fin.promise;
}

/** Pièce manquante : échec sous le REQUIRE donné (CI), saut annoncé sinon. */
function manque(t: TestContext, prerequis: string, consequence: string, exige: boolean): void {
  prerequisAbsent(t, prerequis, consequence, exige ? "MEM0_OMP_REQUIRE_RUST=1" : null);
}

const cargoPresent = (): boolean => spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;

test("mem0-rs-extraction-llm/AC-7 : la section rust joue le groupe infer contre mem0-rs et échoue quand un cas infer échoue", { timeout: DELAI_LOURD }, async (t) => {
  if (DEPTH !== 0) {
    t.skip(`cargo à la racine seulement (MEM0_CHECK_DEPTH=${DEPTH})`);
    return;
  }
  if (!cargoPresent()) {
    manque(t, "cargo", "section rust non exécutée", process.env.MEM0_OMP_REQUIRE_RUST === "1");
    return;
  }

  // Le binaire que la section rust construit, lancé avec un modèle chat qui n'est
  // pas celui que le contrat attend : le cas AC-2, qui compare la requête chat
  // reçue par le faux OpenAI (modèle compris), échoue ; les autres groupes
  // n'appellent pas chat/completions.
  const cible = process.env.CARGO_TARGET_DIR || path.join(ROOT, "mem0-stack", "mem0-rs", "target");
  const binaire = path.join(path.resolve(ROOT, cible), "debug", "mem0-rs");
  const enveloppe = path.join(tmpdir("mem0-rs-ac7-"), "mem0-rs-fautif");
  fs.writeFileSync(enveloppe, `#!/usr/bin/env bash\nOMLX_LLM_MODEL=modele-fautif exec "${binaire}" "$@"\n`, { mode: 0o755 });

  const r = await lancer(
    ["scripts/check.sh", "--sections=rust"],
    envEnfant({ MEM0_OMP_SKIP_RUST: "", MEM0_OMP_REQUIRE_RUST: "", MEM0_RS_BIN: enveloppe }),
  );
  assert.equal(r.code, 1, r.sortie);
  assert.ok(
    r.sortie.includes("FAIL  ouvert/infer · mem0-rs-extraction-llm AC-2 · requête chat identique : système, invite, modèle et paramètres"),
    r.sortie,
  );
  assert.ok(r.sortie.includes("  ✗ Rust mem0-rs — contrat boîte noire contre mem0-rs en échec"), r.sortie);
  assert.ok(r.sortie.split("\n").some((ligne) => ligne.startsWith("PASS  ouvert/suppression · ")), r.sortie);
  assert.ok(!r.sortie.includes("groupe infer=true désactivé"), r.sortie);
});
