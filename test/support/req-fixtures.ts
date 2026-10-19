// Les fixtures partagées des tests d'omp-mem0-req : lot et magasin écrits sur
// disque, contrat d'un worktree, fichiers de session au format JSONL d'OMP, et
// le faux kit de composants de l'hôte que monte le panneau.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : seuls les
// tests l'importent. Il importe le plugin par la même URL que les tests, donc
// partage la même instance de module (et le même état posé sur `globalThis`).
import * as fs from "node:fs";
import * as path from "node:path";

import {
  LOT_VERSION,
  auditState,
  contractPathFor,
  displayWidth,
  lotRepoKey,
  runningIdFor,
  wrapVisible,
  writeLot,
  writeRunningEntry,
  type Lot,
  type LotFeature,
  type PipelinesPanelDeps,
  type RunningEntry,
} from "../../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Lot, magasin, contrat
// ---------------------------------------------------------------------------

/** Un lot écrit dans le magasin : le propriétaire est CE process (donc vivant). */
export function seedLot(stateDir: string, repoRoot: string, features: LotFeature[], over: Partial<Lot> = {}): Lot {
  const lot: Lot = {
    version: LOT_VERSION,
    id: lotRepoKey(repoRoot),
    repoRoot,
    status: "running",
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: process.pid, sessionFile: null, sessionId: null },
    createdAt: 1_700_000_000_000,
    launchedAt: 1_700_000_000_000,
    features,
    ...over,
  };
  writeLot(stateDir, lot);
  return lot;
}

/** Une entrée EN COURS du magasin, telle qu'un autre processus l'écrirait. */
export function liveEntry(stateDir: string, input: Partial<RunningEntry> & { cwd: string }): RunningEntry {
  const entry: RunningEntry = {
    id: runningIdFor(input.cwd),
    label: input.label ?? "depot/feature",
    phase: "req",
    state: "running",
    phaseStartedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    sessionFile: null,
    sessionId: null,
    // Un pid VIVANT et différent du nôtre : c'est le run d'un process enfant.
    owner: { pid: process.ppid },
    ...input,
  };
  writeRunningEntry(stateDir, entry);
  return entry;
}

/** Écrit un contrat dans un worktree, comme le ferait le maillon qui l'a produit. */
export function writeContract(worktree: string, body: string): void {
  const file = contractPathFor(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

/** Un process neuf : l'état /audit est partagé par `globalThis`, il ne doit pas fuir d'un test à l'autre. */
export function resetAudit(): void {
  auditState.tools = false;
  auditState.created.clear();
  auditState.sessionFile = null;
  auditState.repoRoot = null;
  auditState.relayed.clear();
  auditState.stopTimer = null;
  auditState.dialogs = Promise.resolve();
  auditState.launched.clear();
  auditState.foreignWarned = false;
  auditState.ctx = null;
}

// ---------------------------------------------------------------------------
// Fichiers de session RÉELS (format JSONL d'OMP)
// ---------------------------------------------------------------------------

/** Un fichier de session réel : créneau de titre, en-tête, puis les entrées reçues. */
export function writeSession(file: string, cwd: string, entries: unknown[] = []): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ type: "title", v: 1, title: "session de test", updatedAt: 1 }),
    JSON.stringify({ type: "session", version: 3, id: path.basename(file), timestamp: "2026-09-19T00:00:00.000Z", cwd }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/** Un fichier de session réel (en-tête sans `parentSession` : pas un sous-agent). */
export function sessionFileIn(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: name, cwd: dir })}\n`, "utf8");
  return file;
}

export function userEntry(text: string, id = "u"): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-19T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

export function assistantEntry(text: string, calls: Array<{ name: string; arguments: Record<string, unknown> }> = []): unknown {
  return {
    type: "message",
    id: "a",
    parentId: null,
    timestamp: "2026-09-19T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...calls.map((call, i) => ({ type: "toolCall", id: `c${i}`, name: call.name, arguments: call.arguments })),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Le kit de composants de l'hôte, doublé
// ---------------------------------------------------------------------------

/** Le thème neutre : `fg`/`bg` rendent le texte tel quel, donc les assertions lisent le texte NU. */
export const THEME = {
  fg: (_tone: string, text: string) => text,
  bg: (_tone: string, text: string) => text,
  nav: { cursor: ">" },
};

/**
 * Le faux kit de composants de l'hôte (S-1) : le panneau et la vue ne composent
 * plus aucune ligne eux-mêmes, donc les tests montent un kit qui JOURNALISE ses
 * constructions et rend des lignes lisibles. Ce qui est prouvé ici, c'est ce que
 * le panneau DEMANDE aux composants (quel composant, avec quelle entrée) ; le
 * rendu des composants de l'hôte est celui d'OMP, prouvé par la fumée PTY (BR-7).
 */
export function fakeKit() {
  const built: string[] = [];
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
    #color: (text: string) => string;
    constructor(color?: (text: string) => string) {
      built.push("DynamicBorder");
      this.#color = color ?? ((text) => text);
    }
    render(width: number): readonly string[] {
      return [this.#color("─".repeat(Math.max(1, width)))];
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
    children: FakeText[] = [];
    addChild(child: FakeText): void {
      this.children.push(child);
    }
    render(width: number): readonly string[] {
      return this.children.flatMap((child) => [...child.render(width)]);
    }
  }
  /** Le texte d'un message, réduit à ses blocs `text` — la matière que la carte rend. */
  const textOf = (message: Record<string, unknown>): string => {
    const content = Array.isArray(message.content) ? message.content : [];
    return content
      .filter((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text")
      .map((block) => String((block as Record<string, unknown>).text ?? ""))
      .join(" ");
  };
  const resultText = (result: { content: Array<{ text?: string }> }): string =>
    result.content.map((block) => block.text ?? "").join("\n");
  /**
   * Les lignes d'un composant de message : repliées à la largeur reçue et
   * complétées, exactement comme le fait le composant de l'hôte — sans quoi les
   * assertions de largeur ne prouveraient rien.
   */
  const frame = (lines: string[], width: number): readonly string[] =>
    lines.flatMap((line) =>
      wrapVisible(line, Math.max(1, width)).map((part) => part + " ".repeat(Math.max(0, width - displayWidth(part)))),
    );
  class FakeUser {
    #text: string;
    constructor(text: string, _options?: { synthetic?: boolean }) {
      built.push("UserMessageComponent");
      this.#text = text;
    }
    render(width: number): readonly string[] {
      return frame(this.#text.split("\n").map((line) => `▸ toi : ${line}`), width);
    }
  }
  class FakeAssistant {
    #message: Record<string, unknown>;
    #expanded = false;
    constructor(message?: Record<string, unknown>) {
      built.push("AssistantMessageComponent");
      this.#message = message ?? {};
    }
    setExpanded(expanded: boolean): void {
      this.#expanded = expanded;
    }
    setImagesVisible(): void {}
    setToolResultImagesVisible(): void {}
    render(width: number): readonly string[] {
      const text = textOf(this.#message);
      if (text.trim() === "") return [];
      const lines = text.split("\n").map((line) => `▸ agent : ${line}`);
      if (this.#expanded || lines.length <= 2) return frame(lines, width);
      return frame([lines[0] as string, `… ${lines.length - 1} lignes repliées — ctrl+o déplier`], width);
    }
  }
  class FakeTool {
    #name: string;
    #args: unknown;
    #result?: { content: Array<{ text?: string }>; isError?: boolean };
    #expanded = false;
    constructor(toolName: string, args: unknown, _options?: unknown, _tool?: unknown, _ui?: unknown, _cwd?: string) {
      built.push("ToolExecutionComponent");
      this.#name = toolName;
      this.#args = args;
    }
    updateArgs(args: unknown): void {
      this.#args = args;
    }
    setArgsComplete(): void {}
    setExecutionStarted(): void {}
    setExpanded(expanded: boolean): void {
      this.#expanded = expanded;
    }
    updateResult(result: { content: Array<{ text?: string }>; isError?: boolean }): void {
      this.#result = result;
    }
    render(width: number): readonly string[] {
      const head = `→ ${this.#name} ${JSON.stringify(this.#args ?? {})}`;
      if (!this.#result) return frame([head], width);
      const lines = resultText(this.#result).split("\n");
      const shown = this.#expanded ? lines : lines.slice(0, 1);
      return frame([head, ...shown.map((line) => `← ${this.#name} ${line}`)], width);
    }
  }
  class FakeReadGroup {
    #calls: Array<{ id: string; args: unknown }> = [];
    #results = new Map<string, string>();
    #expanded = false;
    constructor(_options?: unknown) {
      built.push("ReadToolGroupComponent");
    }
    updateArgs(args: unknown, id?: string): void {
      this.#calls.push({ id: id ?? "", args });
    }
    setArgsComplete(): void {}
    setExecutionStarted(): void {}
    setExpanded(expanded: boolean): void {
      this.#expanded = expanded;
    }
    updateResult(result: { content: Array<{ text?: string }> }, _partial?: boolean, id?: string): void {
      this.#results.set(id ?? "", resultText(result));
    }
    render(width: number): readonly string[] {
      const lines: string[] = [];
      for (const call of this.#calls) {
        lines.push(`→ read ${JSON.stringify(call.args ?? {})}`);
        const output = this.#results.get(call.id);
        if (output === undefined) continue;
        const parts = output.split("\n");
        const shown = this.#expanded ? parts : parts.slice(0, 1);
        for (const part of shown) lines.push(`← read ${part}`);
      }
      return frame(lines, width);
    }
  }
  class FakeCustom {
    #message: Record<string, unknown>;
    constructor(message: unknown) {
      built.push("CustomMessageComponent");
      this.#message = (message ?? {}) as Record<string, unknown>;
    }
    setExpanded(): void {}
    render(width: number): readonly string[] {
      const content = typeof this.#message.content === "string" ? this.#message.content : "";
      return frame([`· ${String(this.#message.customType ?? "?")} : ${content}`], width);
    }
  }
  class FakeBash {
    #command: string;
    #output = "";
    constructor(command: string) {
      built.push("BashExecutionComponent");
      this.#command = command;
    }
    appendOutput(chunk: string): void {
      this.#output += chunk;
    }
    setComplete(): void {}
    setExpanded(): void {}
    render(width: number): readonly string[] {
      return frame([`$ ${this.#command}`, ...this.#output.split("\n")], width);
    }
  }
  const summary = (name: string) =>
    class {
      constructor(_message: unknown) {
        built.push(name);
      }
      setExpanded(): void {}
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
  return { kit: kit as unknown as PipelinesPanelDeps["components"], built };
}
