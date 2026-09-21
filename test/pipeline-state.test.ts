// Tests de l'ÉTAT DES PIPELINES : la cadence de la notice d'échec d'écriture et la
// liste FIGÉE des champs de `running/<id>.json`.
//
// Les deux défauts que ces tests figent (contrat, S-23 et S-24) :
//  1. la notice « état des pipelines non écrit » repartait une fois PAR MAILLON
//     (`armPipeline` réarmait le verrou), alors que le contrat annoncé dit « au
//     plus une fois par session » — la seule frontière de session est le hook
//     `session_start` ;
//  2. le onzième champ du fichier en cours (`version`) n'existait que dans le
//     littéral d'écriture, face à un lecteur (`asRunningEntry`) qui l'exige : la
//     liste écrite et la liste validée pouvaient diverger sans que rien ne le voie.
//
// Le verrou de la notice est un booléen de MODULE : `resetStateWriteWarning` et
// `reportStateWriteFailure` sont exportées pour être exercées directement, et
// l'ordre des scénarios ci-dessous est significatif (le verrou est partagé par le
// fichier). Le magasin est un répertoire RÉEL sous `mkdtempSync`, jamais
// `~/.omp/agent/pipeline`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDirs: string[] = [];
/** Répertoires dont les permissions ont été retirées : à restaurer avant `rm`. */
const readOnlyDirs: string[] = [];

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

// `process.env` est posé AVANT l'import dynamique du module : le magasin d'état et
// le foyer sont des répertoires temporaires, aucun test n'écrit dans le magasin
// réel de la machine. Un `import` statique serait hissé AU-DESSUS de ces
// affectations, donc inutilisable ici — c'est l'exception « frontière de chargement
// de module » qui justifie le `await import()` (motif déjà suivi par
// test/relevance.test.ts).
const stateEnvDir = mktmp("pl-state-");
const homeDir = mktmp("pl-home-");
process.env.MEM0_PIPELINE_STATE_DIR = stateEnvDir;
process.env.HOME = homeDir;

const { armPipeline, readStore, reportStateWriteFailure, resetStateWriteWarning, writeRunningEntry } = await import(
  "../omp-mem0-req/extension.ts"
);

test.after(() => {
  for (const dir of readOnlyDirs) fs.chmodSync(dir, 0o700);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC-24 — au plus une notice par session
// ---------------------------------------------------------------------------

test("pipeline-state/AC-24 : la notice d'échec d'écriture d'état apparaît au plus une fois par session", () => {
  const notices: string[] = [];
  const deps = { notify: (text: string) => notices.push(text) };

  // Deux échecs DISTINCTS dans la même session (le premier à la publication du
  // maillon, le second à sa clôture) : une seule notice, portant la PREMIÈRE
  // raison — la seconde ne doit pas écraser la première.
  resetStateWriteWarning();
  reportStateWriteFailure(deps, new Error("disque plein"));
  reportStateWriteFailure(deps, new Error("permission refusée"));
  assert.equal(notices.length, 1);
  assert.equal(notices[0], "[pipeline] état des pipelines non écrit : disque plein");

  // La frontière de session (`session_start`, seul appelant de
  // `resetStateWriteWarning`) redonne droit à une notice.
  resetStateWriteWarning();
  reportStateWriteFailure(deps, new Error("troisième échec"));
  assert.equal(notices.length, 2);
  assert.equal(notices[1], "[pipeline] état des pipelines non écrit : troisième échec");

  // Non-régression sur `armPipeline` : deux maillons armés successivement dans la
  // MÊME session, avec un magasin inscriptible impossible — une seule notice. Avant
  // le correctif, `armPipeline` réarmait le verrou et la notice repartait par maillon.
  const stateDir = mktmp("pl-readonly-");
  const cwd = mktmp("pl-feature-");
  fs.chmodSync(stateDir, 0o500);
  readOnlyDirs.push(stateDir);
  const armNotices: string[] = [];
  const armDeps = { notify: (text: string) => armNotices.push(text), stateDir };

  resetStateWriteWarning();
  armPipeline(armDeps, cwd, "req");
  armPipeline(armDeps, cwd, "specs");

  assert.equal(armNotices.length, 1);
  assert.ok(
    armNotices[0]?.startsWith("[pipeline] état des pipelines non écrit : "),
    `notice inattendue : ${String(armNotices[0])}`,
  );
  // La raison est celle du disque, pas un texte inventé : elle est non vide.
  assert.ok((armNotices[0]?.split(" : ")[1] ?? "").length > 0);
});

// ---------------------------------------------------------------------------
// AC-25 — liste figée des 11 champs de `running/<id>.json`
// ---------------------------------------------------------------------------

test("pipeline-state/AC-25 : la liste des champs écrits dans running/<id>.json est figée", () => {
  const stateDir = mktmp("pl-store-");
  const entry = {
    id: "0123456789abcdef",
    cwd: path.join(stateDir, "feature"),
    label: "depot/feature",
    phase: "impl" as const,
    state: "running" as const,
    phaseStartedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_060_000,
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session-1",
    owner: { pid: process.pid },
  };

  writeRunningEntry(stateDir, entry);

  const file = path.join(stateDir, "running", `${entry.id}.json`);
  const payload = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

  const expected = [
    "version",
    "id",
    "cwd",
    "label",
    "phase",
    "state",
    "phaseStartedAt",
    "updatedAt",
    "sessionFile",
    "sessionId",
    "owner",
  ].sort();
  assert.deepEqual(Object.keys(payload).sort(), expected);
  assert.deepEqual(Object.keys(payload.owner as Record<string, unknown>), ["pid"]);
  assert.equal(payload.version, 1);

  // Le lecteur RÉEL valide exactement cette liste : la relecture restitue l'entrée
  // écrite, `version` exclu (il n'est pas un champ de `RunningEntry`).
  const snapshot = readStore(stateDir);
  assert.equal(snapshot.unreadable, 0);
  assert.deepEqual(snapshot.running, [entry]);
});
