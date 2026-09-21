// Tests DISQUE du plugin mémoire (omp-mem0-memory/extension.ts) :
//   - S-3/AC-4 : les écritures du brief sont atomiques (jamais tronqué ni vide) ;
//   - S-4/AC-5 : phases.json est relu avant d'être écrit (une phase d'une autre
//     session survit à un /add-phase de la session courante) ;
//   - S-5/AC-6 : /mem0-brief --update ne peut plus annoncer un succès sans écriture.
//
// ISOLATION : l'extension calcule `PHASES_FILE` (sous `$HOME`) et écrit `AGENTS.md`
// au premier tour. `process.env.HOME` est donc posé sur un répertoire temporaire
// AVANT l'import du module — sans quoi le test écraserait le
// ~/.omp/agent/phases.json de la machine (registry global). L'import est DYNAMIQUE
// à dessein : un import statique serait hoisté au-dessus de l'affectation de HOME.
// C'est le motif de test/relevance.test.ts:22-27.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "plugin-fs-home-"));
process.env.HOME = HOME;
// Le provisionnement DOIT avoir lieu : c'est le chemin qu'AC-4 exerce.
delete process.env.MEM0_AUTOSETUP;

const { default: mem0MemoryExtension, writeFileAtomic } = await import("../omp-mem0-memory/extension.ts");

const tmpDirs: string[] = [HOME];

test.after(() => {
  for (const dir of tmpDirs) {
    // Le cas « répertoire non inscriptible » rend le nettoyage impossible si le
    // mode n'est pas rendu : on le restaure, même si le test a échoué avant.
    try { fs.chmodSync(dir, 0o700); } catch { /* déjà supprimé */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Tout fichier `*.tmp-<pid>` restant sous `dir` : le contrat exige zéro. */
function tmpLeftovers(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.name.includes(".tmp-")) found.push(p);
      else if (entry.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return found;
}

// ---------------------------------------------------------------------------
// `pi` factice : handlers de commande et hooks capturés à l'enregistrement
// (motif de test/handlers.test.ts, réduit à ce que ce fichier exerce).
// ---------------------------------------------------------------------------

type CommandHandler = (args: string, ctx: never) => Promise<void>;
type Hook = (event: never, ctx: never) => Promise<unknown>;

type Notice = { message: string; type?: string };
type Ctx = { cwd: string; ui: { notify: (message: string, type?: string) => void }; notices: Notice[] };

type FakeApp = { commands: Map<string, CommandHandler>; hooks: Map<string, Hook> };

/** Façade minimale de `pi.zod` : l'extension DÉCLARE ses schémas, sans les exécuter. */
type FakeSchema = { [method: string]: (...args: unknown[]) => FakeSchema };
function fakeSchema(): FakeSchema {
  const builder = new Proxy({} as FakeSchema, { get: () => (..._args: unknown[]) => builder });
  return builder;
}

function mkApp(): FakeApp {
  const commands = new Map<string, CommandHandler>();
  const hooks = new Map<string, Hook>();
  const pi = {
    zod: { z: fakeSchema() },
    setLabel: (_label: string) => {},
    registerMessageRenderer: (_type: string, _render: unknown) => {},
    registerTool: (_def: unknown) => {},
    registerCommand: (name: string, def: { handler: CommandHandler }) => { commands.set(name, def.handler); },
    on: (name: string, handler: Hook) => { hooks.set(name, handler); },
  };
  mem0MemoryExtension(pi as unknown as Parameters<typeof mem0MemoryExtension>[0]);
  return { commands, hooks };
}

/** Contexte minimal : `cwd` + les notices, seul effet de bord observable. */
function mkCtx(cwd: string): Ctx {
  const notices: Notice[] = [];
  return { cwd, notices, ui: { notify: (message, type) => notices.push({ message, type }) } };
}

const text = (ctx: Ctx) => ctx.notices.map((n) => n.message).join("\n");

// ---------------------------------------------------------------------------
// AC-4 — écritures atomiques
// ---------------------------------------------------------------------------

test("plugin-fs/AC-4 : provisionnement atomique — texte utilisateur intact, bloc complet, aucun temporaire, échec sans perte", async () => {
  const app = mkApp();
  const repo = mkDir("plugin-fs-repo-");
  const user = "# AGENTS.md\n\nRègle utilisateur : ne pas toucher à ce paragraphe.\n";
  fs.writeFileSync(path.join(repo, "AGENTS.md"), user, "utf8");

  const ctx = mkCtx(repo);
  await app.hooks.get("session_start")!({} as never, ctx as never);

  const agents = path.join(repo, "AGENTS.md");
  const body = fs.readFileSync(agents, "utf8");
  assert.ok(body.startsWith(user), "le texte utilisateur est intact après provisionnement");
  assert.ok(body.includes("<!-- mem0:brief v4 -->"), "marqueur d'ouverture présent");
  assert.ok(body.includes("<!-- /mem0:brief -->"), "marqueur de fermeture présent");
  const ref = fs.readFileSync(path.join(repo, ".omp", "mem0-brief.md"), "utf8");
  assert.ok(ref.includes("<!-- mem0:brief v4 -->"), "le fichier de référence est complet");
  assert.ok(ref.trimEnd().endsWith("simplement faux."), "le fichier de référence est écrit jusqu'à sa dernière ligne");
  assert.ok(body.trimEnd().endsWith("<!-- /mem0:brief -->"), "le bloc écrit dans AGENTS.md est complet (fermeture en fin de fichier)");
  assert.deepEqual(tmpLeftovers(repo), [], "aucun AGENTS.md.tmp-* ni .omp/mem0-brief.md.tmp-* ne subsiste");

  // Preuve du mécanisme : le remplacement passe par temporaire + `renameSync`, pas
  // par une écriture en place. Un AGENTS.md en lecture seule est donc quand même
  // remplacé, là où un `writeFileSync` aurait échoué — c'est ce qui garantit qu'une
  // interruption ne peut jamais laisser un fichier à moitié écrit.
  const modeDir = mkDir("plugin-fs-mode-");
  const locked = path.join(modeDir, "AGENTS.md");
  fs.writeFileSync(locked, "avant\n", "utf8");
  fs.chmodSync(locked, 0o444);
  writeFileAtomic(locked, "après\n");
  assert.equal(fs.readFileSync(locked, "utf8"), "après\n", "remplacement par rename, pas écriture en place");
  assert.deepEqual(tmpLeftovers(modeDir), [], "le temporaire a été renommé, pas laissé derrière");

  // Échec d'écriture : répertoire cible rendu non inscriptible. Le fichier
  // d'origine doit rester intact, octet pour octet.
  const readOnly = mkDir("plugin-fs-ro-");
  const target = path.join(readOnly, "AGENTS.md");
  fs.writeFileSync(target, user, "utf8");
  const before = fs.readFileSync(target);
  fs.chmodSync(readOnly, 0o500);
  try {
    let blocked = false;
    try { fs.writeFileSync(path.join(readOnly, ".sonde"), "x"); } catch { blocked = true; }
    assert.ok(blocked, "le répertoire doit être réellement non inscriptible (uid non privilégié)");
    assert.throws(() => writeFileAtomic(target, "remplacé"), /EACCES|EPERM|permission/i);
    assert.ok(fs.readFileSync(target).equals(before), "fichier d'origine inchangé octet pour octet");
    assert.deepEqual(tmpLeftovers(readOnly).filter((p) => p.includes("AGENTS.md.tmp-")), [],
      "aucun temporaire laissé par l'écriture en échec");
  } finally {
    fs.chmodSync(readOnly, 0o700);
  }

  // Même panne vue d'en haut : /mem0-brief --update sur un bloc périmé doit
  // rapporter l'échec, jamais un `agents=created` mensonger.
  const repoRo = mkDir("plugin-fs-repo-ro-");
  const agentsRo = path.join(repoRo, "AGENTS.md");
  fs.writeFileSync(agentsRo, "<!-- mem0:brief v3 -->\n## Mémoire du projet\nvieux\n<!-- /mem0:brief -->\n", "utf8");
  const beforeRo = fs.readFileSync(agentsRo);
  fs.chmodSync(repoRo, 0o500);
  const ctxRo = mkCtx(repoRo);
  try {
    await app.commands.get("mem0-brief")!("--update", ctxRo as never);
    assert.ok(fs.readFileSync(agentsRo).equals(beforeRo), "AGENTS.md laissé intact octet pour octet");
    assert.match(text(ctxRo), /AGENTS\.md=failed/, "l'échec est rapporté, pas un succès");
    assert.ok(!text(ctxRo).includes("AGENTS.md=created"), "jamais un succès annoncé sans écriture");
  } finally {
    fs.chmodSync(repoRo, 0o700);
  }
});

// ---------------------------------------------------------------------------
// AC-5 — registry de phases
// ---------------------------------------------------------------------------

test("plugin-fs/AC-5 : phases.json relu avant écriture — la phase d'une autre session survit", async () => {
  const app = mkApp();
  const ctx = mkCtx(HOME);
  const file = path.join(HOME, ".omp", "agent", "phases.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Écrite par une AUTRE session OMP, après le chargement du module : c'est
  // exactement l'état que l'ancien `savePhases(phases)` écrasait.
  fs.writeFileSync(file, JSON.stringify({ alpha: { brief: "écrit par une autre session" } }, null, 2), "utf8");

  await app.commands.get("add-phase")!("beta rôle de test", ctx as never);
  const added = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { brief: string }>;
  assert.equal(added.alpha?.brief, "écrit par une autre session", "l'entrée d'une autre session est préservée");
  assert.equal(added.beta?.brief, "rôle de test", "la nouvelle phase est écrite");

  await app.commands.get("remove-phase")!("alpha", ctx as never);
  const removed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { brief: string }>;
  assert.ok(!("alpha" in removed), "alpha a disparu");
  assert.equal(removed.beta?.brief, "rôle de test", "beta reste intacte");
  assert.deepEqual(tmpLeftovers(path.join(HOME, ".omp")), [], "aucun phases.json.tmp-* ne subsiste");
});

// ---------------------------------------------------------------------------
// AC-6 — /mem0-brief --update dit la vérité
// ---------------------------------------------------------------------------

test("plugin-fs/AC-6 : /mem0-brief --update — bloc sans fermeture signalé sans écriture, bloc périmé réécrit", async () => {
  const app = mkApp();

  // (1) Marqueur d'ouverture v4 sans marqueur de fermeture : réécrire depuis
  // l'ouverture détruirait le contenu utilisateur qui suit, donc on signale.
  const repo = mkDir("plugin-fs-repo-");
  const agents = path.join(repo, "AGENTS.md");
  const openOnly = "<!-- mem0:brief v4 -->\n## Mémoire du projet\ntexte utilisateur\n";
  fs.writeFileSync(agents, openOnly, "utf8");
  const ctx = mkCtx(repo);
  await app.commands.get("mem0-brief")!("--update", ctx as never);
  assert.equal(fs.readFileSync(agents, "utf8"), openOnly, "AGENTS.md inchangé octet pour octet");
  assert.match(text(ctx), /AGENTS\.md=failed/, "l'état rapporté est failed");
  assert.match(text(ctx), /sans marqueur de fermeture/, "la cause est nommée");
  assert.ok(!text(ctx).includes("AGENTS.md=created"), "jamais un succès annoncé sans écriture");

  // (2) Bloc complet mais de version ancienne : réécriture réelle, état created.
  const repo2 = mkDir("plugin-fs-repo-");
  const agents2 = path.join(repo2, "AGENTS.md");
  const outdated =
    "<!-- mem0:brief v3 -->\n## Mémoire du projet\nvieux bloc\n<!-- /mem0:brief -->\n\n## Section utilisateur\n\nÀ préserver.\n";
  fs.writeFileSync(agents2, outdated, "utf8");
  const ctx2 = mkCtx(repo2);
  await app.commands.get("mem0-brief")!("--update", ctx2 as never);
  const after = fs.readFileSync(agents2, "utf8");
  assert.ok(after.includes("<!-- mem0:brief v4 -->"), "le bloc est réécrit en v4");
  assert.ok(after.includes("<!-- /mem0:brief -->"), "le marqueur de fermeture est présent");
  assert.ok(!after.includes("vieux bloc"), "l'ancien bloc a été remplacé");
  assert.ok(after.includes("## Section utilisateur"), "le contenu utilisateur qui suit le bloc est préservé");
  assert.match(text(ctx2), /AGENTS\.md=created/, "l'état rapporté est created");
  assert.deepEqual(tmpLeftovers(repo2), [], "aucun temporaire ne subsiste après réécriture");
});
