// La boucle humaine : répondre aux escalades, accepter ou renverser une décision,
// valider specs et verdicts, annuler, changer la priorité.
//
// Plusieurs clients peuvent agir sur le même run (le Mac, l'iPhone, un collègue) :
// - les gestes d'un même run passent un par un (`serial`) ;
// - un client qui donne la révision qu'il a lue (`If-Match`) est refusé (412) si le
//   run a changé depuis — il relit au lieu d'agir sur une vue périmée ;
// - les écritures d'un geste (état, décisions, escalades, consignes, événements)
//   tiennent dans UNE transaction : un arrêt au milieu ne laisse rien à moitié fait.
// L'auteur de chaque geste est gardé (`by`) dans la base et dans le journal.
import type { Actor, HarnessContext } from "./context.ts";
import type { DecisionRow, RunRow } from "./db.ts";
import { checkpointMessage, dependentsOf } from "./decisions.ts";
import { HarnessError } from "./errors.ts";
import type { StepKind } from "./machine.ts";
import { CANCELLABLE, afterHumanValidation, afterSpecsValidation, cancelled, isTerminal, resumeAfterEscalations, resumeAtCheckpoint, reworkAfterReversal } from "./machine.ts";
import { humanDecisionMemory } from "./oracle.ts";


export type GestureHooks = {
  /** Arrête le run s'il est conduit par ce process, et attend sa fin. */
  halt: (runId: string) => Promise<void>;
  /** Un tour de scheduling (un run remis en file repart tout de suite). */
  tick: () => void;
  /** Le run est-il enfilé ou en cours de merge ? */
  merging: (runId: string) => boolean;
  /** Ouvre un run de suite (décision renversée après le merge). */
  followUp: (input: { repo: string; title: string; request: string; modules: string[]; priority: number }, actor: Actor) => RunRow;
};


export class HumanLoop {
  readonly #ctx: HarnessContext;
  readonly #hooks: GestureHooks;
  /** Les gestes d'un même run passent un par un (deux renversements simultanés…). */
  readonly #gestures = new Map<string, Promise<unknown>>();

  constructor(ctx: HarnessContext, hooks: GestureHooks) {
    this.#ctx = ctx;
    this.#hooks = hooks;
  }

  #serial<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#gestures.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.#gestures.set(runId, next);
    void next
      .finally(() => {
        if (this.#gestures.get(runId) === next) this.#gestures.delete(runId);
      })
      .catch(() => {});
    return next;
  }

  /** Le run, à la révision que l'acteur a lue s'il en donne une. */
  #fresh(runId: string, actor: Actor): RunRow {
    const run = this.#ctx.run(runId);
    if (actor.rev !== undefined && run.rev !== actor.rev) {
      throw new HarnessError(412, `le run a changé depuis ta lecture (révision ${run.rev}, la tienne ${actor.rev}) : relis-le`);
    }
    return run;
  }

  // -- escalades --------------------------------------------------------------

  /** Réponses aux escalades d'un run ; quand toutes sont répondues, le run reprend son étape. */
  answerEscalations(runId: string, answers: { id: number; answer: string }[], actor: Actor): Promise<RunRow> {
    return this.#serial(runId, () => this.#answerEscalations(runId, answers, actor));
  }

  async #answerEscalations(runId: string, answers: { id: number; answer: string }[], actor: Actor): Promise<RunRow> {
    const { store, oracle } = this.#ctx;
    const run = this.#fresh(runId, actor);
    if (run.state !== "escalated") throw new HarnessError(409, `le run n'attend pas de réponse (état ${run.state})`);
    const open = new Map(store.listEscalations({ runId, status: "open" }).map(item => [item.id, item]));
    for (const { id, answer } of answers) {
      if (!open.get(id)) throw new HarnessError(404, `escalade ouverte inconnue : ${id}`);
      if (typeof answer !== "string" || answer.trim() === "") throw new HarnessError(400, `réponse vide pour l'escalade ${id}`);
    }
    const repo = this.#ctx.repo(run.repo);
    const answered = store.transaction(() =>
      answers.flatMap(({ id, answer }) => {
        const item = open.get(id);
        if (!item) return [];
        store.answerEscalation(id, answer.trim(), actor.by);
        this.#ctx.event("escalation_answered", runId, { id, answer: answer.trim(), ...(actor.by ? { by: actor.by } : {}) });
        return [{ item, answer: answer.trim() }];
      }),
    );
    for (const { item, answer } of answered) {
      await oracle.retain(repo.scope, humanDecisionMemory({ feature: run.title, question: item.question, chosen: answer, reason: answer }), ["harness", "decision", item.category]);
    }
    // Relu APRÈS les écritures de l'oracle : un geste a pu passer entre-temps.
    const current = this.#ctx.run(runId);
    if (current.state !== "escalated" || store.listEscalations({ runId, status: "open" }).length > 0) return current;
    // Le lot de la reprise : toutes les escalades de la DERNIÈRE étape escaladée.
    const lastEscalated = store.listSteps(runId).filter(step => step.status === "escalated").pop();
    const batch = store.listEscalations({ runId, status: "answered" }).filter(item => item.stepId === lastEscalated?.id);
    store.transaction(() => {
      const moved = this.#ctx.transition(current, resumeAfterEscalations({ step: current.step as StepKind, fixes: current.fixes, attempts: 0 }), ["escalated"], { actor: { by: actor.by } });
      if (moved) {
        store.addInstructions(
          runId,
          `L'humain a tranché les escalades de l'étape. Applique ces réponses, puis termine l'étape :\n${batch.map(item => `- ${item.question} → ${item.answer}`).join("\n")}`,
        );
      }
    });
    this.#hooks.tick();
    return this.#ctx.run(runId);
  }

  // -- décisions --------------------------------------------------------------

  acceptDecision(runId: string, seq: number, actor: Actor): Promise<DecisionRow> {
    return this.#serial(runId, async () => {
      const { store } = this.#ctx;
      this.#fresh(runId, actor);
      const decision = store.transaction(() => {
        const accepted = store.acceptDecision(runId, seq, actor.by);
        if (accepted) this.#ctx.event("decision_accepted", runId, { seq, ...(actor.by ? { by: actor.by } : {}) });
        return accepted;
      });
      if (!decision) throw new HarnessError(404, `décision inconnue : ${runId}#${seq}`);
      return decision;
    });
  }

  /**
   * Renverse la décision `seq` ; la raison de l'humain part dans l'oracle.
   * - Rien n'en dépend : pas de retour arrière, l'étape en cours (ou une correction
   *   après la revue) applique l'option sur l'état courant ; les autres décisions tiennent.
   * - Des décisions en découlent (`dependsOn`, transitivement) : retour dur au
   *   checkpoint, seules ces dépendantes tombent ; les indépendantes sont réappliquées.
   * Un run déjà mergé ouvre un run de suite (le checkpoint n'existe plus).
   */
  reverseDecision(runId: string, seq: number, option: string, reason: string, actor: Actor): Promise<RunRow> {
    return this.#serial(runId, () => this.#reverseDecision(runId, seq, option.trim(), reason.trim(), actor));
  }

  async #reverseDecision(runId: string, seq: number, option: string, reason: string, actor: Actor): Promise<RunRow> {
    const { store, git, oracle } = this.#ctx;
    const run = this.#fresh(runId, actor);
    if (run.state === "cancelled") throw new HarnessError(409, "run annulé");
    const decision = store.getDecision(runId, seq);
    if (!decision) throw new HarnessError(404, `décision inconnue : ${runId}#${seq}`);
    if (decision.status === "reversed" || decision.status === "superseded") throw new HarnessError(409, `décision #${seq} déjà ${decision.status}`);
    if (option === "" || reason === "") throw new HarnessError(400, "option et reason sont requises : la raison retourne dans l'oracle");
    if (run.state === "merging" || this.#hooks.merging(runId)) throw new HarnessError(409, "merge en cours : renverse après le merge (un run de suite sera ouvert)");
    const repo = this.#ctx.repo(run.repo);
    await oracle.retain(repo.scope, humanDecisionMemory({ feature: run.title, question: decision.question, chosen: option, reason, reversedFrom: decision.chosen }), ["harness", "decision", "renversement"]);
    const standing = store.listDecisions({ runId, status: ["auto", "accepted"] });
    const fallen = dependentsOf(standing, seq);
    const list = (seqs: number[]) => seqs.map(n => `#${n}`).join(", ");
    const by = actor.by ? { by: actor.by } : {};

    if (run.state === "merged" || run.worktree === null || decision.checkpointSha === null) {
      store.transaction(() => {
        store.reverseDecision(runId, seq, option, reason, fallen, actor.by);
        this.#ctx.event("decision_reversed", runId, { seq, option, followUp: true, superseded: fallen, ...by });
      });
      return this.#hooks.followUp(
        {
          repo: run.repo,
          title: `Suite de « ${run.title} » : ${decision.question}`.slice(0, 120),
          request:
            `La feature « ${run.title} » a été mergée avec la décision « ${decision.question} → ${decision.chosen} ». L'humain la renverse : « ${option} ». Raison : ${reason}. Applique ce changement.` +
            (fallen.length > 0 ? ` Les décisions qui en découlaient (${list(fallen)}) sont à revoir.` : ""),
          modules: run.modules,
          priority: run.priority,
        },
        actor,
      );
    }

    await this.#hooks.halt(runId);
    const fresh = this.#ctx.run(runId);
    if (fresh.state === "merging" || fresh.state === "merged" || fresh.state === "cancelled") throw new HarnessError(409, `le run est passé en ${fresh.state} pendant le renversement`);
    const worktree = fresh.worktree as string;

    if (fallen.length === 0) {
      // Rien n'en découle : on garde tout le travail, l'option s'applique par-dessus.
      if (await git.isDirty(worktree)) await git.commitAll(worktree, `wip(${fresh.step ?? "fix"}): avant le renversement de #${seq}`.slice(0, 120));
      store.transaction(() => {
        store.updateRun(runId, { verdict: null });
        store.reverseDecision(runId, seq, option, reason, [], actor.by);
        store.addInstructions(
          runId,
          `L'humain a renversé la décision #${seq} « ${decision.question} » : remplace « ${decision.chosen} » par « ${option} » (raison : ${reason}). ` +
            "Applique ce changement sur l'état actuel du code (et des artefacts qui le citent) ; rien n'a été annulé, les autres décisions tiennent.",
        );
        this.#ctx.event("decision_reversed", runId, { seq, option, mode: "rework", superseded: [], ...by });
        // Une étape qui attend ses escalades reprendra d'elle-même, avec la consigne ; sinon on la relance.
        if (fresh.state !== "escalated" && fresh.state !== "queued") {
          const step: StepKind = fresh.step === null || fresh.step === "review" ? "fix" : fresh.step;
          if (fresh.state === "running") {
            for (const item of store.listEscalations({ runId, status: "open" })) store.answerEscalation(item.id, `caduque : étape relancée après le renversement de #${seq}`);
          }
          this.#ctx.transition(this.#ctx.run(runId), reworkAfterReversal({ step, fixes: fresh.fixes, attempts: 0 }, step, seq), [fresh.state], { actor: { by: actor.by } });
        }
      });
      this.#hooks.tick();
      return this.#ctx.run(runId);
    }

    const stepKind = store.getStep(decision.stepId)?.kind ?? "impl";
    await git.resetTo(worktree, decision.checkpointSha);
    const sha = await git.commitAll(worktree, checkpointMessage(runId, seq, { question: `${decision.question} (renversée)`, chosen: option, rationale: `Tranché par l'humain : ${reason}` }));
    // Les indépendantes postérieures ont perdu leur commit : elles repartent de ce checkpoint.
    const kept = standing.filter(d => d.seq > seq && !fallen.includes(d.seq));
    store.transaction(() => {
      store.updateRun(runId, { verdict: null });
      store.reverseDecision(runId, seq, option, reason, fallen, actor.by);
      // Les escalades encore ouvertes portaient sur un travail qui vient d'être annulé.
      for (const item of store.listEscalations({ runId, status: "open" })) store.answerEscalation(item.id, `caduque : reprise au checkpoint #${seq}`);
      store.setCheckpoint(decision.id, sha);
      for (const survivor of kept) store.setCheckpoint(survivor.id, sha);
      store.setInstructions(
        runId,
        `Reprise au checkpoint #${seq} : l'humain a renversé « ${decision.question} ». Applique « ${option} » (raison : ${reason}). ` +
          "Tout ce qui a été fait après ce checkpoint a été annulé ; refais la suite de l'étape avec ce choix. " +
          `Les décisions ${list(fallen)} en découlaient : elles sont annulées, retranche-les si la question se repose.` +
          (kept.length > 0 ? ` Les décisions ${list(kept.map(d => d.seq))} n'en dépendaient pas : réapplique-les telles quelles.` : ""),
      );
      this.#ctx.event("decision_reversed", runId, { seq, option, step: stepKind, checkpoint: sha, mode: "reset", superseded: fallen, ...by });
      this.#ctx.transition(this.#ctx.run(runId), resumeAtCheckpoint({ step: stepKind, fixes: fresh.fixes, attempts: 0 }, stepKind, seq), [fresh.state], { actor: { by: actor.by } });
    });
    this.#hooks.tick();
    return this.#ctx.run(runId);
  }

  // -- validation, annulation, priorité -----------------------------------------

  /** La validation humaine en attente : les specs (avant /impl) ou le verdict de revue. */
  validate(runId: string, approve: boolean, reason: string, actor: Actor): Promise<RunRow> {
    return this.#serial(runId, () => this.#validate(runId, approve, reason.trim(), actor));
  }

  async #validate(runId: string, approve: boolean, why: string, actor: Actor): Promise<RunRow> {
    const { store, oracle } = this.#ctx;
    const run = this.#fresh(runId, actor);
    if (run.state !== "awaiting_human") throw new HarnessError(409, `le run n'attend pas de validation (état ${run.state})`);
    const specs = run.step === "specs";
    if (!approve) {
      if (why === "") throw new HarnessError(400, "un refus porte sa raison");
      await oracle.retain(this.#ctx.repo(run.repo).scope, `Correction humaine — ${specs ? "specs de la " : ""}feature « ${run.title} » : ${why}`, ["harness", "correction"]);
    }
    const current = this.#ctx.run(runId);
    const cursor = { step: current.step ?? "review", fixes: current.fixes, attempts: 0 };
    const transition = current.step === "specs" ? afterSpecsValidation(cursor, approve, why) : afterHumanValidation(cursor, approve, why);
    const patch = !approve && current.step !== "specs" ? { verdict: current.verdict ? { ...current.verdict, blockers: [why] } : null } : {};
    const moved = store.transaction(() => {
      const next = this.#ctx.transition(current, transition, ["awaiting_human"], { patch, actor: { by: actor.by } });
      if (next && !approve) store.addInstructions(runId, current.step === "specs" ? `L'humain a refusé les specs : ${why}. Réécris \`specs.md\` en conséquence.` : `L'humain a refusé le verdict : ${why}`);
      return next;
    });
    if (!moved) throw new HarnessError(409, `le run n'attend plus de validation (état ${current.state})`);
    this.#hooks.tick();
    return this.#ctx.run(runId);
  }

  cancel(runId: string, actor: Actor): Promise<RunRow> {
    return this.#serial(runId, () => this.#cancel(runId, actor));
  }

  async #cancel(runId: string, actor: Actor): Promise<RunRow> {
    const { git } = this.#ctx;
    const run = this.#fresh(runId, actor);
    if (isTerminal(run.state)) throw new HarnessError(409, `run déjà ${run.state}`);
    // Un merge en cours touche main et le worktree : on ne l'interrompt pas à mi-chemin.
    if (run.state === "merging" || this.#hooks.merging(runId)) throw new HarnessError(409, "merge en cours : impossible d'annuler");
    if (!this.#ctx.transition(run, cancelled(run), CANCELLABLE, { actor: { by: actor.by } })) {
      throw new HarnessError(409, `le run a changé d'état (${this.#ctx.run(runId).state})`);
    }
    await this.#hooks.halt(runId);
    // La branche reste (inspection) ; seul le worktree est rendu.
    if (run.worktree) await git.removeWorktree(this.#ctx.repo(run.repo).path, run.worktree, null).catch(() => {});
    return this.#ctx.run(runId);
  }

  /** La priorité d'un run : à la prochaine admission (runner) et dans la file des tests (heavy). */
  setPriority(runId: string, priority: number, actor: Actor): Promise<RunRow> {
    return this.#serial(runId, async () => {
      const { store } = this.#ctx;
      const run = this.#fresh(runId, actor);
      if (isTerminal(run.state)) throw new HarnessError(409, `run déjà ${run.state}`);
      if (!Number.isInteger(priority) || Math.abs(priority) > 1000) throw new HarnessError(400, "priority : entier entre -1000 et 1000");
      store.transaction(() => {
        store.updateRun(runId, { priority });
        this.#ctx.event("priority", runId, { priority, ...(actor.by ? { by: actor.by } : {}) });
      });
      this.#hooks.tick();
      return this.#ctx.run(runId);
    });
  }
}
