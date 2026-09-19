// Tests du panneau des pipelines : le MAGASIN d'état partagé (un fichier par
// pipeline, écrit par son propriétaire, lu par tous), la mise en page PURE
// (`buildPanelRows`, testée avec des glyphes ASCII — donc sans terminal), la
// réconciliation des propriétaires morts, la bascule vers une session et la
// suppression d'une entrée d'historique.
//
// Les magasins sont des répertoires RÉELS sous `mkdtempSync` (comme
// worktree.test.ts) : les entrées sont écrites, relues et supprimées sur le
// disque, ce qui est exactement ce que fait le panneau d'un autre processus. Rien
// n'est simulé : un `pid` mort est un vrai processus terminé, un fichier de
// session est un vrai fichier, et le rafraîchissement périodique est déclenché à
// la main (aucun timer réel, donc aucune attente).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildPanelRows,
  clampSelection,
  deleteHistoryEntry,
  elapsedLabel,
  historyIdFor,
  joinEntry,
  moveSelection,
  PANEL_REFRESH_MS,
  panelBudget,
  pidAlive,
  pipelineLabel,
  pipelineHistoryDir,
  pipelineRunningDir,
  pipelineStateDir,
  pipelinesPanelFactory,
  readPanelModel,
  readStore,
  runningIdFor,
  switchDecision,
  writeHistoryEntry,
  writeRunningEntry,
  type HistoryEntry,
  type PanelGlyphs,
  type PanelModel,
  type PanelRow,
  type PipelinesPanelDeps,
  type RunningEntry,
  type SessionProbe,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Magasin temporaire et fabriques d'entrées
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

/** Un pid RÉELLEMENT mort : un enfant lancé puis terminé, avec son vrai pid. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(child.pid, "l'enfant doit avoir un pid");
  assert.equal(pidAlive(child.pid), false, "le pid de l'enfant terminé doit être mort");
  return child.pid;
}

function mkRunning(stateDir: string, input: Partial<RunningEntry> & { cwd: string }): RunningEntry {
  const entry: RunningEntry = {
    id: runningIdFor(input.cwd),
    cwd: path.resolve(input.cwd),
    label: input.label ?? pipelineLabel(input.cwd),
    phase: "req",
    state: "running",
    phaseStartedAt: 1_000,
    updatedAt: 1_000,
    sessionFile: null,
    sessionId: null,
    owner: { pid: process.pid },
    ...input,
  };
  writeRunningEntry(stateDir, entry);
  return entry;
}

function mkHistory(stateDir: string, input: Partial<HistoryEntry> & { cwd: string }): HistoryEntry {
  const endedAt = input.endedAt ?? 5_000;
  const entry: HistoryEntry = {
    id: historyIdFor(input.cwd, endedAt),
    cwd: path.resolve(input.cwd),
    label: input.label ?? pipelineLabel(input.cwd),
    phase: "review",
    finalState: "done",
    sessionFile: null,
    sessionId: null,
    phaseStartedAt: 1_000,
    ...input,
    endedAt,
  };
  writeHistoryEntry(stateDir, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Rangs purs : glyphes ASCII, thème neutre, horloge injectée
// ---------------------------------------------------------------------------

const GLYPHS: PanelGlyphs = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  teeLeft: "+",
  teeRight: "+",
  cursor: ">",
};

const THEME = {
  // Thème neutre : `fg` rend le texte tel quel, donc les assertions lisent le
  // texte NU (aucun ANSI à défaire).
  fg: (_color: string, text: string) => text,
  boxRound: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    teeLeft: "+",
    teeRight: "+",
  },
  nav: { cursor: ">" },
};

const KEYBINDINGS = {
  matches: (data: string, action: string) =>
    (action === "tui.select.up" && data === "\u001b[A") ||
    (action === "tui.select.down" && data === "\u001b[B") ||
    (action === "tui.select.confirm" && data === "\r") ||
    (action === "tui.select.cancel" && (data === "\u001b" || data === "\u0003")),
};

function rowsText(rows: PanelRow[]): string {
  return rows.map((row) => row.text).join("\n");
}

function renderModel(model: PanelModel, now: number, width = 64, budget = 18): string {
  return rowsText(buildPanelRows(model, { width, budget, glyphs: GLYPHS, now }));
}

// ---------------------------------------------------------------------------
// Panneau monté : la fabrique réelle, avec ses dépendances injectées
// ---------------------------------------------------------------------------

function mountPanel(stateDir: string, over: Partial<PipelinesPanelDeps> = {}) {
  const scheduled: Array<{ callback: () => void; ms: number }> = [];
  const stopped: number[] = [];
  const pending: Array<Promise<void>> = [];
  const deps: PipelinesPanelDeps = {
    stateDir,
    now: () => 10_000,
    schedule: (callback, ms) => {
      scheduled.push({ callback, ms });
      return () => stopped.push(1);
    },
    join: () => {},
    ...over,
  };
  let closed = 0;
  const tui = { terminal: { rows: 24 }, requestRender: () => {} };
  const component = pipelinesPanelFactory(deps)(tui, THEME, KEYBINDINGS, () => {
    closed += 1;
  });
  return {
    component,
    /** Le rafraîchissement périodique, déclenché à la main : aucun timer réel. */
    tick: () => {
      for (const { callback } of scheduled) callback();
    },
    scheduled,
    pending,
    closed: () => closed,
    stopped: () => stopped.length,
    render: () => component.render(64).join("\n"),
    /** Rendu à largeur imposée : la troncature est un artefact de largeur, pas du message. */
    renderAt: (width: number) => component.render(width).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// AC-1 — les rangs du panneau
// ---------------------------------------------------------------------------

test("AC-1 : les rangs du panneau portent le cadre et le pied", () => {
  // Aucune entrée du tout : le panneau s'affiche quand même (titre, sections
  // vides, pied) — il ne se ferme pas tout seul.
  const model: PanelModel = { running: [], history: [], selection: -1, notice: null, unreadable: 0 };
  const rows = buildPanelRows(model, { width: 64, budget: 18, glyphs: GLYPHS, now: 1_000 });
  const text = rowsText(rows);

  assert.match(text, /Pipelines · 0 en cours/, "le titre porte le compteur des pipelines en cours");
  assert.match(text, /aucune pipeline en cours/);
  assert.match(text, /aucun historique/);
  assert.match(text, /↑↓ naviguer · Entrée rejoindre · d supprimer/);
  assert.match(text, /Échap fermer/);
  assert.equal(rows.length, 6, "titre + séparateur + 2 sections vides + 2 rangs de pied");
  for (const row of rows) {
    assert.equal(row.text.length, 64, `chaque rang fait exactement la largeur reçue : ${JSON.stringify(row.text)}`);
  }
});

test("AC-1 : une sélection vide ne fait rien (Entrée et d sans entrée)", async () => {
  const stateDir = mktmp("pl-ac1-empty-");
  const panel = mountPanel(stateDir);
  panel.component.handleInput("\r");
  panel.component.handleInput("d");
  await Promise.all(panel.pending);
  assert.equal(panel.closed(), 0, "Entrée sans sélection ne ferme pas le panneau");
  assert.match(panel.render(), /aucune pipeline en cours/);
  assert.doesNotMatch(panel.render(), /seules les entrées d'historique/, "aucune notice pour une liste vide");
});

// ---------------------------------------------------------------------------
// AC-2 — tout le magasin, tous dépôts confondus
// ---------------------------------------------------------------------------

test("AC-2 : le panneau liste les pipelines de deux dépôts distincts", () => {
  const stateDir = mktmp("pl-ac2-");
  const other = process.ppid;
  assert.ok(pidAlive(other), "le second propriétaire doit vivre pour rester « en cours »");

  const first = mktmp("pl-repo-a-");
  const second = mktmp("pl-repo-b-");
  mkRunning(stateDir, { cwd: first, label: "mem0-omp/panneau", phase: "impl", owner: { pid: process.pid } });
  mkRunning(stateDir, {
    cwd: second,
    label: "autre-depot/fix-recall",
    phase: "specs",
    phaseStartedAt: 2_000,
    owner: { pid: other },
  });

  const model = readPanelModel({ stateDir });
  assert.deepEqual(
    model.running.map((entry) => entry.label),
    ["mem0-omp/panneau", "autre-depot/fix-recall"],
    "les deux dépôts sont listés — pas seulement celui de la session locale",
  );
  const text = renderModel(model, 3_000);
  assert.match(text, /mem0-omp\/panneau/);
  assert.match(text, /autre-depot\/fix-recall/, "les deux labels sont RENDUS, pas seulement lus");
});

test("AC-2 : un fichier d'état illisible est ignoré et signalé", () => {
  const stateDir = mktmp("pl-ac2-broken-");
  const cwd = mktmp("pl-repo-ok-");
  mkRunning(stateDir, { cwd, label: "depot/lisible" });
  fs.writeFileSync(path.join(pipelineRunningDir(stateDir), "0123456789abcdef.json"), '{"version": 1, "id":');

  const model = readPanelModel({ stateDir });
  assert.equal(model.running.length, 1, "l'entrée valide est conservée");
  assert.equal(model.unreadable, 1, "le fichier illisible est compté");
  const text = renderModel(model, 3_000);
  assert.match(text, /depot\/lisible/);
  assert.match(text, /1 fichier\(s\) d'état illisible\(s\) — entrée\(s\) ignorée\(s\)/);
});

// ---------------------------------------------------------------------------
// AC-3 — maillon courant et rafraîchissement sans geste
// ---------------------------------------------------------------------------

test("AC-3 : un changement de maillon est repris au rafraîchissement suivant", () => {
  const stateDir = mktmp("pl-ac3-");
  const cwd = mktmp("pl-repo-phase-");
  mkRunning(stateDir, { cwd, label: "depot/feature", phase: "req" });

  const panel = mountPanel(stateDir);
  assert.match(panel.render(), /\/req · tourne/);

  // Un AUTRE processus écrit son passage au maillon suivant : rien d'autre ne
  // change pour nous.
  mkRunning(stateDir, { cwd, label: "depot/feature", phase: "impl", phaseStartedAt: 2_000, updatedAt: 2_000 });
  panel.tick();

  const text = panel.render();
  assert.match(text, /\/impl · tourne/, "le nouveau maillon est repris sans action de l'utilisateur");
  assert.doesNotMatch(text, /\/req ·/, "l'ancien maillon a disparu");
});

test("AC-3 : le panneau se rafraîchit sans action", () => {
  const stateDir = mktmp("pl-ac3-tick-");
  const cwd = mktmp("pl-repo-tick-");
  mkRunning(stateDir, { cwd, label: "depot/avant", phase: "req" });

  const panel = mountPanel(stateDir);
  assert.equal(panel.scheduled.length, 1, "la fabrique programme UN rafraîchissement périodique");
  assert.equal(panel.scheduled[0]!.ms, PANEL_REFRESH_MS);
  assert.ok(PANEL_REFRESH_MS <= 1000, "au moins une relecture du magasin par seconde");
  assert.match(panel.render(), /depot\/avant/);

  mkRunning(stateDir, { cwd: mktmp("pl-repo-tick2-"), label: "depot/apres", phase: "review" });
  // Aucune touche, aucune commande : c'est bien le rafraîchissement qui relit.
  panel.tick();
  assert.match(panel.render(), /depot\/apres/);

  panel.component.dispose();
  assert.equal(panel.stopped(), 1, "dispose arrête le rafraîchissement (aucun timer qui survit au panneau)");
});

test("AC-4 : le temps écoulé repart au changement d'étape", () => {
  const origin = 1_700_000_000_000;
  const stateDir = mktmp("pl-ac4-");
  const cwd = mktmp("pl-repo-time-");
  mkRunning(stateDir, { cwd, label: "depot/feature", phase: "req", phaseStartedAt: origin });

  const first = renderModel(readPanelModel({ stateDir }), origin + 7_000);
  assert.match(first, /\/req · tourne · 0:07/, "le temps mesure l'étape courante (7 s)");

  // Le maillon change : `phaseStartedAt` repart, donc le temps aussi — la durée
  // totale de la pipeline (ici 67 s) n'est jamais affichée.
  mkRunning(stateDir, {
    cwd,
    label: "depot/feature",
    phase: "impl",
    phaseStartedAt: origin + 60_000,
    updatedAt: origin + 60_000,
  });
  const second = renderModel(readPanelModel({ stateDir }), origin + 67_000);
  assert.match(second, /\/impl · tourne · 0:07/);
  assert.doesNotMatch(second, /1:07/, "jamais la durée totale depuis l'origine de la pipeline");

  // Format du temps : secondes sur 2 chiffres, minutes non remplies, heures au-delà.
  assert.equal(elapsedLabel(7_000), "0:07");
  assert.equal(elapsedLabel(7 * 60_000 + 12_000), "7:12");
  assert.equal(elapsedLabel(59 * 60_000 + 59_000), "59:59");
  assert.equal(elapsedLabel(3_600_000 + 3 * 60_000 + 45_000), "1:03:45");
  assert.equal(elapsedLabel(-5_000), "0:00", "une horloge reculée n'affiche pas de temps négatif");
});

// ---------------------------------------------------------------------------
// AC-5 — « tourne » / « attend »
// ---------------------------------------------------------------------------

test("AC-5 : une pipeline qui attend une réponse est marquée « attend »", () => {
  const stateDir = mktmp("pl-ac5-");
  const busy = mktmp("pl-repo-busy-");
  const idle = mktmp("pl-repo-idle-");
  mkRunning(stateDir, { cwd: busy, label: "depot/en-cours", state: "running" });
  mkRunning(stateDir, {
    cwd: idle,
    label: "depot/suspendue",
    state: "waiting",
    phaseStartedAt: 2_000,
    updatedAt: 2_000,
  });

  const text = renderModel(readPanelModel({ stateDir }), 3_000);
  assert.match(text, /depot\/en-cours\s+\/req · tourne · /, "l'agent qui travaille « tourne »");
  assert.match(text, /depot\/suspendue\s+\/req · attend · /, "une question posée à l'utilisateur « attend »");
});

// ---------------------------------------------------------------------------
// AC-6 — rejoindre la session correspondante
// ---------------------------------------------------------------------------

test("AC-6 : sélectionner une pipeline ouvre la session correspondante", async () => {
  const stateDir = mktmp("pl-ac6-");
  const cwd = mktmp("pl-repo-join-");
  const sessionFile = path.join(stateDir, "session-cible.jsonl");
  // Un fichier de session RÉELLEMENT valide : en-tête complet, avec le cwd du
  // répertoire courant (une 4e cause de refus existe pour un cwd disparu).
  fs.writeFileSync(
    sessionFile,
    `{"type":"session","version":3,"id":"s-cible","timestamp":"2026-09-19T00:00:00.000Z","cwd":${JSON.stringify(cwd)}}\n`,
  );
  mkRunning(stateDir, { cwd, label: "depot/feature", sessionFile, sessionId: "abc" });

  const switched: string[] = [];
  const durable: string[] = [];
  const ctx = {
    switchSession: async (target: string) => {
      switched.push(target);
      return { cancelled: false };
    },
  };
  const panel = mountPanel(stateDir, {
    join: (entry, close, showNotice) => {
      panel.pending.push(joinEntry(entry, { ctx, close, showNotice, notify: (text) => durable.push(text) }));
    },
  });

  assert.match(panel.render(), /depot\/feature/, "le rang est là");
  panel.component.handleInput("\r"); // Entrée
  await Promise.all(panel.pending);

  assert.deepEqual(switched, [sessionFile], "la session de l'entrée est ouverte");
  assert.equal(panel.closed(), 1, "le panneau se ferme après une bascule réussie");
  assert.deepEqual(durable, [], "aucune bascule refusée");
});

// ---------------------------------------------------------------------------
// AC-7 — une session non reprenable est SIGNALÉE
// ---------------------------------------------------------------------------

test("AC-7 : une session non reprenable est signalée au lieu de rester sans effet", async () => {
  const stateDir = mktmp("pl-ac7-");
  const cwd = mktmp("pl-repo-gone-");
  const missing = path.join(stateDir, "session-absente.jsonl"); // jamais écrite sur le disque
  mkRunning(stateDir, { cwd, label: "depot/perdue", sessionFile: missing });

  const switched: string[] = [];
  const durable: string[] = [];
  const ctx = {
    switchSession: async (target: string) => {
      switched.push(target);
      return { cancelled: false };
    },
  };
  const panel = mountPanel(stateDir, {
    join: (entry, close, showNotice) => {
      panel.pending.push(joinEntry(entry, { ctx, close, showNotice, notify: (text) => durable.push(text) }));
    },
  });

  panel.component.handleInput("\r");
  await Promise.all(panel.pending);

  assert.deepEqual(switched, [], "aucune bascule tentée : elle créerait une session vide à ce chemin");
  assert.equal(panel.closed(), 0, "le panneau reste ouvert");
  assert.ok(
    panel.renderAt(200).includes(`session introuvable — entrée non reprenable : ${missing}`),
    `le panneau le dit explicitement, chemin compris :\n${panel.renderAt(200)}`,
  );
  // À 64 colonnes le chemin est tronqué (les rangs font exactement la largeur
  // reçue), mais le rang de notice est bien celui-là.
  assert.match(panel.render(), /session introuvable — entrée non reprenable : /);
  assert.deepEqual(durable, [], "une entrée non reprenable n'est pas une bascule refusée");
});

// ---------------------------------------------------------------------------
// AC-8 — fin de pipeline : sortie de la liste, entrée d'historique
// ---------------------------------------------------------------------------

test("AC-8 : un processus disparu rejoint l'historique en « échoué »", () => {
  const stateDir = mktmp("pl-ac8-");
  const cwd = mktmp("pl-repo-dead-");
  const gone = deadPid();
  const entry = mkRunning(stateDir, {
    cwd,
    label: "depot/abandonnee",
    phase: "impl",
    phaseStartedAt: 1_000,
    updatedAt: 4_000,
    owner: { pid: gone },
  });

  const model = readPanelModel({ stateDir });
  assert.deepEqual(model.running, [], "plus rien en cours : le propriétaire n'existe plus");
  assert.equal(model.history.length, 1, "la pipeline entre dans l'historique");
  const record = model.history[0]!;
  assert.equal(record.finalState, "failed");
  assert.equal(record.phase, "impl", "le maillon atteint est conservé");
  assert.equal(record.phaseStartedAt, entry.phaseStartedAt);
  assert.equal(record.endedAt, entry.updatedAt, "l'instant de fin est le dernier battement, donc stable");

  // Jamais dans les deux listes : le fichier en cours a disparu du magasin.
  assert.equal(fs.existsSync(path.join(pipelineRunningDir(stateDir), `${entry.id}.json`)), false);
  assert.equal(fs.existsSync(path.join(pipelineHistoryDir(stateDir), `${record.id}.json`)), true);
  const text = renderModel(model, 6_000);
  assert.match(text, /depot\/abandonnee\s+\/impl · échoué/);
  assert.match(text, /Pipelines · 0 en cours/);

  // Idempotent : une seconde lecture (un autre « processus ») ne duplique rien.
  assert.equal(readPanelModel({ stateDir }).history.length, 1);
});

// ---------------------------------------------------------------------------
// AC-9 — l'historique survit au redémarrage
// ---------------------------------------------------------------------------

test("AC-9 : l'historique survit au redémarrage", () => {
  const stateDir = mktmp("pl-ac9-");
  const done = mktmp("pl-repo-done-");
  const failed = mktmp("pl-repo-failed-");
  mkHistory(stateDir, { cwd: done, label: "depot/terminee", finalState: "done", endedAt: 9_000 });
  mkHistory(stateDir, { cwd: failed, label: "depot/echouee", finalState: "failed", endedAt: 8_000 });

  // Aucun processus n'a jamais tourné dans ce magasin : c'est un redémarrage.
  const model = readPanelModel({ stateDir });
  assert.deepEqual(model.running, []);
  assert.deepEqual(
    model.history.map((entry) => `${entry.label}:${entry.finalState}`),
    ["depot/terminee:done", "depot/echouee:failed"],
    "l'historique est lu sur le disque, le plus récent d'abord",
  );

  const text = renderModel(model, 10_000);
  assert.match(text, /depot\/terminee\s+\/review · terminé/);
  assert.match(text, /depot\/echouee\s+\/review · échoué/);
  assert.match(text, /Pipelines · 0 en cours/);
});

// ---------------------------------------------------------------------------
// AC-10 — suppression unitaire et définitive
// ---------------------------------------------------------------------------

test("AC-10 : une entrée supprimée ne réapparaît pas", () => {
  const stateDir = mktmp("pl-ac10-");
  const runningCwd = mktmp("pl-repo-live-");
  const oldCwd = mktmp("pl-repo-old-");
  mkRunning(stateDir, { cwd: runningCwd, label: "depot/en-cours" });
  const doomed = mkHistory(stateDir, { cwd: oldCwd, label: "depot/a-supprimer", finalState: "done" });

  const panel = mountPanel(stateDir);
  panel.component.handleInput("j"); // descend sur le premier rang d'historique
  panel.component.handleInput("d"); // supprime

  assert.equal(
    fs.existsSync(path.join(pipelineHistoryDir(stateDir), `${doomed.id}.json`)),
    false,
    "la suppression est un unlink : le fichier absent EST l'état",
  );
  const text = panel.render();
  assert.doesNotMatch(text, /depot\/a-supprimer/);
  assert.match(text, /depot\/en-cours/, "seule l'entrée visée est partie");

  // Redémarrage simulé : une relecture complète du magasin ne la voit toujours pas.
  assert.deepEqual(
    readPanelModel({ stateDir }).history.map((entry) => entry.label),
    [],
    "l'entrée ne réapparaît pas après un redémarrage d'OMP",
  );
});

test("AC-10 : la suppression ne s'applique qu'à l'historique", () => {
  const stateDir = mktmp("pl-ac10-live-");
  const cwd = mktmp("pl-repo-keep-");
  const entry = mkRunning(stateDir, { cwd, label: "depot/en-cours" });

  const panel = mountPanel(stateDir);
  panel.component.handleInput("d"); // le rang sélectionné est une pipeline en cours

  assert.equal(
    fs.existsSync(path.join(pipelineRunningDir(stateDir), `${entry.id}.json`)),
    true,
    "le fichier en cours est intact",
  );
  assert.match(panel.render(), /seules les entrées d'historique se suppriment/);
});

// ---------------------------------------------------------------------------
// Cas limites du magasin, de la sélection et de la mise en page (S-1, S-2, S-7)
// ---------------------------------------------------------------------------

test("magasin absent ou vide : zéro entrée, aucune erreur", () => {
  const stateDir = path.join(mktmp("pl-empty-"), "jamais-cree");
  const model = readPanelModel({ stateDir });
  assert.deepEqual(model, { running: [], history: [], selection: -1, notice: null, unreadable: 0 });
  assert.equal(renderModel(model, 1_000).split("\n").length, 6, "le panneau s'affiche quand même");
});

test("les fichiers étrangers au magasin sont ignorés SANS être comptés", () => {
  const stateDir = mktmp("pl-noise-");
  const cwd = mktmp("pl-repo-noise-");
  mkRunning(stateDir, { cwd, label: "depot/lisible" });
  fs.writeFileSync(path.join(pipelineRunningDir(stateDir), "0123456789abcdef.json.tmp-42"), "{}");
  fs.writeFileSync(path.join(pipelineRunningDir(stateDir), ".DS_Store"), "bruit");

  const model = readPanelModel({ stateDir });
  assert.equal(model.running.length, 1);
  assert.equal(model.unreadable, 0, "un temporaire d'écriture n'est pas un fichier illisible");
});

test("un historique illisible est ignoré et compté", () => {
  const stateDir = mktmp("pl-history-broken-");
  const cwd = mktmp("pl-repo-hist-");
  mkHistory(stateDir, { cwd, label: "depot/propre" });
  fs.writeFileSync(path.join(pipelineHistoryDir(stateDir), "abcdef0123456789.json"), '{"version": 2}');

  const model = readPanelModel({ stateDir });
  assert.deepEqual(model.history.map((entry) => entry.label), ["depot/propre"]);
  assert.equal(model.unreadable, 1);
});

test("une entrée d'une version de schéma inconnue est ignorée, pas interprétée", () => {
  const stateDir = mktmp("pl-version-");
  const dir = pipelineRunningDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "1111111111111111.json"),
    JSON.stringify({ version: 99, id: "1111111111111111", cwd: "/x", label: "x", phase: "req" }),
  );
  const store = readStore(stateDir);
  assert.deepEqual(store.running, []);
  assert.equal(store.unreadable, 1);
});

test("la sélection est bornée, sans bouclage, et reste valide après une suppression", () => {
  assert.equal(clampSelection(0, 0), -1, "aucune entrée ⇒ aucune sélection");
  assert.equal(clampSelection(7, 3), 2);
  assert.equal(clampSelection(-4, 3), 0);
  assert.equal(moveSelection(0, 3, -1), 0, "pas de bouclage vers la fin");
  assert.equal(moveSelection(2, 3, 1), 2, "pas de bouclage vers le début");
  assert.equal(moveSelection(-1, 3, 1), 0, "depuis « rien », on entre dans la liste");
  assert.equal(moveSelection(0, 0, 1), -1);

  // Après suppression du DERNIER rang, la sélection recule sur le précédent.
  const stateDir = mktmp("pl-select-");
  const a = mktmp("pl-repo-sa-");
  const b = mktmp("pl-repo-sb-");
  mkHistory(stateDir, { cwd: a, label: "depot/a", endedAt: 9_000 });
  const last = mkHistory(stateDir, { cwd: b, label: "depot/b", endedAt: 8_000 });
  assert.equal(readPanelModel({ stateDir, selection: 1 }).selection, 1);
  deleteHistoryEntry(stateDir, last.id);
  assert.equal(readPanelModel({ stateDir, selection: 1 }).selection, 0, "le rang précédent devient la sélection");
});

test("le panneau se borne en hauteur : en cours prioritaires, marqueurs de troncature", () => {
  const model: PanelModel = {
    running: [0, 1, 2].map((i) => ({
      id: runningIdFor(`/r${i}`),
      cwd: `/r${i}`,
      label: `depot/live-${i}`,
      phase: "impl" as const,
      state: "running" as const,
      phaseStartedAt: i,
      updatedAt: i,
      sessionFile: null,
      sessionId: null,
      owner: { pid: process.pid },
    })),
    history: [0, 1, 2, 3, 4].map((i) => ({
      id: historyIdFor(`/h${i}`, i),
      cwd: `/h${i}`,
      label: `depot/old-${i}`,
      phase: "review" as const,
      finalState: "done" as const,
      sessionFile: null,
      sessionId: null,
      phaseStartedAt: 0,
      endedAt: 100 - i,
    })),
    selection: 0,
    notice: null,
    unreadable: 0,
  };

  // budget 10 ⇒ 6 rangs de contenu : 3 en cours (priorité) + 2 d'historique + le
  // marqueur de la section tronquée.
  const rows = buildPanelRows(model, { width: 40, budget: 10, glyphs: GLYPHS, now: 500 });
  assert.equal(rows.length, 10, "le panneau ne dépasse jamais son budget de rangs");
  const text = rowsText(rows);
  assert.match(text, /depot\/live-0/);
  assert.match(text, /depot\/live-2/, "toutes les pipelines en cours passent avant l'historique");
  assert.match(text, /depot\/old-0/, "puis l'historique le plus récent");
  assert.match(text, /… 3 de plus/, "un marqueur par section tronquée");
  assert.match(text, /↑↓ naviguer/, "le pied survit à la réduction");
  for (const row of rows) {
    assert.equal(row.text.length, 40, "largeur exacte, même tronqué");
  }

  // Terminal étroit : rien ne dépasse, quel que soit la largeur reçue.
  for (const width of [20, 31, 64, 120]) {
    for (const row of buildPanelRows(model, { width, budget: 12, glyphs: GLYPHS, now: 500 })) {
      assert.equal(row.text.length, width, `largeur ${width} respectée`);
    }
  }
  assert.equal(panelBudget(10), 8, "plancher de 8 rangs");
  assert.equal(panelBudget(100), 18, "plafond de 18 rangs");
  assert.equal(panelBudget(20), 16, "80 % de la hauteur du terminal, entre les deux");
});

test("le rang sélectionné porte le curseur, les autres un préfixe de même largeur", () => {
  const stateDir = mktmp("pl-cursor-");
  const a = mktmp("pl-repo-ca-");
  const b = mktmp("pl-repo-cb-");
  mkRunning(stateDir, { cwd: a, label: "depot/un", phaseStartedAt: 1 });
  mkRunning(stateDir, { cwd: b, label: "depot/deux", phaseStartedAt: 2 });
  const text = renderModel(readPanelModel({ stateDir, selection: 1 }), 3_000);
  assert.match(text, /\| {3}depot\/un /, "le rang non sélectionné est indenté d'autant que le curseur");
  assert.match(text, /\| > depot\/deux /, "le rang sélectionné porte le curseur en tête");
});

test("l'état est écrit en toutes lettres : la couleur ne le porte jamais seule", () => {
  const stateDir = mktmp("pl-tones-");
  const cwd = mktmp("pl-repo-tone-");
  mkRunning(stateDir, { cwd, label: "depot/tone", state: "waiting" });
  const rows = buildPanelRows(readPanelModel({ stateDir }), { width: 64, budget: 18, glyphs: GLYPHS, now: 2_000 });
  const entry = rows.find((row) => row.text.includes("depot/tone"));
  assert.ok(entry, "le rang de l'entrée existe");
  assert.match(entry.text, /\/req · attend · 0:01/);
  assert.equal(entry.tone, "warning", "le ton suit l'état, mais le mot est écrit");
});

// ---------------------------------------------------------------------------
// Décision de bascule (pure) — la garde de reprenabilité de S-5
// ---------------------------------------------------------------------------

test("switchDecision : chemin absent, chemin vide et chemin présent", () => {
  const present = "/sessions/abc.jsonl";
  const cwd = "/depot/cible";
  const probe: SessionProbe = {
    isSessionFile: (p) => p === present,
    sessionHeader: () => ({ cwd }),
    isDirectory: () => true,
  };
  assert.deepEqual(switchDecision({ sessionFile: present }, probe), {
    kind: "switch",
    path: present,
    cwd,
  });
  assert.deepEqual(switchDecision({ sessionFile: present }, { ...probe, isSessionFile: () => false }), {
    kind: "unavailable",
    message: `session introuvable — entrée non reprenable : ${present}`,
  });
  assert.deepEqual(switchDecision({ sessionFile: null }, probe), {
    kind: "unavailable",
    message: "session introuvable — entrée non reprenable",
  });
});

test("joinEntry : une bascule refusée devient une notice durable, jamais une exception", async () => {
  const dir = mktmp("pl-join-");
  const sessionFile = path.join(dir, "session.jsonl");
  // Session valide : le test porte sur le REFUS de la bascule, pas sur celui de
  // l'entrée (un fichier vide tomberait sur « sans en-tête valide »).
  fs.writeFileSync(
    sessionFile,
    `{"type":"session","version":3,"id":"s-jointe","timestamp":"2026-09-19T00:00:00.000Z","cwd":${JSON.stringify(dir)}}\n`,
  );
  const durable: string[] = [];
  const shown: string[] = [];
  const closed: number[] = [];
  await joinEntry(
    { sessionFile },
    {
      ctx: {
        switchSession: async () => {
          throw new Error("hook session_before_switch a refusé");
        },
      },
      close: () => closed.push(1),
      showNotice: (message) => shown.push(message),
      notify: (text) => durable.push(text),
    },
  );
  assert.deepEqual(closed, [1], "le panneau est fermé avant la bascule");
  assert.deepEqual(shown, [], "ce n'est pas une notice de panneau : le panneau est déjà fermé");
  assert.deepEqual(durable, [`[pipeline] bascule refusée — la session cible n'a pas pu être ouverte : ${sessionFile}`]);

  const cancelled: string[] = [];
  await joinEntry(
    { sessionFile },
    {
      ctx: {
        switchSession: async () => ({ cancelled: true }),
      },
      close: () => {},
      showNotice: () => {},
      notify: (text) => cancelled.push(text),
    },
  );
  assert.equal(cancelled.length, 1, "un {cancelled:true} est traité comme un refus");
});

// ---------------------------------------------------------------------------
// Répertoire d'état (config/env) et rattachement au dépôt
// ---------------------------------------------------------------------------

test("pipelineStateDir : variable d'environnement prioritaire, chemin relatif ignoré", () => {
  const home = "/home/testeur";
  assert.equal(pipelineStateDir({}, home), path.join(home, ".omp", "agent", "pipeline"));
  assert.equal(pipelineStateDir({ MEM0_PIPELINE_STATE_DIR: "/var/etat" }, home), "/var/etat");
  assert.equal(pipelineStateDir({ MEM0_PIPELINE_STATE_DIR: "~" }, home), home);
  assert.equal(pipelineStateDir({ MEM0_PIPELINE_STATE_DIR: "~/etat" }, home), path.join(home, "etat"));
  assert.equal(
    pipelineStateDir({ MEM0_PIPELINE_STATE_DIR: "relatif/etat" }, home),
    path.join(home, ".omp", "agent", "pipeline"),
    "un chemin relatif dépendrait du cwd de la session : il est ignoré",
  );
});

test("l'étiquette nomme dépôt et feature dans un worktree, le basename du cwd sinon", () => {
  const primary = mktmp("pl-primary-");
  const feature = mktmp("pl-feature-");
  fs.mkdirSync(path.join(primary, ".git"), { recursive: true });
  const gitdir = path.join(primary, ".git", "worktrees", "feature");
  fs.mkdirSync(gitdir, { recursive: true });
  // Worktree lié : `.git` est un FICHIER « gitdir: …/.git/worktrees/<nom> ».
  fs.writeFileSync(path.join(feature, ".git"), `gitdir: ${gitdir}\n`);

  assert.equal(pipelineLabel(feature), `${path.basename(primary)}/${path.basename(feature)}`);
  assert.equal(pipelineLabel(primary), path.basename(primary), "hors worktree, le basename du cwd");
  assert.equal(
    pipelineLabel(path.join(primary, "sous-dossier")),
    path.basename(primary),
    "depuis un sous-dossier du dépôt principal",
  );
});
