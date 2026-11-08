// Le découpage d'une feature : les sous-features que son run ne garde pas partent en
// projet « Découpage de « … » ».
//
// - Le `## Découpage` des specs ne part qu'une fois les specs ACCEPTÉES (machine.ts
//   `acceptsSpecs` : validées par l'humain ou le pilote, ou aucune porte), jamais à la
//   clôture de /specs : des specs refusées puis refaites découpent selon leur dernière
//   version. Des specs refaites APRÈS une acceptation (décision renversée) remplacent le
//   découpage précédent, qui n'a pas pu démarrer.
// - `split_feature` en /impl découpe tout de suite : les specs sont déjà acceptées. En
//   /specs, l'outil ne crée rien, le `## Découpage` fait foi.
// - Chaque feature découpée attend le MERGE de son parent (`afterRun`) : elle reste en file
//   avec sa raison, l'admission la saute. Mergé, le parent la libère ; annulé ou en échec,
//   il l'emporte avec lui (context.ts `#settleSplit`).
// - Sa demande porte le lien vers le parent et ses specs gelées : le cadrage n'est pas refait.
import type { HarnessContext } from "./context.ts";
import type { RunRow } from "./db.ts";
import type { StepKind } from "./machine.ts";
import { splitAbandoned } from "./machine.ts";
import type { NewProjectInput } from "./orchestrator.ts";
import type { SplitFeature } from "./steps.ts";
import { SPECS_BASELINE, parseSplitSection } from "./steps.ts";

export type SplitHooks = {
  /** Le projet et ses runs, créés ensemble (sans attendre l'oracle) ; chaque run attend le merge de `parent`. */
  openProject: (input: NewProjectInput, parent: RunRow) => { projectId: string; runs: RunRow[] };
};

/** La raison d'une feature découpée en file tant que son parent n'est pas mergé. */
export function waitReason(parent: Pick<RunRow, "id" | "title">): string {
  return `attend le merge de « ${parent.title} » (${parent.id})`;
}

/**
 * La demande d'une feature découpée : la sienne, puis le contexte — le parent (titre, run,
 * branche) et ses specs gelées, en citation : leurs titres et leurs `AC-n` ne comptent ni
 * pour la voie directe, ni pour la revue de la feature.
 */
export function splitRequest(request: string, parent: Pick<RunRow, "id" | "title" | "branch">, specs: string): string {
  const quoted = specs
    .trim()
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  return (
    `${request.trim()}\n\n## Contexte du découpage\n\n` +
    `Feature découpée de « ${parent.title} » (run \`${parent.id}\`, branche \`${parent.branch}\`). ` +
    "Elle ne part qu'une fois ce run mergé : son code est déjà sur main. " +
    (specs.trim() === ""
      ? "Ses specs gelées manquent : relis sa branche mergée.\n"
      : `Ses specs gelées fixent le cadrage commun : ne le refais pas, livre seulement la part décrite ci-dessus.\n\n${quoted}\n`)
  );
}

export class Splitter {
  readonly #ctx: HarnessContext;
  readonly #hooks: SplitHooks;

  constructor(ctx: HarnessContext, hooks: SplitHooks) {
    this.#ctx = ctx;
    this.#hooks = hooks;
  }

  /** Le run attend-il encore le merge de son parent ? L'admission le saute (il ne réserve pas ses modules). */
  waiting(run: RunRow): boolean {
    if (run.afterRun === null) return false;
    const parent = this.#ctx.store.getRun(run.afterRun);
    return parent !== null && parent.state !== "merged";
  }

  /**
   * Les specs du run viennent d'être acceptées, dans la transaction de la transition : le
   * découpage précédent (specs refaites après une acceptation) est remplacé, puis le
   * `## Découpage` des specs gelées part en projet.
   */
  accepted(parent: RunRow): void {
    const { store } = this.#ctx;
    for (const child of store.listRuns({ afterRun: parent.id, state: ["queued"] }))
      this.#ctx.transition(
        child,
        splitAbandoned(child, `remplacée : les specs de « ${parent.title} » ont été refaites`),
        ["queued"],
      );
    const features = parseSplitSection(store.getArtifact(parent.id, SPECS_BASELINE) ?? "");
    if (features.length > 0) this.launch(parent, features, "specs", "specs");
  }

  /** Le projet des sous-features, chacune en attente du merge de `parent`, et l'événement `split` qui le dit. */
  launch(
    parent: RunRow,
    features: SplitFeature[],
    step: StepKind,
    by: "specs" | "runner",
  ): { projectId: string; runs: RunRow[] } {
    const { store } = this.#ctx;
    const specs = store.getArtifact(parent.id, SPECS_BASELINE) ?? "";
    return store.transaction(() => {
      const { projectId, runs } = this.#hooks.openProject(
        {
          repo: parent.repo,
          title: `Découpage de « ${parent.title} »`.slice(0, 120),
          priority: parent.priority,
          features: features.map((feature) => ({
            ...feature,
            request: splitRequest(feature.request, parent, specs),
          })),
        },
        parent,
      );
      this.#ctx.event("split", parent.id, {
        projectId,
        step,
        by,
        waitsFor: parent.id,
        reason: waitReason(parent),
        features: runs.map((row) => ({ id: row.id, title: row.title, modules: row.modules })),
      });
      return { projectId, runs };
    });
  }
}
