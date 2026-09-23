// Preuves de la vague 2 du PANNEAU (liste) : les constats PANEL-1 à PANEL-12 de
// l'audit du 2026-09-23.
//
// Six propriétés sont prouvées ici, et nulle part ailleurs :
//   1. le panneau ne dépasse JAMAIS son budget, et la ligne sélectionnée est
//      TOUJOURS peinte — quel que soit le budget, la largeur et la sélection ;
//   2. la sélection garde son IDENTITÉ quand la liste se réordonne toute seule
//      (une entrée d'historique arrive, un run change de maillon) ;
//   3. qui PILOTE le lot se lit dans l'en-tête, et un pilote étranger retire les
//      gestes du pied au lieu de les annoncer pour rien ;
//   4. la boucle /review ⇄ /impl --fix se suit : tour, plafond, verdict bloquant,
//      URL de PR, et une question `ask` en vol s'annonce comme une attente ;
//   5. les touches annoncées sont les touches traitées (o, x, c, l) ;
//   6. un aperçu devenu faux est refermé, et un marqueur de troncature est placé
//      du côté des lignes qu'il cache.
//
// Un test PAR critère d'acceptation, et un seul : `criteria/AC-13` exige qu'un id
// qualifié (`fixpanel/AC-<n>`) désigne un seul test dans un seul fichier — chaque
// test regroupe donc ses cas dans des blocs, plutôt que de multiplier les titres.
//
// Tout est exercé sur des artefacts RÉELS — répertoires `mkdtempSync`, fichiers de
// session JSONL, lot et magasin écrits sur disque — et des doublures INJECTÉES (le
// kit de composants de l'hôte, les actions du lot, l'ordonnanceur) : jamais sur le
// dépôt de la machine, ni sur un vrai process `omp`.
//
// Le harnais est COPIÉ de test/panneau.test.ts : ces fichiers ne s'importent pas
// entre eux (un slug de critère par fichier), donc chacun porte son propre patron.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildPanelRows,
  displayWidth,
  historyIdFor,
  LOT_TICK_MS,
  LOT_VERSION,
  lotRepoKey,
  panelIndexForKey,
  panelRowAt,
  panelRowCount,
  panelRowKey,
  panelSelectionKey,
  pipelinesPanelFactory,
  readPanelModel,
  reviewLoopLabel,
  runningIdFor,
  staleGestureNotice,
  writeHistoryEntry,
  writeLot,
  writeRunningEntry,
  wrapVisible,
  type HistoryEntry,
  type Lot,
  type LotFeature,
  type LotPanelActions,
  type PanelGlyphs,
  type PanelModel,
  type PanelRow,
  type PanelRowRef,
  type PipelinesPanelDeps,
  type RowReply,
  type RunningEntry,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Fixtures : répertoires, lot, magasin
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

const NOW = 1_700_000_000_000;

/** Une feature de lot, prête à être écrite dans un fichier de lot. */
function feature(slug: string, over: Partial<LotFeature> = {}): LotFeature {
  return {
    slug,
    name: `${slug} — intention`,
    branch: `feat/${slug}`,
    worktree: "",
    deps: [],
    origin: "panneau",
    state: "pending",
    phase: "req",
    waitKind: null,
    waitPrompt: null,
    sessionFile: null,
    pendingTexts: [],
    prUrl: null,
    stopReason: null,
    fixes: 0,
    reviewRuns: 0,
    unreadableRuns: 0,
    reviewHash: null,
    lastVerdict: null,
    lastBlockers: 0,
    lastRunSessionFile: null,
    contractHash: null,
    addedAt: NOW,
    sinceAt: NOW,
    updatedAt: NOW,
    endedAt: null,
    ...over,
  };
}

function seedLot(stateDir: string, repoRoot: string, features: LotFeature[], over: Partial<Lot> = {}): Lot {
  const lot: Lot = {
    version: LOT_VERSION,
    id: lotRepoKey(repoRoot),
    repoRoot,
    status: "running",
    reviewCap: 3,
    recapAt: null,
    owner: { pid: process.pid, sessionFile: null, sessionId: null },
    createdAt: NOW,
    launchedAt: NOW,
    features,
    ...over,
  };
  writeLot(stateDir, lot);
  return lot;
}

/** Une entrée EN COURS du magasin, telle qu'un autre processus l'écrirait. */
function liveEntry(stateDir: string, input: Partial<RunningEntry> & { cwd: string }): RunningEntry {
  const entry: RunningEntry = {
    id: runningIdFor(input.cwd),
    cwd: path.resolve(input.cwd),
    label: input.label ?? "depot/feature",
    phase: "req",
    state: "running",
    phaseStartedAt: NOW,
    updatedAt: NOW,
    sessionFile: null,
    sessionId: null,
    // Un pid VIVANT et différent du nôtre : le run d'un process enfant.
    owner: { pid: process.ppid },
    ...input,
  };
  writeRunningEntry(stateDir, entry);
  return entry;
}

function historyEntry(stateDir: string, cwd: string, label: string, endedAt: number, over: Partial<HistoryEntry> = {}): HistoryEntry {
  const entry: HistoryEntry = {
    id: historyIdFor(cwd, endedAt),
    cwd: path.resolve(cwd),
    label,
    phase: "impl",
    finalState: "done",
    sessionFile: null,
    sessionId: null,
    phaseStartedAt: endedAt - 1_000,
    endedAt,
    ...over,
  };
  writeHistoryEntry(stateDir, entry);
  return entry;
}

/** Le texte des rangs, joint : ce que l'écran montre. */
function text(rows: PanelRow[]): string {
  return rows.map((row) => row.text).join("\n");
}

// ---------------------------------------------------------------------------
// Le panneau monté : la VRAIE fabrique, avec ses dépendances injectées
// ---------------------------------------------------------------------------

const GLYPHS: PanelGlyphs = { cursor: ">" };

/** Le thème neutre : `fg`/`bg` rendent le texte tel quel, donc les assertions lisent le texte NU. */
const THEME = {
  fg: (_tone: string, value: string) => value,
  bg: (_tone: string, value: string) => value,
  nav: { cursor: ">" },
};

const KEYS = {
  matches: (data: string, action: string) =>
    (action === "tui.select.up" && data === "\u001b[A") ||
    (action === "tui.select.down" && data === "\u001b[B") ||
    (action === "tui.select.pageUp" && data === "\u001b[5~") ||
    (action === "tui.select.pageDown" && data === "\u001b[6~") ||
    (action === "tui.select.confirm" && data === "\r") ||
    (action === "tui.select.cancel" && (data === "\u001b" || data === "\u0003")),
};

/**
 * Le kit MINIMAL de l'hôte : la LISTE ne construit que des `Text`, des
 * `DynamicBorder` (les règles) et un `Spacer` (le remplissage). Le `Text` replie
 * à la largeur reçue, comme celui d'OMP : c'est ce qui rend une assertion de
 * hauteur significative.
 */
function miniKit(): PipelinesPanelDeps["components"] {
  class FakeText {
    #text: string;
    #paddingX: number;
    #background?: (value: string) => string;
    #style?: (value: string) => string;
    constructor(value = "", paddingX = 1, _paddingY = 0, background?: (value: string) => string) {
      this.#text = value;
      this.#paddingX = paddingX;
      this.#background = background;
    }
    setText(value: string): boolean {
      const changed = value !== this.#text;
      this.#text = value;
      return changed;
    }
    setStyleFn(style?: (value: string) => string): this {
      this.#style = style;
      return this;
    }
    render(width: number): readonly string[] {
      if (this.#text.trim() === "") return [];
      const content = Math.max(1, width - this.#paddingX * 2);
      const styled = this.#style ? this.#style(this.#text) : this.#text;
      return wrapVisible(styled, content).map((line) => {
        const padded = `${" ".repeat(this.#paddingX)}${line}`;
        const filled = padded + " ".repeat(Math.max(0, width - displayWidth(padded)));
        return this.#background ? this.#background(filled) : filled;
      });
    }
  }
  class FakeBorder {
    #color: (value: string) => string;
    constructor(color?: (value: string) => string) {
      this.#color = color ?? ((value) => value);
    }
    render(width: number): readonly string[] {
      return [this.#color("─".repeat(Math.max(1, width)))];
    }
  }
  class FakeSpacer {
    #lines: number;
    constructor(lines = 1) {
      this.#lines = lines;
    }
    setLines(lines: number): void {
      this.#lines = lines;
    }
    render(): readonly string[] {
      return new Array<string>(Math.max(0, this.#lines)).fill("");
    }
  }
  class FakeContainer {
    children: FakeText[] = [];
    addChild(child: FakeText): void {
      this.children.push(child);
    }
    render(width: number): readonly string[] {
      return this.children.flatMap((child) => [...child.render(width)]);
    }
  }
  return {
    Text: FakeText,
    DynamicBorder: FakeBorder,
    Container: FakeContainer,
    Spacer: FakeSpacer,
    theme: THEME,
  } as unknown as PipelinesPanelDeps["components"];
}

type PanelHarness = {
  component: { render(width: number): string[]; handleInput(data: string): void; refresh?: () => void; dispose(): void };
  screen: (width?: number) => string;
};

function mountPanel(stateDir: string, rows: number, over: Partial<PipelinesPanelDeps> = {}): PanelHarness {
  const deps: PipelinesPanelDeps = {
    stateDir,
    components: miniKit(),
    now: () => NOW,
    schedule: () => () => {},
    join: () => {},
    ...over,
  };
  const tui = { terminal: { rows }, requestRender: () => {} };
  const component = pipelinesPanelFactory(deps)(tui, THEME, KEYS, () => {});
  return { component, screen: (width = 80) => component.render(width).join("\n") };
}

/** Une doublure de `LotPanelActions` qui COMPTE ses appels : rien ne part sans confirmation. */
function countingActions(remove?: (slug: string) => string | null): { actions: LotPanelActions; calls: string[] } {
  const calls: string[] = [];
  const actions: LotPanelActions = {
    add: async (input) => {
      calls.push(`add:${input.name}`);
      return null;
    },
    launch: async () => {
      calls.push("launch");
      return null;
    },
    remove: async (slug) => {
      calls.push(`remove:${slug}`);
      return remove ? remove(slug) : null;
    },
    answer: async (slug, value) => {
      calls.push(`answer:${slug}:${value}`);
      return null;
    },
    reply: (slug) => {
      calls.push(`reply:${slug}`);
      return { kind: "closed", reason: "doublure" } satisfies RowReply;
    },
    validate: async (slug) => {
      calls.push(`validate:${slug}`);
      return null;
    },
    accept: async (slug) => {
      calls.push(`accept:${slug}`);
      return null;
    },
    relaunch: async (slug) => {
      calls.push(`relaunch:${slug}`);
      return null;
    },
    cancel: async (slug, fate) => {
      calls.push(`cancel:${slug}:${fate}`);
      return null;
    },
  };
  return { actions, calls };
}

// ---------------------------------------------------------------------------
// PANEL-1 / PANEL-2 — la fenêtre ne dépasse jamais le budget, et la ligne
// sélectionnée est toujours peinte
// ---------------------------------------------------------------------------

/** La borne d'une raison d'arrêt : `LOT_REASON_MAX`, le pire cas de hauteur. */
const LONG_REASON = "r".repeat(200);

/**
 * Le scénario de référence de la géométrie : 12 features dont des bloquées et des
 * échouées à DEUX rangs (libellé + raison de 200 caractères), 3 runs hors lot et
 * 10 entrées d'historique — 25 rangs sélectionnables, bien plus que le budget.
 */
function geometry(stateDir: string, repoRoot: string): { model: PanelModel } {
  const features: LotFeature[] = [];
  for (let i = 0; i < 12; i += 1) {
    if (i % 4 === 0) {
      features.push(feature(`bloq-${i}`, { state: "blocked", phase: "impl", fixes: 2, stopReason: LONG_REASON }));
    } else if (i % 4 === 1) {
      features.push(feature(`casse-${i}`, { state: "failed", phase: "impl", stopReason: LONG_REASON }));
    } else if (i % 4 === 2) {
      features.push(feature(`fini-${i}`, { state: "done", phase: "release", prUrl: `https://example.test/pull/${i}` }));
    } else {
      features.push(feature(`att-${i}`, { state: "waiting", phase: "specs", waitKind: "specs" }));
    }
  }
  seedLot(stateDir, repoRoot, features);
  for (let i = 0; i < 3; i += 1) {
    liveEntry(stateDir, { cwd: mktmp(`fixpanel-run-${i}-`), label: `autre/depot-${i}` });
  }
  for (let i = 0; i < 10; i += 1) {
    historyEntry(stateDir, mktmp(`fixpanel-hist-${i}-`), `autre/vieux-${i}`, NOW - i * 1_000);
  }
  return { model: readPanelModel({ stateDir, repoRoot, selection: 0, now: NOW }) };
}

/** Le nom par lequel un rang se reconnaît à l'écran. */
function rowName(row: PanelRowRef): string {
  return "worktree" in row ? row.slug : row.label;
}

test("fixpanel/AC-1 : la hauteur ne dépasse jamais le budget, pour toute sélection", () => {
  const stateDir = mktmp("fixpanel-ac1-");
  const repoRoot = mktmp("fixpanel-ac1-repo-");
  const { model } = geometry(stateDir, repoRoot);
  const count = panelRowCount(model);
  assert.ok(count >= 25, `le scénario porte plus de rangs que le budget (${count})`);

  for (const [width, budget] of [
    [80, 20],
    [120, 20],
    [60, 16],
    [80, 24],
    [50, 24],
  ] as Array<[number, number]>) {
    for (let selection = 0; selection < count; selection += 1) {
      const rows = buildPanelRows({ ...model, selection }, { width, budget, glyphs: GLYPHS, now: NOW });
      assert.ok(
        rows.length <= budget,
        `le panneau tient dans ${budget} rangs à ${width} colonnes (sélection ${selection} : ${rows.length})`,
      );
      // Le budget est une hauteur de TERMINAL : un rang replié en occupe plusieurs.
      const height = rows.reduce((total, row) => total + Math.max(1, wrapVisible(row.text, Math.max(1, width - 2)).length), 0);
      assert.ok(
        height <= budget,
        `aucune ligne de terminal ne dépasse ${budget} à ${width} colonnes (sélection ${selection} : ${height})`,
      );
      assert.equal(rows[rows.length - 1]?.rule, "frame", `le cadre se referme sur sa règle (${width}x${budget}, sel ${selection})`);
      assert.ok(text(rows).includes("Échap fermer"), `le pied survit à toute sélection (${width}x${budget}, sel ${selection})`);
    }
  }

  // Le MÊME scénario par le composant monté : la hauteur rendue est celle de
  // l'écran, repli du `Text` compris — c'est elle que l'hôte coupe par le bas.
  const { actions } = countingActions();
  const panel = mountPanel(stateDir, 20, { repoRoot, lot: actions });
  for (let step = 0; step < count; step += 1) {
    const drawn = panel.component.render(80);
    assert.ok(drawn.length <= 20, `l'écran tient dans 20 rangs (pas ${step} : ${drawn.length})`);
    assert.match(drawn[drawn.length - 1] as string, /^─+$/, `la règle basse est le dernier rang (pas ${step})`);
    panel.component.handleInput("\u001b[B");
  }
  panel.component.dispose();
});

test("fixpanel/AC-2 : la ligne sélectionnée est peinte, quel que soit le budget", () => {
  const stateDir = mktmp("fixpanel-ac2-");
  const repoRoot = mktmp("fixpanel-ac2-repo-");
  const { model } = geometry(stateDir, repoRoot);
  const count = panelRowCount(model);

  for (const [width, budget] of [
    [80, 20],
    [80, 24],
    [60, 16],
    [50, 24],
  ] as Array<[number, number]>) {
    for (let selection = 0; selection < count; selection += 1) {
      const rows = buildPanelRows({ ...model, selection }, { width, budget, glyphs: GLYPHS, now: NOW });
      const row = panelRowAt(model, selection);
      assert.ok(row, `le rang ${selection} existe`);
      const name = rowName(row);
      const painted = rows.filter((candidate) => candidate.selected === true);
      assert.ok(
        painted.some((candidate) => candidate.text.includes(name)),
        `la ligne SÉLECTIONNÉE est peinte (${width}x${budget}, sel ${selection} : ${name})`,
      );
      // Le curseur de sélection est un PRÉFIXE : c'est lui qui dit où l'on est, et
      // il ne peut pas se poser sur la ligne d'une autre entrée.
      assert.ok(
        rows.some((candidate) => candidate.text.startsWith(`${GLYPHS.cursor} `) && candidate.text.includes(name)),
        `le curseur est sur la ligne sélectionnée (${width}x${budget}, sel ${selection})`,
      );
      assert.equal(
        rows.filter((candidate) => candidate.text.startsWith(`${GLYPHS.cursor} `)).length,
        1,
        `un seul curseur à l'écran (${width}x${budget}, sel ${selection})`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// PANEL-3 — la sélection est une CLÉ, pas un index
// ---------------------------------------------------------------------------

test("fixpanel/AC-3 : la sélection garde son identité quand la liste se réordonne", () => {
  const stateDir = mktmp("fixpanel-ac3-");
  const repoRoot = mktmp("fixpanel-ac3-repo-");
  seedLot(stateDir, repoRoot, [feature("alpha", { state: "running", phase: "impl" })]);
  for (let i = 0; i < 5; i += 1) {
    historyEntry(stateDir, mktmp(`fixpanel-ac3-h${i}-`), `autre/vieux-${i}`, NOW - i * 1_000);
  }
  liveEntry(stateDir, { cwd: mktmp("fixpanel-ac3-run-"), label: "autre/run" });

  // La sélection est posée sur une entrée d'historique, au MILIEU de la liste.
  const before = readPanelModel({ stateDir, repoRoot, selection: 3, now: NOW });
  const key = panelSelectionKey(before);
  const target = panelRowAt(before, 3);
  assert.ok(key?.startsWith("hist:"), `la clé d'une entrée d'historique est son id (${key})`);

  // Un maillon de lot se termine : une entrée d'historique PLUS RÉCENTE arrive en
  // tête, et tous les index d'historique glissent d'un cran.
  historyEntry(stateDir, mktmp("fixpanel-ac3-neuf-"), "autre/neuf", NOW + 5_000);
  const after = readPanelModel({ stateDir, repoRoot, selection: before.selection, now: NOW });
  const moved = panelIndexForKey(after, key, before.selection);
  assert.equal(panelRowKey(panelRowAt(after, moved) as never), key, "la clé retrouve SON entrée, pas sa voisine");
  assert.equal((panelRowAt(after, moved) as HistoryEntry).id, (target as HistoryEntry).id, "c'est bien la même entrée");
  assert.notEqual(moved, before.selection, "l'index a bel et bien glissé : la clé seule protège la sélection");

  // Un run hors lot change de maillon : son `phaseStartedAt` repart, donc il passe
  // en FIN de section — la clé le suit, elle.
  const runs = readPanelModel({ stateDir, repoRoot, selection: 1, now: NOW });
  const runKey = panelSelectionKey(runs);
  assert.ok(runKey?.startsWith("run:"), `la clé d'un run est son id (${runKey})`);
  const runId = (panelRowAt(runs, 1) as RunningEntry).id;
  liveEntry(stateDir, { cwd: (panelRowAt(runs, 1) as RunningEntry).cwd, label: "autre/run", phase: "specs", phaseStartedAt: NOW + 10_000 });
  const movedRuns = readPanelModel({ stateDir, repoRoot, selection: runs.selection, now: NOW });
  const at = panelIndexForKey(movedRuns, runKey, runs.selection);
  assert.equal((panelRowAt(movedRuns, at) as RunningEntry).id, runId, "la clé suit le run qui a changé de maillon");

  // Une ligne DISPARUE retombe sur la voisine, jamais sur rien.
  const gone = panelIndexForKey(movedRuns, "hist:0000000000000000", 4);
  assert.ok(gone >= 0 && gone < panelRowCount(movedRuns), `un repli borné, jamais d'index hors liste (${gone})`);
});

// ---------------------------------------------------------------------------
// PANEL-4 — qui pilote le lot
// ---------------------------------------------------------------------------

test("fixpanel/AC-4 : l'en-tête du lot nomme son pilote dans les trois cas", () => {
  const stateDir = mktmp("fixpanel-ac4-");
  const repoRoot = mktmp("fixpanel-ac4-repo-");
  const rowsFor = (over: Partial<Lot>, selection = 0) => {
    seedLot(stateDir, repoRoot, [feature("alpha", { state: "pending" })], over);
    return text(buildPanelRows(readPanelModel({ stateDir, repoRoot, selection, now: NOW }), { width: 80, budget: 24, glyphs: GLYPHS, now: NOW }));
  };

  // 1. Cette session conduit : le pied annonce les gestes, le titre le dit.
  const self = rowsFor({ owner: { pid: process.pid, sessionFile: null, sessionId: null } });
  assert.match(self, /pilote : cette session/, "le titre nomme la session qui conduit");
  assert.match(self, /a ajouter · l lancer · Entrée session/, "les gestes sont annoncés");

  // 2. Un autre process VIVANT conduit : le panneau consulte, et n'annonce pas des
  //    gestes que le pilote refuserait (PANEL-4, PANEL-8).
  const foreign = rowsFor({ owner: { pid: process.ppid, sessionFile: null, sessionId: null, heartbeatAt: NOW } });
  assert.match(foreign, new RegExp(`piloté par pid ${process.ppid} —`), "le titre nomme le pilote étranger");
  assert.match(foreign, /consultation/, "et dit que le panneau ne fait que consulter");
  assert.match(foreign, /↑↓ naviguer · Entrée session/, "la lecture seule garde ses touches");
  assert.ok(!foreign.includes("a ajouter"), "`a` n'est pas annoncé quand un autre pilote conduit");
  assert.ok(!foreign.includes("l lancer"), "`l` non plus");

  // 3. Personne ne conduit : le titre dit quoi faire, et les gestes reviennent —
  //    c'est le panneau qui reprend le lot (l'adoption est du ressort du panneau).
  const dead = rowsFor({ owner: { pid: 999_999_999, sessionFile: null, sessionId: null } });
  assert.match(dead, /pilote absent — l reprend/, "le titre dit que le lot est à l'arrêt");
  assert.match(dead, /a ajouter · l lancer · Entrée session/, "les gestes sont de nouveau annoncés");

  // Un pid VIVANT mais au battement PÉRIMÉ est mort pour le pilotage : c'est le
  // pid RÉUTILISÉ après un redémarrage, et le lot doit se reprendre.
  const stale = rowsFor({
    owner: { pid: process.ppid, sessionFile: null, sessionId: null, heartbeatAt: NOW - 6 * LOT_TICK_MS },
  });
  assert.match(stale, /pilote absent — l reprend/, "un battement périmé vaut un pilote mort");
});

// ---------------------------------------------------------------------------
// PANEL-5 / PANEL-7 — la boucle de revue et l'URL de PR se lisent dans la liste
// ---------------------------------------------------------------------------

test("fixpanel/AC-5 : le tour de correction, le verdict bloquant et l'URL de PR se lisent", () => {
  const stateDir = mktmp("fixpanel-ac5-");
  const repoRoot = mktmp("fixpanel-ac5-repo-");
  seedLot(stateDir, repoRoot, [
    feature("corrige", { state: "running", phase: "impl", fixes: 2 }),
    feature("relu", { state: "running", phase: "review", reviewRuns: 1 }),
    feature("bloquants", { state: "waiting", phase: "impl", waitKind: "specs", lastVerdict: "blockers", lastBlockers: 2 }),
    feature("livre", { state: "done", phase: "release", prUrl: "https://example.test/pull/42" }),
    feature("vierge", { state: "running", phase: "impl" }),
  ]);
  const rows = buildPanelRows(readPanelModel({ stateDir, repoRoot, selection: 0, now: NOW }), {
    width: 120,
    budget: 30,
    glyphs: GLYPHS,
    now: NOW,
  });
  const drawn = text(rows);

  assert.match(drawn, /--fix · tour 3\/3/, "un tour de correction dit son rang et le plafond du lot");
  assert.match(drawn, /\/review · en cours · 0:00 · tour 2\/3/, "une revue en cours dit son tour");
  assert.match(drawn, /dernière revue : 2 bloquants/, "le verdict bloquant est publié avec son compte");
  assert.match(drawn, /PR : https:\/\/example\.test\/pull\/42/, "l'URL de la PR d'une feature livrée est affichée");
  // Sans tour à lire, la colonne de droite ne change pas d'un octet.
  const plain = rows.find((row) => row.text.includes("vierge "));
  assert.ok(plain?.text.includes("/impl · en cours · 0:00"), `aucun tour inventé sans boucle : ${plain?.text}`);
  assert.ok(!(plain?.text ?? "").includes("tour"), `aucun tour inventé sans boucle : ${plain?.text}`);
  // Le verdict ne se répète pas sur une feature qui n'en a pas.
  assert.equal(rows.filter((row) => row.text.startsWith("dernière revue")).length, 1, "un seul rang de verdict");
  // La revueLoopLabel ne s'invente pas pour un état clos.
  const lot = readPanelModel({ stateDir, repoRoot, now: NOW }).lot as Lot;
  assert.equal(reviewLoopLabel(lot, lot.features[3] as LotFeature), null, "une feature livrée n'a plus de tour courant");
});

// ---------------------------------------------------------------------------
// PANEL-6 — une question `ask` en vol est une attente de RÉPONSE
// ---------------------------------------------------------------------------

test("fixpanel/AC-6 : une question en vol affiche « attend réponse » et « Entrée répondre »", () => {
  const stateDir = mktmp("fixpanel-ac6-");
  const repoRoot = mktmp("fixpanel-ac6-repo-");
  const worktree = mktmp("fixpanel-ac6-wt-");
  const session = path.join(mktmp("fixpanel-ac6-sessions-"), "alpha.jsonl");
  fs.writeFileSync(session, "{}\n");
  const inbox = path.join(stateDir, "inbox", "alpha");
  seedLot(stateDir, repoRoot, [
    feature("avec-ask", { state: "running", phase: "impl", worktree, sessionFile: session }),
  ]);
  liveEntry(stateDir, {
    cwd: worktree,
    label: "depot/avec-ask",
    phase: "impl",
    state: "waiting",
    sessionFile: session,
    inbox,
    pendingAsk: { toolCallId: "call-1", id: "q", question: "Laquelle ?", options: [{ label: "A" }, { label: "B" }] },
  });

  const model = readPanelModel({ stateDir, repoRoot, selection: 0, now: NOW });
  const rows = buildPanelRows(model, { width: 100, budget: 24, glyphs: GLYPHS, now: NOW });
  assert.match(text(rows), /\/impl · attend réponse · 0:00/, "la question en vol est une attente de réponse");
  assert.match(text(rows), /Entrée répondre/, "et le pied annonce la touche qui répond");
  assert.ok(!/· attend ·/.test(text(rows)), "« attend » n'est plus le mot d'une question en vol");

  // Un run vivant SANS question garde les deux mots d'avant : « attend » n'est pas
  // effacé, il n'est plus employé à la place du premier.
  liveEntry(stateDir, {
    cwd: worktree,
    label: "depot/avec-ask",
    phase: "impl",
    state: "waiting",
    sessionFile: session,
    inbox: null,
    pendingAsk: null,
  });
  const calm = readPanelModel({ stateDir, repoRoot, selection: 0, now: NOW });
  assert.match(text(buildPanelRows(calm, { width: 100, budget: 24, glyphs: GLYPHS, now: NOW })), /· attend · 0:00/);
  assert.match(text(buildPanelRows(calm, { width: 100, budget: 24, glyphs: GLYPHS, now: NOW })), /Entrée écrire/);
});

// ---------------------------------------------------------------------------
// PANEL-8 / PANEL-11 — les touches annoncées sont les touches traitées
// ---------------------------------------------------------------------------

test("fixpanel/AC-7 : `o` n'est pas annoncé sur un run vivant, et `l` pas sans rien à lancer", () => {
  const stateDir = mktmp("fixpanel-ac7-");
  const repoRoot = mktmp("fixpanel-ac7-repo-");
  const worktree = mktmp("fixpanel-ac7-wt-");
  const session = path.join(mktmp("fixpanel-ac7-sessions-"), "alpha.jsonl");
  fs.writeFileSync(session, "{}\n");
  seedLot(stateDir, repoRoot, [
    feature("vivante", { state: "running", phase: "impl", worktree, sessionFile: session }),
    feature("libre", { state: "pending" }),
  ]);
  liveEntry(stateDir, { cwd: worktree, label: "depot/vivante", phase: "impl", sessionFile: session });

  const rowsFor = (selection: number) => {
    const model = readPanelModel({ stateDir, repoRoot, selection, now: NOW });
    return text(buildPanelRows(model, { width: 100, budget: 24, glyphs: GLYPHS, now: NOW }));
  };
  // Le run vivant d'un AUTRE process écrit cette session : `o` refuserait.
  const vivante = rowsFor(0);
  assert.ok(!vivante.includes("o rejoindre"), `aucune bascule morte sur un run vivant : ${vivante.split("\n").slice(-4).join(" | ")}`);
  // Une feature qui n'a pas de run peut, elle, être rejointe — mais elle n'a pas
  // encore de session, donc rien ne s'annonce non plus.
  const libre = rowsFor(1);
  assert.ok(!libre.includes("o rejoindre"), "une feature sans session n'annonce pas la bascule");
  assert.match(libre, /x retirer · c annuler/, "une feature à venir annonce son retrait et son abandon");

  // `l` n'est annoncé que s'il y a quelque chose à lancer : ici une feature
  // `pending` sans dépendance, donc oui.
  assert.match(vivante, /a ajouter · l lancer · Entrée session/);
  seedLot(stateDir, repoRoot, [
    feature("vivante", { state: "running", phase: "impl", worktree, sessionFile: session }),
    feature("faite", { state: "done", phase: "release" }),
  ]);
  liveEntry(stateDir, { cwd: worktree, label: "depot/vivante", phase: "impl", sessionFile: session });
  const rien = rowsFor(0);
  assert.match(rien, /a ajouter · Entrée session/, "sans rien à lancer, `l` n'est pas annoncé");
  assert.ok(!rien.includes("l lancer"), `aucune touche morte : ${rien.split("\n").slice(-4).join(" | ")}`);
});

test("fixpanel/AC-8 : `x` refuse sans aperçu une feature démarrée, `c` accepte une bloquée", () => {
  const stateDir = mktmp("fixpanel-ac8-");
  const repoRoot = mktmp("fixpanel-ac8-repo-");
  const worktree = mktmp("fixpanel-ac8-wt-");
  seedLot(stateDir, repoRoot, [
    feature("alpha", { state: "running", phase: "impl", worktree }),
    feature("beta", { state: "blocked", phase: "impl", stopReason: "revue bloquante" }),
  ]);
  const { actions, calls } = countingActions((slug) => `« ${slug} » a déjà démarré — c pour annuler`);
  const panel = mountPanel(stateDir, 24, { repoRoot, lot: actions });

  // `x` sur une feature DÉMARRÉE : le refus du pilote s'affiche, et AUCUN aperçu
  // ne s'ouvre — l'utilisateur ne confirme pas un geste qui n'existe pas.
  panel.component.handleInput("x");
  assert.ok(!panel.screen().includes("Retirer alpha du lot ?"), "aucun aperçu ne s'ouvre sur une feature démarrée");
  assert.match(panel.screen(), /a déjà démarré — c pour annuler/, "le refus du pilote est affiché");
  assert.deepEqual(calls, [], "rien n'est parti");

  // `c` sur la même feature reste refusé côté pilote : la touche est annoncée
  // (elle est valide), c'est le pilote qui tranche.
  panel.component.handleInput("j");
  assert.match(panel.screen(), /c annuler/, "une feature bloquée annonce son abandon (PANEL-11)");

  // `c` sur la feature BLOQUÉE : le choix du devenir du worktree s'ouvre — c'est
  // la sortie qui manquait au plafond de la boucle.
  panel.component.handleInput("c");
  const choix = panel.screen();
  assert.match(choix, /Annuler beta \? worktree : 1 gardé · 2 archivé · 3 supprimé/, "le devenir du worktree se choisit");
  assert.ok(!choix.includes("annulation impossible"), `une feature bloquée s'abandonne : ${choix.split("\n").slice(-4).join(" | ")}`);
  panel.component.handleInput("1");
  assert.match(panel.screen(), /Annuler beta \? · bloqué → annulé · worktree gardé/, "l'aperçu annonce ce qui va se passer");
  panel.component.handleInput("\r");
  assert.deepEqual(calls, ["cancel:beta:keep"], "l'abandon part une fois, avec le devenir choisi");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// PANEL-9 — un aperçu devenu faux est refermé
// ---------------------------------------------------------------------------

test("fixpanel/AC-9 : un aperçu périmé est refermé avec une notice", () => {
  const stateDir = mktmp("fixpanel-ac9-");
  const repoRoot = mktmp("fixpanel-ac9-repo-");
  seedLot(stateDir, repoRoot, [feature("alpha", { state: "waiting", phase: "specs", waitKind: "specs" })]);
  const { actions } = countingActions();
  const panel = mountPanel(stateDir, 24, { repoRoot, lot: actions });

  panel.component.handleInput("v");
  assert.match(panel.screen(), /Valider les specs de alpha \?/, "l'aperçu s'ouvre sur la condition qui tient");
  assert.equal(staleGestureNotice({ kind: "validate", slug: "alpha" }, readPanelModel({ stateDir, repoRoot, now: NOW }).lot ?? null), null);

  // La feature change d'état SOUS l'aperçu (le pilote a avancé, ou l'annulation
  // est passée) : la condition du geste ne tient plus.
  const lot = readPanelModel({ stateDir, repoRoot, now: NOW }).lot as Lot;
  (lot.features[0] as LotFeature).state = "cancelled";
  writeLot(stateDir, lot);
  panel.component.refresh?.();
  const drawn = panel.screen();
  assert.ok(!drawn.includes("Valider les specs de alpha ?"), `l'aperçu périmé est refermé : ${drawn.split("\n").slice(-4).join(" | ")}`);
  assert.match(drawn, /alpha a changé d'état \(annulé\) — aperçu fermé/, "et il dit pourquoi");

  // La règle pure, dans les deux sens : un geste dont la condition tient reste
  // valable, et `Échap` d'un aperçu n'est jamais une invalidation.
  const fresh = readPanelModel({ stateDir, repoRoot, now: NOW }).lot ?? null;
  assert.equal(staleGestureNotice({ kind: "validate", slug: "alpha" }, fresh), "alpha a changé d'état (annulé) — aperçu fermé");
  assert.equal(staleGestureNotice({ kind: "remove", slug: "inconnue" }, fresh), "inconnue a quitté le lot — aperçu fermé");
  assert.equal(staleGestureNotice({ kind: "launch" }, null), "lot indisponible — aperçu fermé");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// PANEL-12 — le marqueur de troncature est du côté des lignes qu'il cache
// ---------------------------------------------------------------------------

test("fixpanel/AC-10 : le marqueur de troncature est placé du côté des lignes masquées", () => {
  const stateDir = mktmp("fixpanel-ac10-");
  const repoRoot = mktmp("fixpanel-ac10-repo-");
  const features = Array.from({ length: 12 }, (_, i) => feature(`g${i}`, { phase: "impl" }));
  seedLot(stateDir, repoRoot, features);
  const model = readPanelModel({ stateDir, repoRoot, selection: 0, now: NOW });
  const rowsFor = (selection: number) =>
    buildPanelRows({ ...model, selection }, { width: 64, budget: 18, glyphs: GLYPHS, now: NOW });
  const lines = (selection: number) => rowsFor(selection).map((row) => row.text);

  // Sélection en TÊTE : les lignes masquées sont en dessous, le marqueur aussi.
  const head = lines(0);
  const below = head.findIndex((line) => line.startsWith("… "));
  const firstFeature = head.findIndex((line) => line.includes("g0 "));
  assert.match(head[below] as string, /de plus dans le lot$/, "le décompte nomme sa section");
  assert.ok(below > firstFeature, "le marqueur est SOUS les lignes qu'il cache");

  // Sélection en QUEUE : les lignes masquées sont AU-DESSUS, le marqueur aussi —
  // il disait « … n de plus » sous la liste, du mauvais côté.
  const tail = lines(11);
  const above = tail.findIndex((line) => line.startsWith("… "));
  const lastFeature = tail.findIndex((line) => line.includes("g11 "));
  assert.match(tail[above] as string, /au-dessus dans le lot$/, "le marqueur dit de quel côté sont les lignes");
  assert.ok(above >= 0 && above < lastFeature, `le marqueur est AU-DESSUS des lignes qu'il cache : ${tail.join(" | ")}`);
  assert.ok(!tail.some((line) => /de plus dans le lot$/.test(line)), "aucun marqueur du mauvais côté");

  // Sélection au MILIEU, avec les deux côtés masqués : les deux marqueurs, chacun
  // de son côté.
  const middle = lines(6);
  assert.ok(middle.some((line) => /au-dessus dans le lot$/.test(line)), "le côté haut est annoncé");
  assert.ok(middle.some((line) => /de plus dans le lot$/.test(line)), "le côté bas est annoncé");
  const up = middle.findIndex((line) => /au-dessus dans le lot$/.test(line));
  const down = middle.findIndex((line) => /de plus dans le lot$/.test(line));
  assert.ok(up < down, "chaque marqueur est du côté des lignes qu'il cache");
});

// ---------------------------------------------------------------------------
// PANEL-12 — Échap dans l'ajout rend le champ précédent avec son tampon
// ---------------------------------------------------------------------------

test("fixpanel/AC-11 : Échap dans l'ajout revient au champ précédent, tampon compris", () => {
  const stateDir = mktmp("fixpanel-ac11-");
  const repoRoot = mktmp("fixpanel-ac11-repo-");
  seedLot(stateDir, repoRoot, []);
  const { actions } = countingActions();
  const panel = mountPanel(stateDir, 24, { repoRoot, lot: actions });

  panel.component.handleInput("a");
  for (const char of "alpha") panel.component.handleInput(char);
  assert.match(panel.screen(), /Nom : alpha▏/, "le premier champ reçoit le nom");
  panel.component.handleInput("\r");
  for (const char of "une intention") panel.component.handleInput(char);
  assert.match(panel.screen(), /Description : une intention▏/, "le second champ reçoit la description");
  panel.component.handleInput("\r");
  for (const char of "beta") panel.component.handleInput(char);
  assert.match(panel.screen(), /Dépendances \(slugs séparés par des virgules\) : beta▏/, "le troisième champ reçoit les dépendances");

  // Échap au champ des DÉPENDANCES : on revient à la description, son tampon
  // intact — perdre les trois champs tapés ferait tout retaper pour rien.
  panel.component.handleInput("\u001b");
  assert.match(
    panel.screen(),
    /Description : une intention▏/,
    `Échap rend le champ précédent, tampon compris : ${panel.screen().split("\n").slice(-4).join(" | ")}`,
  );
  // Échap au champ de la DESCRIPTION : on revient au nom, son tampon intact.
  panel.component.handleInput("\u001b");
  assert.match(panel.screen(), /Nom : alpha▏/, "et le nom tapé est toujours là");
  // Échap au PREMIER champ : il n'y a plus de champ précédent, la saisie se quitte.
  panel.component.handleInput("\u001b");
  assert.ok(!panel.screen().includes("Nom : "), "Échap au premier champ quitte la saisie");
  panel.component.dispose();
});
