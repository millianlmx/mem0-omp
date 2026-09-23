// Tests de la COMPOSITION du panneau /pipelines par les composants de l'hôte
// (feature `real-omp-session-on-opening-pipelines`, spec S-1, lot BR-1, critère AC-1).
//
// Le kit de l'hôte est INJECTÉ dans `pipelinesPanelFactory` (`deps.components`) :
// les tests montent donc un FAUX kit qui journalise ses constructions et rend des
// lignes mesurables. Ce qu'on mesure est ce que le panneau DEMANDE aux composants :
// il n'existe aucun rendu maison à épingler, et aucune assertion ne porte sur du
// texte de source.
//
// Le lot est un lot RÉEL écrit par `writeLot` dans un magasin temporaire, lu par le
// panneau comme il le serait par un autre process.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildPanelRows,
  cursorGlyph,
  displayWidth,
  hostComponents,
  lotRepoKey,
  LOT_VERSION,
  panelBudget,
  pipelinesPanelFactory,
  readLot,
  readPanelModel,
  wrapVisible,
  writeLot,
  type Lot,
  type LotFeature,
  type PanelComponent,
  type PanelGlyphs,
  type PanelModel,
  type PanelRow,
  type PanelTheme,
  type PipelinesPanelDeps,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Répertoires temporaires et horloge injectée
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

/** L'horloge injectée : le temps affiché est donc déterministe. */
const NOW = 1_700_000_000_000;

/** La hauteur du terminal des montages : le panneau remplit cette hauteur. */
const ROWS = 24;

const GLYPHS: PanelGlyphs = { cursor: ">" };

/** Le thème neutre : `fg`/`bg` rendent le texte tel quel, donc rien n'est codé en dur. */
const THEME = {
  fg: (_tone: string, text: string) => text,
  bg: (_tone: string, text: string) => text,
  nav: { cursor: ">" },
  boxRound: {},
};

/** Les touches : le panneau de LISTE n'en a besoin pour aucune bascule de vue. */
const KEYBINDINGS = { matches: () => false };

/** Les composants de MESSAGES du kit (S-3) : la liste ne les monte jamais. */
const MESSAGE_COMPONENT_NAMES = [
  "UserMessageComponent",
  "AssistantMessageComponent",
  "ToolExecutionComponent",
  "ReadToolGroupComponent",
  "CustomMessageComponent",
  "BashExecutionComponent",
  "CompactionSummaryMessageComponent",
  "BranchSummaryMessageComponent",
];

// ---------------------------------------------------------------------------
// Un lot RÉEL (patron de test/lot.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Le faux kit de l'hôte : il JOURNALISE ses constructions et rend des lignes
// mesurables. Chaque constructeur pousse son nom dans le journal partagé.
// ---------------------------------------------------------------------------

type FakeComp = {
  kind: string;
  /** Les lignes rendues au DERNIER `render`. */
  lines: string[];
  /** `Text` : le texte reçu (jamais mis au cadre par le panneau). */
  text?: string;
  /** `DynamicBorder` : la dernière largeur reçue. */
  width?: number;
  /** `Spacer` : les `setLines` reçus. */
  setLinesCalls?: number[];
  /** `Container` : ses enfants, dans l'ordre d'ajout. */
  children?: FakeComp[];
};

function fakeKit() {
  const built: FakeComp[] = [];

  class FakeText {
    readonly kind = "Text";
    lines: string[] = [];
    width = 0;
    text: string;
    paddingX: number;
    styleFn?: (text: string) => string;
    background?: (text: string) => string;
    constructor(text = "", paddingX = 1, _paddingY = 0, background?: (text: string) => string) {
      this.text = text;
      this.paddingX = paddingX;
      this.background = background;
      built.push(this as FakeComp);
    }
    setText(text: string): boolean {
      const changed = text !== this.text;
      this.text = text;
      return changed;
    }
    setStyleFn(fn?: (text: string) => string): this {
      this.styleFn = fn;
      return this;
    }
    render(width: number): readonly string[] {
      this.width = width;
      if (this.text.trim() === "") {
        this.lines = [];
        return [];
      }
      const content = Math.max(1, width - this.paddingX * 2);
      const styled = this.styleFn ? this.styleFn(this.text) : this.text;
      this.lines = wrapVisible(styled, content).map((line) => {
        const padded = `${" ".repeat(this.paddingX)}${line}`;
        const filled = padded + " ".repeat(Math.max(0, width - displayWidth(padded)));
        return this.background ? this.background(filled) : filled;
      });
      return this.lines;
    }
  }

  class FakeBorder {
    readonly kind = "DynamicBorder";
    lines: string[] = [];
    width = 0;
    color?: (text: string) => string;
    constructor(color?: (text: string) => string) {
      this.color = color;
      built.push(this as FakeComp);
    }
    render(width: number): readonly string[] {
      this.width = width;
      const rule = "─".repeat(Math.max(1, width));
      this.lines = [this.color ? this.color(rule) : rule];
      return this.lines;
    }
  }

  class FakeSpacer {
    readonly kind = "Spacer";
    lines: string[] = [];
    setLinesCalls: number[] = [];
    count: number;
    constructor(count = 1) {
      this.count = count;
      built.push(this as FakeComp);
    }
    setLines(count: number): void {
      this.setLinesCalls.push(count);
      this.count = count;
    }
    render(): readonly string[] {
      this.lines = new Array<string>(Math.max(0, this.count)).fill("");
      return this.lines;
    }
  }

  class FakeContainer {
    readonly kind = "Container";
    lines: string[] = [];
    children: FakeComp[] = [];
    constructor() {
      built.push(this as FakeComp);
    }
    addChild(child: FakeComp): void {
      this.children.push(child);
    }
    render(width: number): readonly string[] {
      this.lines = this.children.flatMap((child) => [...child.render(width)]);
      return this.lines;
    }
  }

  /** Un composant de message INERTE : il rend une ligne, la liste ne le monte pas. */
  function inert(name: string) {
    return class {
      readonly kind = name;
      lines: string[] = [name];
      constructor(..._args: unknown[]) {
        built.push(this as unknown as FakeComp);
      }
      render(): readonly string[] {
        return this.lines;
      }
      setExpanded(): void {}
      setImagesVisible(): void {}
      setToolResultImagesVisible(): void {}
      updateArgs(): void {}
      setArgsComplete(): void {}
      setExecutionStarted(): void {}
      updateResult(): void {}
      appendOutput(): void {}
      setComplete(): void {}
      addChild(): void {}
      dispose(): void {}
    };
  }

  const kit: Record<string, unknown> = {
    Text: FakeText,
    DynamicBorder: FakeBorder,
    Container: FakeContainer,
    Spacer: FakeSpacer,
    theme: THEME,
  };
  for (const name of MESSAGE_COMPONENT_NAMES) kit[name] = inert(name);

  return { kit, built };
}

// ---------------------------------------------------------------------------
// Montage : la VRAIE fabrique du panneau, avec ses dépendances injectées
// ---------------------------------------------------------------------------

/** Le panneau monté, plus le journal des composants construits par chaque rendu. */
type PanelHarness = {
  component: PanelComponent;
  built: FakeComp[];
  /** Rend à une (largeur, hauteur) données ; `fresh` = les composants construits par ce rendu. */
  paint(width: number, height?: number): { lines: string[]; fresh: FakeComp[] };
};

function mountPanel(stateDir: string, over: Partial<PipelinesPanelDeps> = {}, theme: PanelTheme = THEME): PanelHarness {
  const { kit, built } = fakeKit();
  const deps: PipelinesPanelDeps = {
    stateDir,
    components: kit as unknown as PipelinesPanelDeps["components"],
    now: () => NOW,
    // Aucune minuterie réelle : le rafraîchissement périodique n'est pas exercé ici.
    schedule: () => () => {},
    join: () => {},
    ...over,
  };
  const tui = { terminal: { rows: ROWS }, requestRender: () => {} };
  const component = pipelinesPanelFactory(deps)(tui, theme, KEYBINDINGS, () => {});
  return {
    component,
    built,
    /**
     * Rend à une (largeur, hauteur) données et rend les composants CONSTRUITS par
     * ce rendu — la mémoïsation du panneau fait qu'une même clé ne reconstruit rien.
     */
    paint(width: number, height = ROWS) {
      tui.terminal.rows = height;
      const mark = built.length;
      const lines = component.render(width);
      return { lines, fresh: built.slice(mark) };
    },
  };
}

/**
 * Le contrat de composition de S-1, vérifié sur un rendu réel :
 * (a) le cadre vient de `DynamicBorder` et chaque règle occupe EXACTEMENT la largeur reçue ;
 * (b) chaque rang de contenu vient d'un `Text` DISTINCT, et le panneau lui remet le rang TEL QUEL ;
 * (c) le rang de remplissage vient d'un `Spacer` réglé à `n > 0`.
 */
function assertHostComposition(panel: PanelHarness, model: PanelModel, label: string, width = 64) {
  const { lines, fresh } = panel.paint(width);

  // (a) le cadre
  const borders = fresh.filter((c) => c.kind === "DynamicBorder");
  assert.ok(borders.length >= 1, `${label} : au moins un DynamicBorder est construit`);
  for (const border of borders) {
    assert.ok(border.lines.length >= 1, `${label} : une règle rend au moins une ligne`);
    for (const line of border.lines) {
      assert.equal(displayWidth(line), width, `${label} : une ligne de règle fait EXACTEMENT la largeur reçue`);
    }
  }
  const ruleLines = new Set(borders.flatMap((b) => b.lines));

  // (b) les rangs de contenu, dans l'ordre du panneau
  const texts = fresh.filter((c) => c.kind === "Text");
  const contentLines = lines.filter((line) => line.trim() !== "" && !ruleLines.has(line));
  assert.deepEqual(
    contentLines,
    texts.flatMap((t) => t.lines),
    `${label} : chaque rang de contenu vient d'un Text distinct, dans l'ordre`,
  );
  assert.ok(texts.length >= contentLines.length, `${label} : au moins un Text par rang de contenu`);

  const rows = buildPanelRows(model, { width, budget: panelBudget(ROWS), glyphs: GLYPHS, now: NOW });
  const expectedRows: PanelRow[] = rows.filter((row) => row.rule === undefined && row.fill !== true);
  assert.deepEqual(
    texts.map((t) => t.text),
    expectedRows.map((row) => row.text),
    `${label} : chaque rang de contenu est remis TEL QUEL à son Text`,
  );

  // (c) le remplissage
  const spacers = fresh.filter((c) => c.kind === "Spacer");
  assert.ok(spacers.length >= 1, `${label} : le rang de remplissage vient d'un Spacer`);
  const filled = spacers.filter((s) => (s.setLinesCalls ?? []).some((n) => n > 0));
  assert.equal(filled.length, 1, `${label} : un seul Spacer réglé à n > 0`);
  assert.ok((filled[0]?.lines.length ?? 0) > 0, `${label} : le Spacer occupe des lignes`);
  assert.ok((filled[0]?.lines ?? []).every((line) => line === ""), `${label} : le remplissage ne peint rien`);

  return { lines, fresh, texts };
}

// ---------------------------------------------------------------------------
// AC-1 — le kit lu sur `pi.pi`
// ---------------------------------------------------------------------------

test("hostComponents lit le kit complet sur pi.pi", () => {
  const { kit } = fakeKit();
  const pi = { pi: kit };
  assert.equal(hostComponents(pi), kit, "le kit complet est rendu tel quel, sans copie");
});

test("hostComponents refuse tout kit incomplet", () => {
  const { kit } = fakeKit();
  assert.notEqual(hostComponents({ pi: kit }), null, "le faux kit porte bien tous les noms requis");

  assert.equal(hostComponents(undefined), null, "aucun namespace");
  assert.equal(hostComponents({}), null, "aucun pi.pi");
  assert.equal(hostComponents({ pi: null }), null, "pi.pi nul");
  assert.equal(hostComponents({ pi: {} }), null, "pi.pi vide");
  assert.equal(hostComponents({ pi: 42 }), null, "pi.pi d'un autre type");

  // Un nom requis absent — quel qu'il soit — vaut un refus, jamais un rendu partiel.
  for (const name of ["Spacer", "theme", ...MESSAGE_COMPONENT_NAMES, "Text", "Container"]) {
    const incomplete: Record<string, unknown> = { ...kit };
    delete incomplete[name];
    assert.equal(hostComponents({ pi: incomplete }), null, `sans ${name}, le kit est refusé`);
  }

  // La FORME de chaque nom est vérifiée : `theme` est un objet, les autres des constructeurs.
  assert.equal(hostComponents({ pi: { ...kit, theme: null } }), null, "theme nul");
  assert.equal(hostComponents({ pi: { ...kit, theme: () => ({}) } }), null, "theme qui n'est pas un objet");
  assert.equal(hostComponents({ pi: { ...kit, Text: {} } }), null, "Text qui n'est pas un constructeur");
});

// ---------------------------------------------------------------------------
// AC-1 — le panneau est composé par les composants de l'hôte
// ---------------------------------------------------------------------------

test("components/AC-1 : le panneau est rendu par les composants de l'hôte", () => {
  const stateDir = mktmp("components-render-");
  const repoRoot = mktmp("components-render-repo-");

  // Sans lot : le panneau s'affiche quand même (sections vides, cadre, pied).
  const withoutLot = assertHostComposition(mountPanel(stateDir), readPanelModel({ stateDir }), "sans lot");

  // Avec un lot RÉEL écrit sur le disque et relu par le panneau.
  seedLot(stateDir, repoRoot, [feature("zorglub"), feature("zorglub-2", { deps: ["zorglub"] })]);
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))?.features.length, 2, "le lot est bien écrit sur le disque");
  const withLot = assertHostComposition(
    mountPanel(stateDir, { repoRoot }),
    readPanelModel({ stateDir, repoRoot }),
    "avec lot",
  );

  // Le lot est bien celui du disque : la section du lot porte son slug.
  assert.ok(
    withLot.texts.some((t) => (t.text ?? "").includes("zorglub")),
    "avec lot : le panneau rend la feature lue sur le disque",
  );
  assert.ok(
    withoutLot.texts.every((t) => !(t.text ?? "").includes("zorglub")),
    "sans lot : aucune feature n'est rendue",
  );
});

test("aucun rang ne dépasse la largeur reçue", () => {
  const stateDir = mktmp("components-width-");
  const repoRoot = mktmp("components-width-repo-");
  const panels = [{ label: "sans lot", panel: mountPanel(stateDir) }];
  seedLot(stateDir, repoRoot, [feature("une"), feature("deux", { deps: ["une"] })]);
  panels.push({ label: "avec lot", panel: mountPanel(stateDir, { repoRoot }) });

  for (const { label, panel } of panels) {
    for (const width of [20, 31, 64, 120]) {
      const { lines, fresh } = panel.paint(width);
      assert.ok(lines.length > 0, `${label} @${width} : le panneau rend des lignes`);
      for (const line of lines) {
        assert.ok(
          displayWidth(line) <= width,
          `${label} @${width} : aucun rang ne dépasse la largeur reçue — ${JSON.stringify(line)}`,
        );
      }
      const borders = fresh.filter((c) => c.kind === "DynamicBorder");
      assert.ok(borders.length >= 1, `${label} @${width} : le cadre vient d'un DynamicBorder`);
      for (const border of borders) {
        for (const line of border.lines) {
          assert.equal(displayWidth(line), width, `${label} @${width} : une règle occupe exactement la largeur`);
        }
      }
    }
  }
});

test("un kit absent refuse le panneau", () => {
  const stateDir = mktmp("components-nokit-");
  const panel = mountPanel(stateDir, { components: null });

  const { lines, fresh } = panel.paint(80);
  assert.deepEqual(
    lines,
    ["[pipeline] panneau indisponible : composants de l'hôte absents (OMP)"],
    "le refus est UNE ligne, au message exact",
  );
  assert.equal(fresh.length, 0, "aucun composant de l'hôte n'est construit sans kit");
  assert.deepEqual(panel.paint(80).lines, lines, "le refus est stable d'un rendu à l'autre");

  for (const key of ["a", "\r", "q", "\u001b[B", "\u001b[<0;1;1M"]) {
    assert.doesNotThrow(() => panel.component.handleInput(key), `aucune touche ne jette : ${JSON.stringify(key)}`);
  }
  assert.doesNotThrow(() => panel.component.refresh());
  assert.doesNotThrow(() => panel.component.dispose());
});

test("aucune ligne du panneau n'est composée hors des composants", () => {
  const stateDir = mktmp("components-compose-");
  const repoRoot = mktmp("components-compose-repo-");

  const check = (label: string, panel: PanelHarness): void => {
    const { lines, fresh } = panel.paint(64);
    const containers = fresh.filter((c) => c.kind === "Container");
    assert.equal(containers.length, 1, `${label} : un seul conteneur assemble le panneau`);
    const container = containers[0]!;
    const composed = fresh.filter((c) => c.kind !== "Container");

    assert.equal(
      container.children?.length ?? 0,
      composed.length,
      `${label} : tout composant construit est un enfant du conteneur`,
    );
    assert.ok(
      composed.every((c) => (container.children ?? []).includes(c)),
      `${label} : les enfants du conteneur sont EXACTEMENT les composants construits`,
    );
    assert.deepEqual(lines, container.lines, `${label} : les lignes rendues sont EXACTEMENT celles du conteneur`);
    assert.equal(
      composed.reduce((count, c) => count + c.lines.length, 0),
      lines.length,
      `${label} : le nombre de lignes rendues est la somme des lignes des composants`,
    );

    for (const name of MESSAGE_COMPONENT_NAMES) {
      assert.ok(!fresh.some((c) => c.kind === name), `${label} : la liste ne monte aucun ${name}`);
    }
  };

  check("sans lot", mountPanel(stateDir));
  seedLot(stateDir, repoRoot, [feature("une")]);
  check("avec lot", mountPanel(stateDir, { repoRoot }));
});

// ---------------------------------------------------------------------------
// S-1 « Cas limites et erreurs » — rattachés à l'AC-1 : les deux replis exigés
// (un thème sans `nav.cursor`, un composant de l'hôte qui jette au RENDU). Ni
// l'un ni l'autre ne sort de l'overlay.
//
// Ces preuves portent l'id de SPEC, pas `components/AC-1` : l'invariant
// d'unicité (`criteria/AC-13`) veut qu'un id qualifié ne désigne qu'UN test —
// celui du panneau composé reste `components/AC-1`, et la traçabilité de
// l'AC-1 vers ces cas passe par S-1.
// ---------------------------------------------------------------------------

test("S-1 : un thème sans nav.cursor replie sur le curseur ASCII, jamais une exception", () => {
  const stateDir = mktmp("components-theme-");
  const repoRoot = mktmp("components-theme-repo-");
  seedLot(stateDir, repoRoot, [feature("zora"), feature("zora-2")]);

  // La lecture PURE du glyphe : le repli est `>`, et un curseur fourni est respecté.
  assert.equal(cursorGlyph(undefined), ">", "aucun thème : curseur ASCII");
  assert.equal(cursorGlyph({}), ">", "thème vide : curseur ASCII");
  assert.equal(cursorGlyph({ nav: null }), ">", "nav nul : curseur ASCII");
  assert.equal(cursorGlyph({ nav: {} }), ">", "nav sans cursor : curseur ASCII");
  assert.equal(cursorGlyph({ nav: { cursor: "" } }), ">", "curseur vide : curseur ASCII");
  assert.equal(cursorGlyph({ nav: { cursor: 7 } }), ">", "curseur d'un autre type : curseur ASCII");
  assert.equal(cursorGlyph({ nav: { cursor: "❯" } }), "❯", "un curseur fourni est le glyphe du rang");

  // La validation du KIT : `fg` est requis (il peint chaque rang du panneau),
  // `nav.cursor` ne l'est pas — c'est le repli qui s'en charge au montage.
  const { kit } = fakeKit();
  assert.equal(
    hostComponents({ pi: { ...kit, theme: { nav: { cursor: ">" } } } }),
    null,
    "un thème sans fg est un kit incomplet : refusé au montage",
  );
  assert.notEqual(
    hostComponents({ pi: { ...kit, theme: { fg: THEME.fg } } }),
    null,
    "un thème sans nav est accepté : ses glyphes se replient",
  );

  // Le montage RÉEL, aux formes du thème d'une autre version : aucune ne jette, et
  // toutes replient sur le curseur ASCII — sauf un curseur fourni, qui est respecté.
  const cases: Array<{ label: string; theme: unknown; cursor: string }> = [
    { label: "sans nav", theme: { fg: THEME.fg, bg: THEME.bg }, cursor: ">" },
    { label: "nav vide", theme: { fg: THEME.fg, bg: THEME.bg, nav: {} }, cursor: ">" },
    { label: "curseur vide", theme: { fg: THEME.fg, bg: THEME.bg, nav: { cursor: "" } }, cursor: ">" },
    { label: "sans boxRound", theme: { fg: THEME.fg, bg: THEME.bg, nav: { cursor: ">" } }, cursor: ">" },
    { label: "curseur de l'hôte", theme: { fg: THEME.fg, bg: THEME.bg, nav: { cursor: "❯" } }, cursor: "❯" },
  ];
  for (const { label, theme, cursor } of cases) {
    const panel = mountPanel(stateDir, { repoRoot }, theme as PanelTheme);
    const { lines } = panel.paint(64);
    assert.ok(lines.length > 0, `${label} : le panneau s'affiche`);
    const selected = lines.filter((line) => line.trimStart().startsWith(`${cursor} `));
    assert.equal(selected.length, 1, `${label} : la sélection porte le curseur « ${cursor} »`);
    assert.match(selected[0] as string, /zora/, `${label} : et c'est bien le rang sélectionné`);
    for (const line of lines) {
      assert.ok(displayWidth(line) <= 64, `${label} : aucun rang ne dépasse la largeur reçue`);
    }
    assert.doesNotThrow(() => panel.component.dispose());
  }
});

test("S-1 : un composant qui jette au rendu devient un rang lisible, le panneau reste ouvert", () => {
  const stateDir = mktmp("components-throw-");
  const repoRoot = mktmp("components-throw-repo-");
  seedLot(stateDir, repoRoot, [feature("zora")]);

  const { kit } = fakeKit();
  /** Le `DynamicBorder` d'une AUTRE version : il ne jette qu'au RENDU. */
  class DynamicBorder {
    constructor(_color?: (text: string) => string) {}
    render(): readonly string[] {
      throw new Error("règle cassée");
    }
  }
  const broken = { ...kit, DynamicBorder } as unknown as PipelinesPanelDeps["components"];
  const panel = mountPanel(stateDir, { repoRoot, components: broken });

  const lines = panel.paint(64).lines;
  const error = lines.find((line) => line.includes("entrée illisible — DynamicBorder : règle cassée"));
  assert.ok(error !== undefined, `le rang d'erreur nomme le composant fautif : ${JSON.stringify(lines)}`);
  assert.ok(
    lines.some((line) => line.includes("zora")),
    "le reste du panneau est peint : toutes les autres lignes sont là",
  );
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 64, `aucun rang ne dépasse la largeur reçue — ${JSON.stringify(line)}`);
  }

  // Le panneau reste OUVERT et vivant : le rendu est mémoïsé (aucune repeinture),
  // les touches agissent, et un rendu suivant ne jette pas davantage.
  assert.deepEqual(panel.paint(64).lines, lines, "rien n'a changé : le panneau reste stable");
  assert.doesNotThrow(() => panel.component.handleInput("\u001b[B"));
  assert.doesNotThrow(() => panel.component.handleInput("q"));
  const after = panel.paint(64).lines;
  assert.ok(after.length > 0, "le panneau rend toujours après les touches");
  assert.doesNotThrow(() => panel.component.dispose());
});

test("S-1 : une composition qui jette laisse le panneau ouvert sur un rang lisible", () => {
  const stateDir = mktmp("components-broken-");
  const repoRoot = mktmp("components-broken-repo-");
  seedLot(stateDir, repoRoot, [feature("zora")]);

  const { kit } = fakeKit();
  /** Le conteneur d'une AUTRE version : il jette dès sa construction. */
  class Container {
    constructor() {
      throw new Error("conteneur cassé");
    }
  }
  const panel = mountPanel(stateDir, {
    repoRoot,
    components: { ...kit, Container } as unknown as PipelinesPanelDeps["components"],
  });

  const lines = panel.paint(64).lines;
  assert.equal(lines.length, 1, "le dernier recours est UN rang, jamais une sortie de l'overlay");
  assert.match(lines[0] as string, /entrée illisible — panneau : conteneur cassé/, "et il dit ce qui a échoué");
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 64, `aucun rang ne dépasse la largeur reçue — ${JSON.stringify(line)}`);
  }
  assert.doesNotThrow(() => panel.component.handleInput("\u001b[B"));
  assert.doesNotThrow(() => panel.component.refresh());
  assert.doesNotThrow(() => panel.component.dispose());
});
