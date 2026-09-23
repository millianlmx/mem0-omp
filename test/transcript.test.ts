// Tests de l'assembleur entrée → composants de l'hôte (BR-3, S-3 / S-4) : c'est
// lui qui fait qu'une pipeline ouverte se lit comme une session d'OMP — chaque
// rôle produit LE composant de l'hôte, les résultats d'outils mettent à jour la
// carte de leur appel sans rien créer, les lectures consécutives se replient, et
// la bascule globale de dépliage atteint toutes les cartes.
//
// Le kit de composants est FAUX et ENREGISTRE : chaque construction est retenue
// avec ses arguments, chaque appel de méthode aussi. Les assertions portent donc
// sur ce que l'assembleur DEMANDE aux composants de l'hôte (classe attendue,
// arguments clés, ordre), jamais sur un rendu maison — il n'y en a plus.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyExpanded,
  buildSessionComponents,
  splitAssistantToolTimeline,
  toolUi,
  type HostComponents,
  type SessionAssembly,
  type SessionEntryLike,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Répertoire temporaire (le `cwd` que les cartes d'outil reçoivent)
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

/** La racine de dépôt que l'assembleur transmet aux cartes d'outil. */
const CWD = mktmp("omp-transcript-");

/** La surface de repaint des cartes d'outil : trois façons de demander un rendu. */
const UI = toolUi({ terminal: { rows: 24 }, requestRender: () => {} });

// ---------------------------------------------------------------------------
// Le faux kit : chaque composant construit et chaque appel reçu sont enregistrés
// ---------------------------------------------------------------------------

type Call = { name: string; args: unknown[] };
type Built = { kind: string; comp: FakeComponent };

/** La base des faux composants : les appels reçus et les bascules de pliage. */
class FakeComponent {
  readonly calls: Call[] = [];
  readonly expandedValues: boolean[] = [];
  /** Les arguments du constructeur, tels que l'assembleur les a passés. */
  ctorArgs: unknown[] = [];
  render(_width: number): readonly string[] {
    return [`<${this.constructor.name}>`];
  }
  callsNamed(name: string): unknown[][] {
    return this.calls.filter((call) => call.name === name).map((call) => call.args);
  }
  protected note(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }
}

type FakeUser = FakeComponent & { text: string; options?: { synthetic?: boolean } };
type FakeAssistant = FakeComponent & { message: Record<string, unknown> };
type FakeTool = FakeComponent & {
  toolName: string;
  args: unknown;
  options: unknown;
  tool: unknown;
  ui: unknown;
  cwd?: string;
  toolCallId?: string;
};
type FakeCustom = FakeComponent & { message: Record<string, unknown>; renderer: unknown };
type FakeBash = FakeComponent & { command: string; ui: unknown; excludeFromContext?: boolean };
type FakeText = FakeComponent & { text: string };

/**
 * Le kit de l'hôte, en faux : les classes portent le NOM de celles de l'hôte (les
 * assertions lisent donc directement la classe attendue) et n'exposent que les
 * méthodes que l'assembleur appelle. `throwOnAssistant` simule une entrée que le
 * composant de l'hôte refuse de construire.
 */
function mkKit(options: { throwOnAssistant?: boolean } = {}) {
  const built: Built[] = [];
  const keep = <T extends FakeComponent>(comp: T): T => {
    built.push({ kind: comp.constructor.name, comp });
    return comp;
  };

  // Inertes : ils ne servent qu'à remplir une ligne.
  class Text extends FakeComponent {
    text: string;
    constructor(text = "", paddingX?: number, paddingY?: number, background?: unknown) {
      super();
      this.text = text;
      this.ctorArgs = [text, paddingX, paddingY, background];
      keep(this);
    }
  }
  class DynamicBorder extends FakeComponent {
    constructor(color?: unknown) {
      super();
      this.ctorArgs = [color];
      keep(this);
    }
  }
  class Container extends FakeComponent {
    constructor() {
      super();
      keep(this);
    }
  }
  class Spacer extends FakeComponent {
    constructor(lines?: number) {
      super();
      this.ctorArgs = [lines];
      keep(this);
    }
  }

  class UserMessageComponent extends FakeComponent {
    text: string;
    options?: { synthetic?: boolean };
    constructor(text: string, options?: { synthetic?: boolean }) {
      super();
      this.text = text;
      this.options = options;
      this.ctorArgs = [text, options];
      keep(this);
    }
  }

  class AssistantMessageComponent extends FakeComponent {
    message: unknown;
    constructor(
      message?: unknown,
      hideThinkingBlock?: unknown,
      onImageUpdate?: unknown,
      thinkingRenderers?: unknown,
      imageBudget?: unknown,
      proseOnlyThinking?: unknown,
      linkTargets?: unknown,
    ) {
      super();
      if (options.throwOnAssistant) throw new Error("le composant de l'hôte refuse ce message");
      this.message = message;
      this.ctorArgs = [message, hideThinkingBlock, onImageUpdate, thinkingRenderers, imageBudget, proseOnlyThinking, linkTargets];
      keep(this);
    }
    setImagesVisible(visible: boolean): void {
      this.note("setImagesVisible", visible);
    }
    setToolResultImagesVisible(visible: boolean): void {
      this.note("setToolResultImagesVisible", visible);
    }
    setExpanded(expanded: boolean): void {
      this.note("setExpanded", expanded);
      this.expandedValues.push(expanded);
    }
  }

  class ToolExecutionComponent extends FakeComponent {
    toolName: string;
    args: unknown;
    options: unknown;
    tool: unknown;
    ui: unknown;
    cwd?: string;
    toolCallId?: string;
    constructor(toolName: string, args: unknown, options: unknown, tool: unknown, ui: unknown, cwd?: string, toolCallId?: string) {
      super();
      this.toolName = toolName;
      this.args = args;
      this.options = options;
      this.tool = tool;
      this.ui = ui;
      this.cwd = cwd;
      this.toolCallId = toolCallId;
      this.ctorArgs = [toolName, args, options, tool, ui, cwd, toolCallId];
      keep(this);
    }
    updateArgs(args: unknown, toolCallId?: string): void {
      this.note("updateArgs", args, toolCallId);
    }
    setArgsComplete(toolCallId?: string): void {
      this.note("setArgsComplete", toolCallId);
    }
    setExecutionStarted(toolCallId?: string): void {
      this.note("setExecutionStarted", toolCallId);
    }
    updateResult(result: unknown, isPartial?: boolean, toolCallId?: string): void {
      this.note("updateResult", result, isPartial, toolCallId);
    }
    setExpanded(expanded: boolean): void {
      this.note("setExpanded", expanded);
      this.expandedValues.push(expanded);
    }
  }

  class ReadToolGroupComponent extends FakeComponent {
    options?: unknown;
    constructor(groupOptions?: unknown) {
      super();
      this.options = groupOptions;
      this.ctorArgs = [groupOptions];
      keep(this);
    }
    updateArgs(args: unknown, toolCallId?: string): void {
      this.note("updateArgs", args, toolCallId);
    }
    setArgsComplete(toolCallId?: string): void {
      this.note("setArgsComplete", toolCallId);
    }
    setExecutionStarted(toolCallId?: string): void {
      this.note("setExecutionStarted", toolCallId);
    }
    updateResult(result: unknown, isPartial?: boolean, toolCallId?: string): void {
      this.note("updateResult", result, isPartial, toolCallId);
    }
    setExpanded(expanded: boolean): void {
      this.note("setExpanded", expanded);
      this.expandedValues.push(expanded);
    }
  }

  class CustomMessageComponent extends FakeComponent {
    message: unknown;
    renderer: unknown;
    constructor(message: unknown, renderer?: unknown) {
      super();
      this.message = message;
      this.renderer = renderer;
      this.ctorArgs = [message, renderer];
      keep(this);
    }
    setExpanded(expanded: boolean): void {
      this.note("setExpanded", expanded);
      this.expandedValues.push(expanded);
    }
  }

  class BashExecutionComponent extends FakeComponent {
    command: string;
    ui: unknown;
    excludeFromContext?: boolean;
    constructor(command: string, ui: unknown, excludeFromContext?: boolean) {
      super();
      this.command = command;
      this.ui = ui;
      this.excludeFromContext = excludeFromContext;
      this.ctorArgs = [command, ui, excludeFromContext];
      keep(this);
    }
    appendOutput(chunk: string): void {
      this.note("appendOutput", chunk);
    }
    setComplete(exitCode: number | undefined, cancelled: boolean, completeOptions?: unknown): void {
      this.note("setComplete", exitCode, cancelled, completeOptions);
    }
    setExpanded(expanded: boolean): void {
      this.note("setExpanded", expanded);
      this.expandedValues.push(expanded);
    }
  }

  class CompactionSummaryMessageComponent extends FakeComponent {
    message: unknown;
    constructor(message: unknown) {
      super();
      this.message = message;
      this.ctorArgs = [message];
      keep(this);
    }
    setExpanded(expanded: boolean): void {
      this.note("setExpanded", expanded);
      this.expandedValues.push(expanded);
    }
  }

  class BranchSummaryMessageComponent extends FakeComponent {
    message: unknown;
    constructor(message: unknown) {
      super();
      this.message = message;
      this.ctorArgs = [message];
      keep(this);
    }
    setExpanded(expanded: boolean): void {
      this.note("setExpanded", expanded);
      this.expandedValues.push(expanded);
    }
  }

  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    nav: { cursor: ">" },
  };

  const kit = {
    Text,
    DynamicBorder,
    Container,
    Spacer,
    theme,
    UserMessageComponent,
    AssistantMessageComponent,
    ToolExecutionComponent,
    ReadToolGroupComponent,
    CustomMessageComponent,
    BashExecutionComponent,
    CompactionSummaryMessageComponent,
    BranchSummaryMessageComponent,
  };

  return {
    kit,
    built,
    /** La suite des classes construites, dans l'ordre. */
    kinds: (): string[] => built.map((entry) => entry.kind),
    count: (kind: string): number => built.filter((entry) => entry.kind === kind).length,
    /** Les instances construites d'une classe, dans l'ordre. */
    comps: <T extends FakeComponent = FakeComponent>(kind: string): T[] =>
      built.filter((entry) => entry.kind === kind).map((entry) => entry.comp as T),
  };
}

// ---------------------------------------------------------------------------
// Fabriques d'entrées et lancement de l'assembleur
// ---------------------------------------------------------------------------

function messageEntry(id: string, message: Record<string, unknown>, at = 0): SessionEntryLike {
  return { type: "message", at, id, timestamp: "2026-09-23T00:00:00.000Z", message };
}

function customEntry(id: string, over: Partial<{ display: boolean; content: unknown }> = {}): SessionEntryLike {
  return {
    type: "custom_message",
    at: 0,
    id,
    timestamp: "2026-09-23T00:00:00.000Z",
    customType: "pipeline",
    content: "la chaîne prend la main",
    display: true,
    ...over,
  };
}

function otherEntry(id: string): SessionEntryLike {
  return { type: "other", at: 0, id, timestamp: "2026-09-23T00:00:00.000Z" };
}

function build(
  entries: SessionEntryLike[],
  kit: HostComponents,
  over: Partial<{ expanded: boolean; previous: SessionAssembly | null }> = {},
): SessionAssembly {
  return buildSessionComponents(entries, { components: kit, ui: UI, cwd: CWD, ...over });
}

function assistant(calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>, texts: string[] = []): Record<string, unknown> {
  return {
    role: "assistant",
    content: [
      ...texts.map((text) => ({ type: "text", text })),
      ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} })),
    ],
  };
}

// ---------------------------------------------------------------------------
// AC-3 — la table de correspondance rôle → composant de l'hôte
// ---------------------------------------------------------------------------

test("transcript/AC-3 : chaque rôle produit le composant de l'hôte qui lui correspond", () => {
  const kit = mkKit();
  const entries: SessionEntryLike[] = [
    messageEntry("e1", { role: "user", content: [{ type: "text", text: "bonjour" }] }),
    messageEntry("e2", {
      role: "assistant",
      content: [
        { type: "text", text: "je lance" },
        { type: "toolCall", id: "c0", name: "bash", arguments: { command: "ls" } },
        { type: "text", text: "fini" },
      ],
    }),
    messageEntry("e3", {
      role: "toolResult",
      toolCallId: "c0",
      toolName: "bash",
      content: [{ type: "text", text: "a.ts" }],
      isError: false,
    }),
    customEntry("e4"),
    messageEntry("e5", { role: "custom", customType: "pipeline", content: "note d'affichage", display: true }),
    messageEntry("e6", { role: "bashExecution", command: "npm test", output: "ok", exitCode: 0, cancelled: false }),
    messageEntry("e7", { role: "compactionSummary", summary: "résumé de compaction" }),
  ];
  const assembly = build(entries, kit.kit as unknown as HostComponents);

  // L'ORDRE du fichier, et rien d'autre : la classe de l'hôte attendue par rôle.
  assert.deepEqual(kit.kinds(), [
    "UserMessageComponent",
    "AssistantMessageComponent",
    "ToolExecutionComponent",
    "AssistantMessageComponent",
    "CustomMessageComponent",
    "CustomMessageComponent",
    "BashExecutionComponent",
    "CompactionSummaryMessageComponent",
  ]);
  assert.equal(assembly.components.length, kit.built.length, "l'ordre d'affichage est celui des constructions");

  // Message utilisateur : son TEXTE (les blocs `text` concaténés).
  const user = kit.comps<FakeUser>("UserMessageComponent")[0];
  assert.equal(user.text, "bonjour");
  assert.equal(user.options, undefined, "un message utilisateur ordinaire n'est pas synthétique");

  // Appel d'outil : le NOM, les ARGUMENTS, la racine et l'identifiant de l'appel.
  const tool = kit.comps<FakeTool>("ToolExecutionComponent")[0];
  assert.equal(tool.toolName, "bash");
  assert.deepEqual(tool.args, { command: "ls" });
  assert.equal(tool.cwd, CWD);
  assert.equal(tool.toolCallId, "c0");
  assert.deepEqual(tool.callsNamed("setArgsComplete"), [["c0"]], "l'appel est passé, donc complet");
  assert.deepEqual(tool.callsNamed("setExecutionStarted"), [["c0"]]);

  // Message assistant : le message qui lui est confié, découpé autour de l'outil.
  const assistants = kit.comps<FakeAssistant>("AssistantMessageComponent");
  assert.equal(assistants[0].message.role, "assistant");
  assert.deepEqual(assistants[0].message.content, [{ type: "text", text: "je lance" }]);
  assert.deepEqual(assistants[1].message.content, [{ type: "text", text: "fini" }]);
  assert.deepEqual(assistants[0].callsNamed("setImagesVisible"), [[false]]);
  assert.deepEqual(assistants[0].callsNamed("setToolResultImagesVisible"), [[true]]);

  // Message d'affichage d'un fichier : la forme que `CustomMessageComponent` rend.
  const fromFile = kit.comps<FakeCustom>("CustomMessageComponent")[0];
  assert.equal(fromFile.message.role, "custom");
  assert.equal(fromFile.message.customType, "pipeline");
  assert.equal(fromFile.message.display, true);
  assert.equal(fromFile.message.content, "la chaîne prend la main");
  assert.equal(fromFile.renderer, undefined, "l'extension n'enregistre aucun renderer : le défaut de l'hôte");

  // Message `custom` du journal : passé tel quel au composant de l'hôte.
  const inline = kit.comps<FakeCustom>("CustomMessageComponent")[1];
  assert.equal(inline.message.content, "note d'affichage");
  assert.equal(inline.message.display, true);

  // Exécution bash : la commande, la surface de repaint, la sortie et la fin.
  const bash = kit.comps<FakeBash>("BashExecutionComponent")[0];
  assert.equal(bash.command, "npm test");
  assert.equal(bash.ui, UI);
  assert.deepEqual(bash.callsNamed("appendOutput"), [["ok"]]);
  assert.deepEqual(bash.callsNamed("setComplete"), [[0, false, { showImages: false }]]);

  // Résumé de compaction : le message, tel quel.
  const summary = kit.comps<FakeComponent>("CompactionSummaryMessageComponent")[0] as FakeComponent & { message: Record<string, unknown> };
  assert.equal(summary.message.summary, "résumé de compaction");
});

test("un toolResult met à jour la carte de son appel, sans créer de composant", () => {
  const kit = mkKit();
  const first = [messageEntry("e1", assistant([{ id: "c1", name: "edit", arguments: { path: "a.ts" } }]))];
  const assembly = build(first, kit.kit as unknown as HostComponents);
  assert.equal(assembly.components.length, 1);
  const card = kit.comps<FakeTool>("ToolExecutionComponent")[0];

  // Le résultat se rend DANS la carte de son appel : rien de neuf n'apparaît.
  const withResult = [
    ...first,
    messageEntry("e2", {
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "text", text: "écrit" }],
      details: { diff: "@@ +1" },
      isError: true,
    }),
  ];
  const updated = build(withResult, kit.kit as unknown as HostComponents, { previous: assembly });
  assert.equal(updated.components.length, 1, "aucun composant de plus");
  assert.equal(kit.built.length, 1, "aucune construction de plus");
  assert.deepEqual(kit.comps<FakeTool>("ToolExecutionComponent")[0].callsNamed("updateResult"), [
    [{ content: [{ type: "text", text: "écrit" }], details: { diff: "@@ +1" }, isError: true }, false, "c1"],
  ]);
  assert.equal(card.callsNamed("updateResult").length, 1);

  // Le résultat déjà consommé ne rejoue pas, et un résultat sans carte connue est ignoré.
  const stray = build(
    [...withResult, messageEntry("e3", { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "encore" }] })],
    kit.kit as unknown as HostComponents,
    { previous: updated },
  );
  assert.equal(stray.components.length, 1);
  assert.equal(card.callsNamed("updateResult").length, 1, "la carte n'était plus en attente");
  const unknown = build(
    [...withResult, messageEntry("e4", { role: "toolResult", toolCallId: "jamais-vu", content: [{ type: "text", text: "?" }] })],
    kit.kit as unknown as HostComponents,
    { previous: updated },
  );
  assert.equal(unknown.components.length, 1);
  assert.equal(kit.built.length, 1);
});

test("les entrées techniques ne produisent aucun composant", () => {
  const kit = mkKit();
  const entries: SessionEntryLike[] = [
    otherEntry("session"),
    otherEntry("model_change"),
    otherEntry("label"),
    otherEntry("title_change"),
    otherEntry("model_usage"),
    customEntry("cm", { display: false }),
  ];
  const assembly = build(entries, kit.kit as unknown as HostComponents);

  assert.equal(kit.built.length, 0, "aucune classe de l'hôte n'est construite");
  assert.equal(assembly.components.length, 0);
  assert.equal(assembly.toolCards.size, 0);
  assert.equal(assembly.expandables.length, 0);
});

test("le texte qui suit un appel d'outil est rendu APRÈS sa carte", () => {
  const kit = mkKit();
  const entries = [
    messageEntry("e1", {
      role: "assistant",
      content: [
        { type: "text", text: "A" },
        { type: "toolCall", id: "c0", name: "edit", arguments: { path: "a.ts" } },
        { type: "text", text: "B" },
      ],
    }),
  ];
  const assembly = build(entries, kit.kit as unknown as HostComponents);

  assert.deepEqual(kit.kinds(), ["AssistantMessageComponent", "ToolExecutionComponent", "AssistantMessageComponent"]);
  const assistants = kit.comps<FakeAssistant>("AssistantMessageComponent");
  assert.deepEqual(assistants[0].message.content, [{ type: "text", text: "A" }]);
  assert.equal(assistants[0].message.stopReason, "stop");
  assert.deepEqual(assistants[1].message.content, [{ type: "text", text: "B" }]);
  assert.equal(assistants[1].message.stopReason, "stop");
  const tool = kit.comps<FakeTool>("ToolExecutionComponent")[0];
  assert.ok(
    assembly.components.indexOf(assistants[1]) > assembly.components.indexOf(tool),
    "le texte d'après l'outil s'affiche SOUS la carte de l'outil",
  );

  // Un assistant qui n'a que des appels d'outils ne construit aucune carte vide.
  const bare = mkKit();
  build(
    [messageEntry("e2", { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "b.ts" } }] })],
    bare.kit as unknown as HostComponents,
  );
  assert.deepEqual(bare.kinds(), ["ToolExecutionComponent"]);

  // Le découpage de la timeline, seul : deux appels d'outils, trois segments.
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: "avant" },
      { type: "toolCall", id: "c0", name: "read", arguments: { path: "a.ts" } },
      { type: "text", text: "entre" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "b.ts" } },
      { type: "text", text: "après" },
    ],
    stopReason: "toolUse",
    errorMessage: "boum",
  };
  const timeline = splitAssistantToolTimeline(message);
  assert.equal(timeline.hasToolCalls, true);
  assert.equal(timeline.lastToolCallId, "c1");
  assert.deepEqual(timeline.beforeTools.content, [{ type: "text", text: "avant" }]);
  assert.equal(timeline.beforeTools.stopReason, "stop");
  assert.equal(timeline.beforeTools.errorMessage, undefined, "un segment d'affichage ne porte pas d'erreur");
  assert.deepEqual(timeline.afterToolCalls.get("c0")?.content, [{ type: "text", text: "entre" }]);
  assert.equal(timeline.afterToolCalls.get("c0")?.stopReason, "stop");
  assert.deepEqual(timeline.afterToolCalls.get("c1")?.content, [{ type: "text", text: "après" }]);
  assert.equal(timeline.afterToolCalls.size, 2);

  // Un message sans appel d'outil reste un seul bloc, inchangé.
  const plain = { role: "assistant", content: [{ type: "text", text: "seul" }], stopReason: "stop" };
  const none = splitAssistantToolTimeline(plain);
  assert.equal(none.hasToolCalls, false);
  assert.equal(none.beforeTools, plain);
  assert.equal(none.afterToolCalls.size, 0);
});

test("les lectures consécutives sont repliées dans un groupe, comme chez l'hôte", () => {
  const kit = mkKit();
  const entries = [
    messageEntry("e1", assistant([{ id: "r0", name: "read", arguments: { path: "a.ts" } }])),
    messageEntry("e2", assistant([{ id: "r1", name: "read", arguments: { path: "b.ts" } }])),
    messageEntry("e3", assistant([{ id: "b0", name: "bash", arguments: { command: "ls" } }])),
    messageEntry("e4", assistant([{ id: "r2", name: "read", arguments: { path: "c.ts" } }])),
  ];
  const assembly = build(entries, kit.kit as unknown as HostComponents);

  assert.deepEqual(kit.kinds(), ["ReadToolGroupComponent", "ToolExecutionComponent", "ReadToolGroupComponent"]);
  const groups = kit.comps<FakeTool>("ReadToolGroupComponent");
  assert.equal(kit.count("ReadToolGroupComponent"), 2, "les deux premières lectures vivent dans le MÊME groupe");
  assert.deepEqual(groups[0].callsNamed("updateArgs"), [
    [{ path: "a.ts" }, "r0"],
    [{ path: "b.ts" }, "r1"],
  ]);
  assert.deepEqual(groups[0].callsNamed("setExecutionStarted"), [["r0"], ["r1"]]);
  assert.deepEqual(groups[1].callsNamed("updateArgs"), [[{ path: "c.ts" }, "r2"]]);

  // Le résultat d'une lecture retrouve le GROUPE, pas une carte séparée.
  assert.equal(assembly.toolCards.get("r0"), groups[0]);
  assert.equal(assembly.toolCards.get("r1"), groups[0]);
  assert.equal(assembly.toolCards.get("r2"), groups[1]);
  assert.equal(assembly.components.filter((component) => component === groups[0]).length, 1);
  assert.equal(assembly.components.length, 3);
});

// ---------------------------------------------------------------------------
// AC-4 — la bascule globale de dépliage
// ---------------------------------------------------------------------------

test("transcript/AC-4 : ctrl+o bascule TOUTES les cartes, et celles qui arrivent ensuite naissent dépliées", () => {
  const kit = mkKit();
  const entries = [
    messageEntry("e1", assistant([{ id: "c0", name: "edit", arguments: { path: "a.ts" } }])),
    messageEntry("e2", assistant([{ id: "c1", name: "edit", arguments: { path: "b.ts" } }])),
  ];
  const assembly = build(entries, kit.kit as unknown as HostComponents);
  const cards = kit.comps<FakeTool>("ToolExecutionComponent");
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.deepEqual(card.expandedValues, [false], "défaut d'OMP : replié");
  }

  applyExpanded(assembly, true);
  assert.equal(assembly.expanded, true);
  for (const card of cards) {
    assert.equal(card.expandedValues.filter((value) => value === true).length, 1, "chaque carte reçoit la bascule");
    assert.equal(card.expandedValues[card.expandedValues.length - 1], true);
  }

  // Une carte construite APRÈS la bascule naît dépliée.
  const later = build(
    [...entries, messageEntry("e3", assistant([{ id: "c2", name: "edit", arguments: { path: "c.ts" } }]))],
    kit.kit as unknown as HostComponents,
    { previous: assembly },
  );
  const fresh = kit.comps<FakeTool>("ToolExecutionComponent")[2];
  assert.deepEqual(fresh.expandedValues, [true], "elle est dépliée dès sa construction");
  assert.equal(later.expanded, true);

  // Nouvelle bascule : les cartes déjà affichées se replient.
  applyExpanded(assembly, false);
  assert.equal(assembly.expanded, false);
  for (const card of cards) {
    assert.equal(card.expandedValues[card.expandedValues.length - 1], false);
  }
});

// ---------------------------------------------------------------------------
// AC-3 / S-8 — l'assemblage incrémental et les entrées illisibles
// ---------------------------------------------------------------------------

test("l'assemblage est incrémental", () => {
  const kit = mkKit();
  const entries = [
    messageEntry("e1", { role: "user", content: [{ type: "text", text: "un" }] }),
    messageEntry("e2", assistant([], ["deux"])),
    messageEntry("e3", { role: "user", content: [{ type: "text", text: "trois" }] }),
  ];
  const first = build(entries, kit.kit as unknown as HostComponents);
  assert.equal(kit.built.length, 3);
  assert.equal(first.components.length, 3);

  const grown = [...entries, messageEntry("e4", { role: "user", content: [{ type: "text", text: "quatre" }] })];
  const second = build(grown, kit.kit as unknown as HostComponents, { previous: first });
  assert.ok(kit.built.length - 3 <= 1, "seule la nouvelle entrée est construite");
  assert.equal(kit.built.length, 4);
  assert.equal(second.components.length, 4);

  // Une clé par entrée, et les entrées déjà vues gardent LEURS composants.
  for (const entry of grown) {
    assert.equal(second.byEntryId.has(`${entry.id}@${entry.at}`), true, `l'entrée ${entry.id} est suivie`);
  }
  assert.equal(second.byEntryId.size, 4);
  assert.equal(second.byEntryId.get("e1@0")?.[0], first.byEntryId.get("e1@0")?.[0]);
  assert.equal(second.byEntryId.get("e4@0")?.[0], kit.built[3].comp);

  // Rejouer la même liste ne reconstruit rien.
  const third = build(grown, kit.kit as unknown as HostComponents, { previous: second });
  assert.equal(kit.built.length, 4);
  assert.equal(third.components.length, 4);
});

test("une entrée illisible ne casse pas la transcription", () => {
  const kit = mkKit({ throwOnAssistant: true });
  const entries = [
    messageEntry("e1", { role: "user", content: [{ type: "text", text: "avant" }] }),
    messageEntry("cassée", assistant([], ["boum"])),
    messageEntry("e3", { role: "user", content: [{ type: "text", text: "après" }] }),
  ];
  const assembly = build(entries, kit.kit as unknown as HostComponents);

  assert.deepEqual(kit.kinds(), ["UserMessageComponent", "Text", "UserMessageComponent"]);
  const unreadable = kit.comps<FakeText>("Text")[0];
  assert.equal(unreadable.text, "entrée illisible — cassée");
  assert.equal(assembly.components.length, 3, "les autres entrées sont rendues quand même");
  assert.equal(assembly.byEntryId.get("cassée@0")?.length, 1);
});

test("deux entrées qui partagent un id restent deux entrées", () => {
  const kit = mkKit();
  // Un fichier de session peut porter deux entrées du même id : l'id seul ne
  // déduplique pas, sinon la vue sauterait un message en silence.
  const entries = [
    messageEntry("u", { role: "user", content: [{ type: "text", text: "un" }] }, 0),
    messageEntry("u", { role: "user", content: [{ type: "text", text: "deux" }] }, 40),
  ];
  const assembly = build(entries, kit.kit as unknown as HostComponents);
  assert.equal(assembly.components.length, 2, "les deux entrées sont rendues");
  assert.equal(assembly.byEntryId.size, 2, "et chacune a sa propre clé");
});
