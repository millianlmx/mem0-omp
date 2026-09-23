// Preuves de la vague 2 « vue de session » (VIEW-1 à VIEW-15) : la vue suit le
// maillon COURANT (chaîne review → fix), montre la session du run ÉCHOUÉ, refuse
// d'écrire dans un worktree occupé ou dans sa propre session, ne livre jamais au
// mauvais rang, garde le brouillon sous un `ask`, atteint les entrées qui précèdent
// une ligne de 300 Kio, et LIBÈRE l'assemblage quand on la quitte.
//
// Le harnais est copié du patron de test/sessions.test.ts (les fichiers de test ne
// s'importent pas entre eux) : artefacts réels — répertoires `mkdtempSync`, fichiers
// de session JSONL écrits puis relus — et doublures INJECTÉES (le kit de composants,
// `sessionReply`, la bascule, l'horloge). Jamais le dépôt de la machine, jamais un
// vrai process `omp`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import reqExtension, {
  LOT_VERSION,
  SESSION_VIEW_MAX_ENTRIES,
  displayWidth,
  historyIdFor,
  lotRepoKey,
  panelInboxDirFor,
  pipelinesPanelFactory,
  readDeliveries,
  runningIdFor,
  wrapVisible,
  writeHistoryEntry,
  writeLot,
  writeRunningEntry,
  type Lot,
  type LotFeature,
  type LotPanelActions,
  type PanelGlyphs,
  type PipelinesPanelDeps,
  type RunningEntry,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Fixtures : répertoires, magasin, lot, fichiers de session
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

const AT = 1_700_000_000_000;

/** Une entrée EN COURS du magasin, telle qu'un autre processus l'écrirait. */
function liveEntry(stateDir: string, input: Partial<RunningEntry> & { cwd: string }): RunningEntry {
  const entry: RunningEntry = {
    id: runningIdFor(input.cwd),
    cwd: path.resolve(input.cwd),
    label: input.label ?? "depot/feature",
    phase: "req",
    state: "running",
    phaseStartedAt: AT,
    updatedAt: AT,
    sessionFile: null,
    sessionId: null,
    // Un pid VIVANT et différent du nôtre : c'est le run d'un process enfant.
    owner: { pid: process.ppid },
    ...input,
  };
  writeRunningEntry(stateDir, entry);
  return entry;
}

/** Une entrée CLOSE du magasin : un maillon terminé, devenu rang d'historique. */
function closedEntry(stateDir: string, input: Partial<RunningEntry> & { cwd: string }): void {
  writeHistoryEntry(stateDir, {
    id: historyIdFor(input.cwd, AT),
    cwd: path.resolve(input.cwd),
    label: input.label ?? "depot/feature",
    phase: input.phase ?? "review",
    finalState: "done",
    sessionFile: input.sessionFile ?? null,
    sessionId: null,
    phaseStartedAt: AT,
    endedAt: AT,
  });
}

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
    contractHash: null,
    addedAt: AT,
    sinceAt: AT,
    updatedAt: AT,
    endedAt: null,
    ...over,
  };
}

function seedLot(stateDir: string, repoRoot: string, features: LotFeature[]): Lot {
  const lot: Lot = {
    version: LOT_VERSION,
    id: lotRepoKey(repoRoot),
    repoRoot,
    status: "running",
    reviewCap: 3,
    recapAt: null,
    owner: { pid: process.pid, sessionFile: null, sessionId: null },
    createdAt: AT,
    launchedAt: AT,
    features,
  };
  writeLot(stateDir, lot);
  return lot;
}

// ---------------------------------------------------------------------------
// Fichiers de session RÉELS (format JSONL d'OMP)
// ---------------------------------------------------------------------------

/** Un fichier de session réel : créneau de titre, en-tête, puis les entrées reçues. */
function writeSession(file: string, cwd: string, entries: unknown[] = []): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ type: "title", v: 1, title: "session de test", updatedAt: 1 }),
    JSON.stringify({ type: "session", version: 3, id: path.basename(file), timestamp: "2026-09-19T00:00:00.000Z", cwd }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function assistantEntry(text: string, calls: Array<{ id: string; name: string }> = []): unknown {
  return {
    type: "message",
    id: `a-${text.slice(0, 8)}-${calls.length}`,
    parentId: null,
    timestamp: "2026-09-19T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }, ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} }))],
    },
  };
}

/** Le résultat d'un outil : c'est lui qui porte la ligne de 300 Kio du cas VIEW-6. */
function toolResultEntry(toolCallId: string, text: string): unknown {
  return {
    type: "message",
    id: `r-${toolCallId}`,
    parentId: null,
    timestamp: "2026-09-19T00:00:03.000Z",
    message: { role: "toolResult", toolCallId, toolName: "grep", content: [{ type: "text", text }], isError: false },
  };
}

// ---------------------------------------------------------------------------
// Panneau monté : la fabrique réelle, avec ses dépendances injectées
// ---------------------------------------------------------------------------

const GLYPHS: PanelGlyphs = { cursor: ">" };

const THEME = {
  fg: (_tone: string, text: string) => text,
  bg: (_tone: string, text: string) => text,
  nav: { cursor: ">" },
};

/**
 * Le faux kit de composants de l'hôte : il JOURNALISE ses constructions et ses
 * LIBÉRATIONS. Ce qui se prouve ici, c'est ce que le panneau demande aux composants
 * (quel composant, pour quelle entrée) et quand il les libère (VIEW-7) ; le rendu
 * des composants d'OMP est celui de l'hôte, prouvé par la fumée PTY.
 */
function fakeKit() {
  const built: string[] = [];
  const released: string[] = [];
  const frame = (lines: string[], width: number): readonly string[] =>
    lines.flatMap((line) =>
      wrapVisible(line, Math.max(1, width)).map((part) => part + " ".repeat(Math.max(0, width - displayWidth(part)))),
    );
  class FakeText {
    #text: string;
    #paddingX: number;
    #background?: (text: string) => string;
    #style?: (text: string) => string;
    constructor(text = "", paddingX = 1, _paddingY = 0, background?: (text: string) => string) {
      built.push("Text");
      this.#text = text;
      this.#paddingX = paddingX;
      this.#background = background;
    }
    setText(text: string): boolean {
      const changed = text !== this.#text;
      this.#text = text;
      return changed;
    }
    setStyleFn(style?: (text: string) => string): this {
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
    constructor() {
      built.push("DynamicBorder");
    }
    render(width: number): readonly string[] {
      return ["─".repeat(Math.max(1, width))];
    }
  }
  class FakeSpacer {
    #lines: number;
    constructor(lines = 1) {
      built.push("Spacer");
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
    children: Array<{ render(width: number): readonly string[] }> = [];
    addChild(child: { render(width: number): readonly string[] }): void {
      this.children.push(child);
    }
    render(width: number): readonly string[] {
      return this.children.flatMap((child) => [...child.render(width)]);
    }
  }
  const textOf = (message: Record<string, unknown>): string => {
    const content = Array.isArray(message.content) ? message.content : [];
    return content
      .filter((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text")
      .map((block) => String((block as Record<string, unknown>).text ?? ""))
      .join(" ");
  };
  class FakeUser {
    #text: string;
    constructor(text: string) {
      built.push("UserMessageComponent");
      this.#text = text;
    }
    dispose(): void {
      released.push("UserMessageComponent");
    }
    render(width: number): readonly string[] {
      return frame(this.#text.split("\n").map((line) => `▸ toi : ${line}`), width);
    }
  }
  class FakeAssistant {
    #message: Record<string, unknown>;
    constructor(message?: Record<string, unknown>) {
      built.push("AssistantMessageComponent");
      this.#message = message ?? {};
    }
    setExpanded(): void {}
    setImagesVisible(): void {}
    setToolResultImagesVisible(): void {}
    dispose(): void {
      released.push("AssistantMessageComponent");
    }
    render(width: number): readonly string[] {
      const text = textOf(this.#message);
      if (text.trim() === "") return [];
      return frame(text.split("\n").map((line) => `▸ agent : ${line}`), width);
    }
  }
  class FakeTool {
    #name: string;
    #result?: { content: Array<{ text?: string }> };
    constructor(toolName: string) {
      built.push("ToolExecutionComponent");
      this.#name = toolName;
    }
    updateArgs(): void {}
    setArgsComplete(): void {}
    setExecutionStarted(): void {}
    setExpanded(): void {}
    updateResult(result: { content: Array<{ text?: string }> }): void {
      this.#result = result;
    }
    dispose(): void {
      released.push("ToolExecutionComponent");
    }
    render(width: number): readonly string[] {
      const tail = this.#result ? "" : " [EN ATTENTE]";
      return frame([`→ ${this.#name}${tail}`], width);
    }
  }
  class FakeReadGroup {
    #calls: string[] = [];
    constructor() {
      built.push("ReadToolGroupComponent");
    }
    updateArgs(_args: unknown, id?: string): void {
      this.#calls.push(id ?? "");
    }
    setArgsComplete(): void {}
    setExecutionStarted(): void {}
    setExpanded(): void {}
    updateResult(): void {}
    dispose(): void {
      released.push("ReadToolGroupComponent");
    }
    render(width: number): readonly string[] {
      return frame(this.#calls.map(() => "→ read"), width);
    }
  }
  class FakeCustom {
    #message: Record<string, unknown>;
    constructor(message: unknown) {
      built.push("CustomMessageComponent");
      this.#message = (message ?? {}) as Record<string, unknown>;
    }
    setExpanded(): void {}
    dispose(): void {
      released.push("CustomMessageComponent");
    }
    render(width: number): readonly string[] {
      const content = typeof this.#message.content === "string" ? this.#message.content : "";
      return frame([`· ${String(this.#message.customType ?? "?")} : ${content}`], width);
    }
  }
  class FakeBash {
    constructor() {
      built.push("BashExecutionComponent");
    }
    appendOutput(): void {}
    setComplete(): void {}
    setExpanded(): void {}
    dispose(): void {
      released.push("BashExecutionComponent");
    }
    render(width: number): readonly string[] {
      return frame(["$ bash"], width);
    }
  }
  const summary = (name: string) =>
    class {
      constructor() {
        built.push(name);
      }
      setExpanded(): void {}
      dispose(): void {
        released.push(name);
      }
      render(): readonly string[] {
        return ["≡ résumé de session"];
      }
    };
  const kit = {
    Text: FakeText,
    DynamicBorder: FakeBorder,
    Container: FakeContainer,
    Spacer: FakeSpacer,
    theme: THEME,
    UserMessageComponent: FakeUser,
    AssistantMessageComponent: FakeAssistant,
    ToolExecutionComponent: FakeTool,
    ReadToolGroupComponent: FakeReadGroup,
    CustomMessageComponent: FakeCustom,
    BashExecutionComponent: FakeBash,
    CompactionSummaryMessageComponent: summary("CompactionSummaryMessageComponent"),
    BranchSummaryMessageComponent: summary("BranchSummaryMessageComponent"),
  };
  return { kit: kit as unknown as PipelinesPanelDeps["components"], built, released };
}

const KEYS = {
  matches: (data: string, action: string) =>
    (action === "tui.select.up" && data === "\u001b[A") ||
    (action === "tui.select.down" && data === "\u001b[B") ||
    (action === "tui.select.confirm" && data === "\r") ||
    (action === "tui.select.pageUp" && data === "\u001b[5~") ||
    (action === "tui.select.pageDown" && data === "\u001b[6~") ||
    (action === "tui.select.cancel" && (data === "\u001b" || data === "\u0003")),
};

type PanelHarness = {
  component: { render(width: number): string[]; handleInput(data: string): void; refresh(): void; dispose(): void };
  tui: { terminal: { rows?: number }; requestRender: () => void };
  screen: (width?: number) => string;
  closed: () => number;
  pending: Array<Promise<void>>;
};

function mountPanel(stateDir: string, over: Partial<PipelinesPanelDeps> = {}): PanelHarness {
  const scheduled: Array<() => void> = [];
  let closed = 0;
  const pending: Array<Promise<void>> = [];
  const deps: PipelinesPanelDeps = {
    stateDir,
    components: over.components ?? fakeKit().kit,
    now: () => AT,
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
    join: () => {},
    ...over,
  };
  const tui = { terminal: { rows: 24 } as { rows?: number }, requestRender: () => {} };
  const component = pipelinesPanelFactory(deps)(tui, THEME, KEYS, () => {
    closed += 1;
  });
  return { component, tui, screen: (width = 120) => component.render(width).join("\n"), closed: () => closed, pending };
}

/** Sélectionne le rang dont le libellé apparaît, en descendant jusqu'à lui. */
function selectLabel(panel: PanelHarness, label: string): void {
  for (let i = 0; i < 8; i += 1) {
    const selected = panel.component.render(120).find((row) => row.includes("> "));
    if (selected !== undefined && selected.includes(label)) return;
    panel.component.handleInput("j");
  }
  assert.fail(`le rang « ${label} » n'est pas atteignable :\n${panel.screen()}`);
}

/** Laisse retomber les microtâches : les livraisons sont écrites hors du rendu. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Les textes livrés dans une boîte, dans l'ordre d'écriture des fichiers. */
function deliveredTexts(dir: string): string[] {
  return readDeliveries(dir)
    .map((entry) => entry.delivery)
    .filter((delivery): delivery is { version: 1; kind: "text"; text: string; sentAt: number } => delivery?.kind === "text")
    .map((delivery) => delivery.text);
}

/** Le chemin de l'entrée en cours d'un cwd, pour la faire « mourir » en la retirant. */
function runningFile(stateDir: string, cwd: string): string {
  return path.join(stateDir, "running", `${runningIdFor(cwd)}.json`);
}

// ---------------------------------------------------------------------------
// VIEW-1 / VIEW-5 — la vue suit le maillon COURANT, et lit la session du run ÉCHOUÉ
// ---------------------------------------------------------------------------

test("fixview/AC-1 : la vue suit le fichier du maillon courant, et celui du run échoué", () => {
  {
    // La boucle review → fix : chaque maillon est un run SANS `--resume`, donc un
    // fichier de session NEUF. La vue ouverte pendant /review doit basculer sur le
    // fichier du fix sans qu'on touche à rien — c'est ce qui rend la boucle
    // automatique supervisable.
    const stateDir = path.join(mktmp("fixview-ac1-"), "pipeline");
    const repoRoot = mktmp("fixview-ac1-repo-");
    const worktree = mktmp("fixview-ac1-wt-");
    const review = path.join(stateDir, "sessions", "review.jsonl");
    writeSession(review, worktree, [assistantEntry("REVUE: je lis le diff")]);
    seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile: review, state: "running", phase: "review" })]);
    liveEntry(stateDir, { cwd: worktree, sessionFile: review, label: "repo/alpha", phase: "review" });

    const panel = mountPanel(stateDir, { repoRoot });
    panel.component.handleInput("\r");
    assert.match(panel.screen(), /session review\.jsonl/, "la vue s'ouvre sur le maillon en cours");
    assert.match(panel.screen(), /REVUE: je lis le diff/);

    // La chaîne enchaîne : nouveau run, nouveau fichier, même vue ouverte.
    const fix = path.join(stateDir, "sessions", "fix.jsonl");
    writeSession(fix, worktree, [assistantEntry("FIX: je corrige B-1")]);
    seedLot(stateDir, repoRoot, [
      feature("alpha", { worktree, sessionFile: review, lastRunSessionFile: review, state: "running", phase: "impl", fixes: 1 }),
    ]);
    liveEntry(stateDir, { cwd: worktree, sessionFile: fix, label: "repo/alpha", phase: "impl" });
    panel.component.refresh();

    const screen = panel.screen();
    assert.match(screen, /\/impl/, "le titre suit le maillon");
    assert.match(screen, /session fix\.jsonl/, "le titre nomme le fichier du maillon courant");
    assert.match(screen, /FIX: je corrige B-1/, "le corps suit le fichier du maillon courant");
    assert.doesNotMatch(screen, /REVUE: je lis le diff/, "la transcription du maillon précédent est remplacée");
    assert.match(screen, /nouveau maillon \/impl — session fix\.jsonl/, "un rang de service nomme le maillon suivi");
    panel.component.dispose();
  }

  {
    // Une feature ÉCHOUÉE : `sessionFile` ne retient que les succès (il sert à
    // `answer --resume`), donc la vue doit lire la session du DERNIER run, quel que
    // soit son sort — sinon elle montre la conversation du dernier maillon réussi.
    const stateDir = path.join(mktmp("fixview-ac1b-"), "pipeline");
    const repoRoot = mktmp("fixview-ac1b-repo-");
    const worktree = mktmp("fixview-ac1b-wt-");
    const good = path.join(stateDir, "sessions", "req.jsonl");
    writeSession(good, worktree, [assistantEntry("REQ: collecte finie")]);
    const bad = path.join(stateDir, "sessions", "specs.jsonl");
    writeSession(bad, worktree, [assistantEntry("SPECS: je plante ici")]);
    seedLot(stateDir, repoRoot, [
      feature("alpha", {
        worktree,
        sessionFile: good,
        lastRunSessionFile: bad,
        state: "failed",
        phase: "specs",
        stopReason: "maillon interrompu",
      }),
    ]);

    const panel = mountPanel(stateDir, { repoRoot });
    panel.component.handleInput("\r");
    const screen = panel.screen();
    assert.match(screen, /session specs\.jsonl/, "la vue lit la session du dernier run, quel que soit son sort");
    assert.match(screen, /SPECS: je plante ici/, "le corps montre pourquoi le maillon a planté");
    assert.doesNotMatch(screen, /REQ: collecte finie/, "la session du dernier succès n'est plus celle de la vue");
    panel.component.dispose();
  }
});

// ---------------------------------------------------------------------------
// VIEW-2 — jamais deux agents dans le même worktree
// ---------------------------------------------------------------------------

test("fixview/AC-2 : la zone refuse d'écrire dans le worktree d'un maillon du lot", async () => {
  const stateDir = path.join(mktmp("fixview-ac2-"), "pipeline");
  const repoRoot = mktmp("fixview-ac2-repo-");
  const worktree = mktmp("fixview-ac2-wt-");
  const review = path.join(stateDir, "sessions", "review.jsonl");
  writeSession(review, worktree, [assistantEntry("REVUE finie")]);
  const fix = path.join(stateDir, "sessions", "fix.jsonl");
  writeSession(fix, worktree, [assistantEntry("FIX en cours")]);
  // Le maillon terminé devient un rang d'historique ; le maillon suivant tourne dans
  // le MÊME worktree, avec un AUTRE fichier de session.
  closedEntry(stateDir, { cwd: worktree, label: "repo/alpha", phase: "review", sessionFile: review });
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile: fix, state: "running", phase: "impl" })]);
  liveEntry(stateDir, { cwd: worktree, sessionFile: fix, label: "repo/alpha", phase: "impl" });

  const calls: string[] = [];
  const panel = mountPanel(stateDir, {
    repoRoot,
    sessionReply: async () => {
      calls.push("sessionReply");
      return null;
    },
  });

  selectLabel(panel, "repo/alpha");
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /session review\.jsonl/, "la vue du rang d'historique s'ouvre");
  assert.match(
    panel.screen(),
    /lecture seule — un maillon du lot travaille dans ce worktree/,
    "le worktree occupé est refusé, quel que soit le fichier de session visé",
  );
  for (const char of "revois B-2") panel.component.handleInput(char);
  panel.component.handleInput("\r");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(calls, [], "rien n'est lancé dans un worktree occupé");

  // Le run du lot n'a pas (encore) publié d'entrée : le worktree reste occupé, parce
  // qu'il appartient à une feature NON terminale du lot.
  fs.rmSync(runningFile(stateDir, worktree));
  panel.component.refresh();
  assert.match(
    panel.screen(),
    /lecture seule — un maillon du lot travaille dans ce worktree/,
    "sans run publié non plus : le worktree appartient au lot",
  );
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// VIEW-8 — on ne répond pas à une feature dont on occupe SOI-MÊME la session
// ---------------------------------------------------------------------------

test("fixview/AC-3 : la zone refuse d'écrire dans la session courante du panneau", async () => {
  const stateDir = path.join(mktmp("fixview-ac3-"), "pipeline");
  const repoRoot = mktmp("fixview-ac3-repo-");
  const worktree = mktmp("fixview-ac3-wt-");
  const session = path.join(stateDir, "sessions", "impl.jsonl");
  writeSession(session, worktree, [assistantEntry("IMPL: quelle base ?")]);
  seedLot(stateDir, repoRoot, [
    feature("alpha", {
      worktree,
      sessionFile: session,
      state: "waiting",
      waitKind: "answer",
      waitPrompt: "Quelle base ?",
      phase: "impl",
    }),
  ]);

  const answers: string[] = [];
  const lot = { answer: async (_slug: string, text: string) => (answers.push(text), null) } as unknown as LotPanelActions;
  // `o` a déjà rejoint cette session : c'est CELLE de ce process.
  const panel = mountPanel(stateDir, { repoRoot, lot, currentSessionFile: session });
  panel.component.handleInput("\r");
  assert.match(
    panel.screen(),
    /lecture seule — c'est ta session — réponds-y directement/,
    "la zone refuse d'écrire dans la session ouverte ici",
  );
  for (const char of "Postgres") panel.component.handleInput(char);
  panel.component.handleInput("\r");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(answers, [], "aucune réponse n'est envoyée : le pilote relancerait `--resume` sur notre session");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// VIEW-3 — un reste de boîte revient à SON rang, jamais à celui qu'on regarde
// ---------------------------------------------------------------------------

test("fixview/AC-4 : le reste d'une boîte ne part jamais au rang affiché", async () => {
  const stateDir = path.join(mktmp("fixview-ac4-"), "pipeline");
  const dirA = mktmp("fixview-ac4-a-");
  const dirB = mktmp("fixview-ac4-b-");
  const sessionA = path.join(stateDir, "sessions", "a.jsonl");
  writeSession(sessionA, dirA, [assistantEntry("A travaille")]);
  const sessionB = path.join(stateDir, "sessions", "b.jsonl");
  writeSession(sessionB, dirB, [assistantEntry("B travaille")]);
  const inboxA = panelInboxDirFor(stateDir, dirA);
  const inboxB = panelInboxDirFor(stateDir, dirB);
  liveEntry(stateDir, { cwd: dirA, label: "depot/a", phase: "impl", sessionFile: sessionA, inbox: inboxA });
  liveEntry(stateDir, { cwd: dirB, label: "depot/b", phase: "impl", sessionFile: sessionB, inbox: inboxB });

  // `sessionReply` arme la reprise d'un rang terminé : c'est lui qui ouvre une zone
  // d'écriture sur le rang d'historique où le brouillon d'A devra revenir.
  const panel = mountPanel(stateDir, { sessionReply: async () => null });
  selectLabel(panel, "depot/a");
  panel.component.handleInput("\r");
  for (const char of "ALPHA: renomme foo en bar") panel.component.handleInput(char);
  panel.component.handleInput("\r"); // aperçu
  panel.component.handleInput("\r"); // livraison dans la boîte d'A
  await flush();
  assert.deepEqual(deliveredTexts(inboxA), ["ALPHA: renomme foo en bar"], "le message part dans la boîte d'A");

  // On regarde B, et le run d'A meurt sans consommer : son reste ne doit pas se poser
  // dans la zone de B (il partait sinon au run de B au premier Entrée).
  panel.component.handleInput("\u001b");
  selectLabel(panel, "depot/b");
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /B travaille/);
  // Le run d'A meurt et son entrée devient un rang d'historique (même session) : sa
  // boîte n'est plus surveillée par personne, et son reste revient à SON rang.
  fs.rmSync(runningFile(stateDir, dirA));
  closedEntry(stateDir, { cwd: dirA, label: "depot/a", phase: "impl", sessionFile: sessionA });
  panel.component.refresh();
  const screen = panel.screen();
  assert.doesNotMatch(screen, /ALPHA: renomme foo en bar/, "le reste d'A ne se pose pas dans la zone de B");
  assert.match(screen, /message non transmis — le run est terminé \(1\)/, "la notice dit qu'un message est revenu");
  panel.component.handleInput("\r");
  panel.component.handleInput("\r");
  await flush();
  assert.deepEqual(deliveredTexts(inboxB), [], "aucun message d'A ne part au run de B");

  // Il est allé dans le BROUILLON d'A : rouvrir sa vue le restitue.
  panel.component.handleInput("\u001b");
  selectLabel(panel, "depot/a");
  panel.component.handleInput("\r");
  assert.match(panel.screen(), /Réponse : ALPHA: renomme foo en bar/, "le brouillon appartient à SON rang");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// VIEW-4 — le brouillon survit à l'arrivée d'un `ask`
// ---------------------------------------------------------------------------

test("fixview/AC-5 : le brouillon survit à l'arrivée d'une question", () => {
  const stateDir = path.join(mktmp("fixview-ac5-"), "pipeline");
  const repoRoot = mktmp("fixview-ac5-repo-");
  const worktree = mktmp("fixview-ac5-wt-");
  const session = path.join(stateDir, "sessions", "impl.jsonl");
  writeSession(session, worktree, [assistantEntry("IMPL: travail")]);
  const inbox = panelInboxDirFor(stateDir, worktree);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile: session, state: "running", phase: "impl" })]);
  liveEntry(stateDir, { cwd: worktree, sessionFile: session, label: "repo/alpha", phase: "impl", inbox });

  const panel = mountPanel(stateDir, { repoRoot });
  panel.component.handleInput("\r");
  for (const char of "attention au cache LRU") panel.component.handleInput(char);
  assert.match(panel.screen(), /Réponse : attention au cache LRU/, "le brouillon est dans l'éditeur");

  // Le maillon pose une question PENDANT que l'utilisateur tape : la zone change de
  // source, et le tampon ne doit pas disparaître sans trace.
  liveEntry(stateDir, {
    cwd: worktree,
    sessionFile: session,
    label: "repo/alpha",
    phase: "impl",
    inbox,
    pendingAsk: { toolCallId: "ask9", id: "q", question: "Continuer ?", options: [{ label: "oui" }] },
  });
  panel.component.refresh();
  const screen = panel.screen();
  assert.match(screen, /question : Continuer \?/, "la question prend la zone");
  assert.match(screen, /attention au cache LRU/, "le brouillon survit à l'arrivée de la question");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// VIEW-6 — une ligne de 300 Kio ne cache plus ce qui la précède
// ---------------------------------------------------------------------------

test("fixview/AC-6 : une ligne de 300 Kio laisse les entrées antérieures atteignables", () => {
  const stateDir = path.join(mktmp("fixview-ac6-"), "pipeline");
  const repoRoot = mktmp("fixview-ac6-repo-");
  const worktree = mktmp("fixview-ac6-wt-");
  const session = path.join(stateDir, "sessions", "big.jsonl");
  const before = Array.from({ length: 5 }, (_, i) => assistantEntry(`AVANT ${i}`));
  writeSession(session, worktree, [
    ...before,
    assistantEntry("je cherche", [{ id: "g1", name: "grep" }]),
    toolResultEntry("g1", "x".repeat(300 * 1024)),
  ]);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile: session, state: "done", phase: "review" })]);

  const panel = mountPanel(stateDir, { repoRoot });
  panel.component.handleInput("\r");
  const screen = panel.screen();
  // La ligne est plus grosse que la première peinture : elle n'est pas chargée, mais
  // elle est DITE — la vue ne part plus dans le vide.
  assert.match(screen, /entrée trop volumineuse \(300 Kio\) — non chargée/, "la ligne est nommée, jamais coupée en silence");
  assert.doesNotMatch(screen, /aucune entrée à afficher/, "la transcription n'est plus vide");

  // Et ce qui la précède reste atteignable : `Début` charge le bloc d'avant, où les
  // entrées antérieures sont ENTIÈRES.
  panel.component.handleInput("\u001b[H");
  assert.match(panel.screen(), /AVANT 0/, "les entrées antérieures sont atteignables");
  assert.match(panel.screen(), /AVANT 4/, "et elles sont là jusqu'à la dernière");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// VIEW-7 — quitter la vue LIBÈRE l'assemblage
// ---------------------------------------------------------------------------

test("fixview/AC-7 : Échap libère les composants de l'assemblage", () => {
  const stateDir = path.join(mktmp("fixview-ac7-"), "pipeline");
  const repoRoot = mktmp("fixview-ac7-repo-");
  const worktree = mktmp("fixview-ac7-wt-");
  const session = path.join(stateDir, "sessions", "impl.jsonl");
  // Un tour d'utilisateur et une carte d'outil SANS résultat : c'est elle qui
  // s'inscrit au ticker de l'hôte et demande un repaint toutes les 80 ms tant qu'elle
  // n'est pas libérée — panneau fermé compris.
  writeSession(session, worktree, [
    { type: "message", id: "u0", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: "lance" }] } },
    assistantEntry("j'appelle mem0", [{ id: "c0", name: "mem0_add" }]),
  ]);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile: session, state: "running", phase: "impl" })]);
  liveEntry(stateDir, { cwd: worktree, sessionFile: session, label: "repo/alpha", phase: "impl" });

  const { kit, released } = fakeKit();
  const panel = mountPanel(stateDir, { repoRoot, components: kit });
  panel.component.handleInput("\r");
  const screen = panel.screen();
  assert.match(screen, /▸ toi : lance/, "l'assemblage est peint");
  assert.match(screen, /→ mem0_add \[EN ATTENTE\]/, "la carte d'outil est en vol");
  assert.deepEqual(released, [], "rien n'est libéré tant qu'on reste dans la vue");

  panel.component.handleInput("\u001b");
  assert.ok(released.includes("UserMessageComponent"), "Échap libère les messages de l'assemblage");
  assert.ok(released.includes("ToolExecutionComponent"), "Échap libère la carte d'outil en vol");
  assert.ok(released.length >= 2, "l'assemblage entier est libéré, pas seulement sa tête");
  assert.equal(panel.closed(), 0, "Échap rend la liste, il ne ferme pas le panneau");

  // Le panneau FERMÉ depuis la vue libère aussi : c'est le dernier endroit où les
  // composants de l'assemblage sont atteignables.
  const second = fakeKit();
  const other = mountPanel(stateDir, { repoRoot, components: second.kit });
  other.component.handleInput("\r");
  other.component.render(120);
  assert.deepEqual(second.released, []);
  other.component.dispose();
  assert.ok(second.released.length >= 2, "fermer le panneau libère l'assemblage de la vue ouverte");
  panel.component.dispose();
});

// ---------------------------------------------------------------------------
// VIEW-11 — l'assemblage est BORNÉ comme la fenêtre d'entrées qui le nourrit
// ---------------------------------------------------------------------------

test("fixview/AC-8 : au-delà de la borne d'entrées, l'assemblage évince et libère", () => {
  const stateDir = path.join(mktmp("fixview-ac8-"), "pipeline");
  const repoRoot = mktmp("fixview-ac8-repo-");
  const worktree = mktmp("fixview-ac8-wt-");
  const session = path.join(stateDir, "sessions", "long.jsonl");
  writeSession(session, worktree, [assistantEntry("PREMIÈRE entrée")]);
  seedLot(stateDir, repoRoot, [feature("alpha", { worktree, sessionFile: session, state: "done", phase: "impl" })]);

  const { kit, released } = fakeKit();
  const panel = mountPanel(stateDir, { repoRoot, components: kit });
  panel.component.handleInput("\r");
  panel.component.render(100);

  // Douze rafraîchissements de 50 entrées : 601 au total, bien au-delà de la borne.
  const total = 12 * 50 + 1;
  for (let batch = 0; batch < 12; batch += 1) {
    fs.appendFileSync(
      session,
      `${Array.from({ length: 50 }, (_, i) => JSON.stringify(assistantEntry(`entrée ${batch}-${i}`))).join("\n")}\n`,
    );
    panel.component.refresh();
    panel.component.render(100);
  }
  assert.ok(total > SESSION_VIEW_MAX_ENTRIES, "le cas dépasse bien la borne d'entrées");
  // La fenêtre d'entrées est bornée, et l'assemblage la suit : les composants évincés
  // sont RETIRÉS et LIBÉRÉS, sans quoi 601 entrées faisaient 601 composants (et 601
  // `render` à chaque rafraîchissement).
  assert.equal(released.length, total - SESSION_VIEW_MAX_ENTRIES, "les entrées évincées sont libérées");
  const screen = panel.screen(100);
  assert.match(screen, /entrée 11-49/, "la fin de la session reste peinte");
  assert.match(screen, /… début tronqué/, "et la vue dit que le début n'est plus chargé");
  panel.component.dispose();
});
