// Critères de la feature ci-durcie : les workflows de `.github/workflows/`
// n'accordent au GITHUB_TOKEN que la lecture, chaque job a un plafond de durée,
// chaque action est épinglée par le sha de son commit, et `.github/dependabot.yml`
// tient ces épingles, la crate mem0-rs et les images de conteneur à jour — sans
// npm, dont les outils sont installés à une version exacte par les scripts.
//
// Lecture structurelle : les jobs sont les clés à deux espaces sous `jobs:`, les
// clés d'un job celles à quatre espaces ; dependabot.yml est découpé par entrée
// `- package-ecosystem:`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { usesParMajeure } from "../support/workflows.ts";

const WORKFLOWS_DIR = path.join(ROOT, ".github", "workflows");
const WORKFLOWS = fs
  .readdirSync(WORKFLOWS_DIR)
  .filter((nom) => nom.endsWith(".yml"))
  .sort();
const lire = (nom: string) => fs.readFileSync(path.join(WORKFLOWS_DIR, nom), "utf8");
/** Le YAML sans ses lignes de commentaire. */
const sansCommentaires = (yaml: string) => yaml.replace(/^\s*#.*$\n?/gm, "");

/** Les jobs d'un workflow : identifiant → texte du job, sans commentaires. */
function jobs(yaml: string): Map<string, string> {
  const corps = sansCommentaires(yaml).split(/^jobs:\s*$/m)[1] ?? "";
  const out = new Map<string, string>();
  for (const morceau of corps.split(/^(?= {2}[A-Za-z0-9_-]+:$)/m)) {
    const id = /^ {2}([A-Za-z0-9_-]+):$/m.exec(morceau);
    if (id) out.set(id[1]!, morceau);
  }
  return out;
}

const cleDeJob = (job: string, cle: string) => new RegExp(`^ {4}${cle}:\\s*(.*)$`, "m").exec(job)?.[1] ?? null;

test("ci-durcie/AC-1 : chaque workflow déclare ses permissions avant ses jobs, et check.yml n'accorde que la lecture du contenu", () => {
  assert.ok(WORKFLOWS.includes("check.yml"), WORKFLOWS.join(", "));
  for (const nom of WORKFLOWS) {
    const tete = sansCommentaires(lire(nom)).split(/^jobs:\s*$/m)[0] ?? "";
    assert.match(tete, /^permissions:\n/m, `${nom} : aucun bloc permissions: de premier niveau`);
  }
  const check = sansCommentaires(lire("check.yml"));
  const tete = check.split(/^jobs:\s*$/m)[0] ?? "";
  const bloc = /^permissions:\n((?: {2}.*\n)+)/m.exec(tete)?.[1] ?? "";
  assert.equal(bloc, "  contents: read\n", "check.yml : moindre privilège");
  for (const [id, job] of jobs(check)) {
    assert.equal(cleDeJob(job, "permissions"), null, `check.yml › ${id} : permissions élargies au niveau du job`);
  }
});

test("ci-durcie/AC-2 : chaque job a un plafond de durée, et ceux dont release.ts attend les statuts finissent avant son budget d'attente", () => {
  const release = lire("release.yml");
  const budget = Number(/--merge-timeout (\d+)/.exec(release)?.[1]);
  assert.ok(budget > 0, "--merge-timeout introuvable dans release.yml");
  for (const nom of WORKFLOWS) {
    for (const [id, job] of jobs(lire(nom))) {
      const plafond = Number(cleDeJob(job, "timeout-minutes"));
      assert.ok(Number.isInteger(plafond) && plafond > 0, `${nom} › ${id} : timeout-minutes absent`);
      assert.ok(plafond <= 60, `${nom} › ${id} : plafond de ${plafond} min`);
      // Les statuts requis d'une PR de release (check.yml, release-simulation.yml)
      // doivent pouvoir aboutir, ou échouer, avant que release.ts n'abandonne.
      if (nom === "check.yml" || nom === "release-simulation.yml") {
        assert.ok(plafond * 60 < budget, `${nom} › ${id} : ${plafond} min ≥ --merge-timeout ${budget} s`);
      }
    }
  }
});

test("ci-durcie/AC-3 : chaque `uses:` est épinglé par un sha de commit de 40 caractères, sa version en commentaire", () => {
  let vus = 0;
  for (const nom of WORKFLOWS) {
    const yaml = lire(nom);
    for (const ligne of yaml.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l))) {
      vus += 1;
      assert.match(
        ligne,
        /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
        `${nom} : action non épinglée par sha : ${ligne.trim()}`,
      );
    }
    // La lecture des gardes ramène chaque épingle à sa majeure, sans en laisser.
    assert.doesNotMatch(usesParMajeure(yaml), /@[0-9a-f]{40}/, nom);
  }
  assert.ok(vus > 0, "aucun uses: lu");
  assert.equal(
    usesParMajeure(`      - uses: actions/cache@${"a".repeat(40)} # v6.1.0\n`),
    "      - uses: actions/cache@v6\n",
  );
});

type Entree = {
  ecosysteme: string;
  dossiers: string[];
  intervalle: string | null;
  limite: number;
  prefixe: string | null;
  groupes: string[];
};

/** Les entrées de .github/dependabot.yml, une par `- package-ecosystem:`. */
function dependabot(): Entree[] {
  const yaml = sansCommentaires(fs.readFileSync(path.join(ROOT, ".github", "dependabot.yml"), "utf8"));
  assert.match(yaml, /^version: 2$/m);
  return yaml
    .split(/^ {2}- package-ecosystem: /m)
    .slice(1)
    .map((bloc) => {
      const seul = /^ {4}directory: (\S+)$/m.exec(bloc)?.[1];
      const liste = /^ {4}directories:\n((?: {6}- .*\n)+)/m.exec(bloc)?.[1] ?? "";
      return {
        ecosysteme: bloc.split("\n")[0]!.trim(),
        dossiers: seul ? [seul] : [...liste.matchAll(/^ {6}- (\S+)$/gm)].map((m) => m[1]!),
        intervalle: /^ {6}interval: (\S+)$/m.exec(bloc)?.[1] ?? null,
        limite: Number(/^ {4}open-pull-requests-limit: (\d+)$/m.exec(bloc)?.[1]),
        prefixe: /^ {6}prefix: (\S+)$/m.exec(bloc)?.[1] ?? null,
        groupes: [...bloc.matchAll(/^ {8}update-types: \[(.*)\]$/gm)].map((m) => m[1]!.replace(/\s/g, "")),
      };
    });
}

/** Les dossiers (`/`, `/a/b`) des fichiers suivis dont le nom satisfait `motif`. */
function dossiersSuivis(motif: RegExp): string[] {
  const r = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const dossiers = r.stdout
    .split("\n")
    .filter((f) => motif.test(path.basename(f)))
    .map((f) => `/${path.dirname(f)}`.replace(/^\/\.$/, "/"));
  return [...new Set(dossiers)].sort();
}

test("ci-durcie/AC-4 : dependabot couvre les actions, la crate mem0-rs, chaque Dockerfile et chaque compose — hebdomadaire, groupé, borné, sans npm ni type qui publie", () => {
  const entrees = dependabot();
  const par = new Map(entrees.map((e) => [e.ecosysteme, e]));
  assert.deepEqual([...par.keys()].sort(), ["cargo", "docker", "docker-compose", "github-actions"]);
  assert.equal(par.size, entrees.length, "un écosystème déclaré deux fois");

  assert.deepEqual(par.get("github-actions")?.dossiers, ["/"]);
  for (const dossier of par.get("cargo")?.dossiers ?? []) {
    assert.ok(fs.existsSync(path.join(ROOT, dossier, "Cargo.lock")), `cargo : ${dossier} sans Cargo.lock`);
  }
  assert.deepEqual(par.get("cargo")?.dossiers, dossiersSuivis(/^Cargo\.toml$/));
  assert.deepEqual([...(par.get("docker")?.dossiers ?? [])].sort(), dossiersSuivis(/^Dockerfile/));
  assert.deepEqual(
    [...(par.get("docker-compose")?.dossiers ?? [])].sort(),
    dossiersSuivis(/^(docker-)?compose\.ya?ml$/),
  );

  for (const e of entrees) {
    assert.equal(e.intervalle, "weekly", e.ecosysteme);
    assert.ok(e.limite >= 1 && e.limite <= 5, `${e.ecosysteme} : open-pull-requests-limit ${e.limite}`);
    // `fix` et `feat` déclencheraient une release (scripts/release.ts) : jamais pour un bump d'outil.
    assert.ok(e.prefixe === "ci" || e.prefixe === "chore", `${e.ecosysteme} : préfixe ${e.prefixe}`);
    assert.deepEqual(e.groupes, ["minor,patch"], `${e.ecosysteme} : mineures et correctifs groupés`);
  }
});
