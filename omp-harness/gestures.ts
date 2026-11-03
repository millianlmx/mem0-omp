// La boucle humaine : répondre aux escalades, accepter ou renverser une décision,
// valider specs et verdicts, relancer, annuler, changer la priorité — et, quand
// l'humain ne répond pas, trancher à l'échéance par l'option recommandée.
//
// Plusieurs clients peuvent agir sur le même run (le Mac, l'iPhone, un collègue) :
// - les gestes d'un même run passent un par un (`serial`) ;
// - un client qui donne la révision qu'il a lue (`If-Match`) est refusé (412) si le
//   run a changé depuis — il relit au lieu d'agir sur une vue périmée ;
// - les écritures d'un geste (état, décisions, escalades, consignes, événements)
//   tiennent dans UNE transaction : un arrêt au milieu ne laisse rien à moitié fait.
// L'auteur de chaque geste est gardé (`by`) dans la base et dans le journal.
import type { Actor, HarnessContext } from "./context.ts";
import type { DecisionRow, EscalationRow, RunPatch, RunRow } from "./db.ts";
import { checkpointMessage, dependentsOf } from "./decisions.ts";
import { HarnessError } from "./errors.ts";
import type { StepKind } from "./machine.ts";
import {
  CANCELLABLE,
  MERGE_CAP,
  afterHumanValidation,
  afterSpecsValidation,
  cancelled,
  isTerminal,
  mergeStopOf,
  resumeAfterEscalations,
  resumeAfterMergeStop,
  resumeAtCheckpoint,
  retried,
  reworkAfterReversal,
} from "./machine.ts";
import { humanDecisionMemory } from "./oracle.ts";

export type GestureHooks = {
  /** Arrête le run s'il est conduit par ce process, et attend sa fin. */
  halt: (runId: string) => Promise<void>;
  /** Un tour de scheduling (un run remis en file repart tout de suite). */
  tick: () => void;
  /** Le run est-il enfilé ou en cours de merge ? */
  merging: (runId: string) => boolean;
  /** Ouvre un run de suite (décision renversée après le merge, sans revert possible). */
  followUp: (
    input: { repo: string; title: string; request: string; modules: string[]; priority: number },
    actor: Actor,
  ) => Promise<RunRow>;
  /** Reverte le commit squash d'un run mergé sur main et rend le run de suite ouvert ; lève si le revert ou le push échoue. */
  revertMerge: (runId: string, actor: Actor) => Promise<RunRow>;
};

export type EscalationAnswer = { id: number; answer: string; reason?: string };

/** Une réponse d'escalade telle qu'elle est écrite, et par qui (`null` : le service, à l'échéance). */
type Answered = { item: EscalationRow; answer: string; reason: string | null; by: string | null };

/** Les escalades ouvertes d'un run, répondues, dont la reprise reste à faire. */
type ResumeLine = { question: string; answer: string; timedOut: boolean };

/** Le début de la raison d'une réponse donnée par le service à l'échéance (la relecture la reconnaît). */
const TIMEOUT_REASON = "échéance de";

function byOf(actor: Actor): { by?: string } {
  return actor.by ? { by: actor.by } : {};
}

/** Qui tranche, dans la raison écrite sur le run. */
function whoOf(actor: Actor): string {
  return actor.pilot ? "le pilote de l'audit" : "l'humain";
}

function list(seqs: readonly number[]): string {
  return seqs.map((n) => `#${n}`).join(", ");
}

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
      throw new HarnessError(
        412,
        `le run a changé depuis ta lecture (révision ${run.rev}, la tienne ${actor.rev}) : relis-le`,
      );
    }
    return run;
  }

  // -- escalades --------------------------------------------------------------

  /** Réponses aux escalades d'un run ; quand toutes sont répondues, le run reprend son étape. */
  answerEscalations(runId: string, answers: EscalationAnswer[], actor: Actor): Promise<RunRow> {
    return this.#serial(runId, () => this.#answerEscalations(runId, answers, actor));
  }

  async #answerEscalations(runId: string, answers: EscalationAnswer[], actor: Actor): Promise<RunRow> {
    const { store } = this.#ctx;
    const run = this.#fresh(runId, actor);
    if (run.state !== "escalated") throw new HarnessError(409, `le run n'attend pas de réponse (état ${run.state})`);
    const open = new Map(store.listEscalations({ runId, status: "open" }).map((item) => [item.id, item]));
    for (const { id, answer, reason } of answers) {
      if (!open.get(id)) throw new HarnessError(404, `escalade ouverte inconnue : ${id}`);
      if (typeof answer !== "string" || answer.trim() === "")
        throw new HarnessError(400, `réponse vide pour l'escalade ${id}`);
      if (reason !== undefined && typeof reason !== "string")
        throw new HarnessError(400, `reason de l'escalade ${id} : une chaîne`);
    }
    const answered = store.transaction(() =>
      answers.flatMap(({ id, answer, reason }) => {
        const item = open.get(id);
        if (!item) return [];
        const text = answer.trim();
        const why = reason?.trim() ? reason.trim() : null;
        store.answerEscalation(id, text, actor.by, why);
        this.#ctx.event("escalation_answered", runId, {
          id,
          answer: text,
          ...(why ? { reason: why } : {}),
          ...byOf(actor),
        });
        return [{ item, answer: text, reason: why, by: actor.by }];
      }),
    );
    this.#retainAnswers(run, answered);
    await this.#resumeIfAllAnswered(runId, actor);
    return this.#ctx.run(runId);
  }

  /**
   * Chaque réponse humaine retourne à l'oracle : la raison d'abord, avec les options et le
   * contexte. Sans l'attendre : une écriture lente se retente des minutes durant.
   */
  #retainAnswers(run: RunRow, answered: readonly Answered[]): void {
    const repo = this.#ctx.repo(run.repo);
    for (const { item, answer, reason } of answered) {
      void this.#ctx.oracle.retain(
        repo.scope,
        humanDecisionMemory({
          feature: run.title,
          question: item.question,
          chosen: answer,
          reason: reason ?? "",
          category: item.category,
          options: item.options,
          context: item.context,
        }),
        ["harness", "decision", item.category],
      );
    }
  }

  /**
   * Quand plus aucune escalade n'est ouverte, le run reprend son étape avec les réponses
   * du lot (toutes les escalades de la DERNIÈRE étape escaladée). Relu : un geste a pu
   * passer entre-temps.
   */
  async #resumeIfAllAnswered(runId: string, actor: Actor): Promise<void> {
    const { store } = this.#ctx;
    const current = this.#ctx.run(runId);
    if (current.state !== "escalated" || store.listEscalations({ runId, status: "open" }).length > 0) return;
    const lastEscalated = store
      .listSteps(runId)
      .filter((step) => step.status === "escalated")
      .pop();
    const batch: ResumeLine[] = store
      .listEscalations({ runId, status: "answered" })
      .filter((item) => item.stepId === lastEscalated?.id)
      .map((item) => ({
        question: item.question,
        answer: item.answer ?? "",
        timedOut: item.answeredBy === null && (item.answerReason?.startsWith(TIMEOUT_REASON) ?? false),
      }));
    const timedOut = batch.some((line) => line.timedOut);
    store.transaction(() => {
      const moved = this.#ctx.transition(
        current,
        resumeAfterEscalations({ step: current.step ?? "impl", fixes: current.fixes, attempts: 0 }),
        ["escalated"],
        { actor: { by: actor.by } },
      );
      if (moved) {
        store.addInstructions(
          runId,
          (timedOut
            ? "Les escalades de l'étape sont tranchées — par l'humain, ou à l'échéance par l'option recommandée (marquées « à l'échéance », décisions à relire). "
            : "L'humain a tranché les escalades de l'étape. ") +
            "Applique ces réponses, puis termine l'étape :\n" +
            batch
              .map((line) => `- ${line.question} → ${line.answer}${line.timedOut ? " (à l'échéance)" : ""}`)
              .join("\n"),
        );
      }
    });
    this.#hooks.tick();
  }

  /**
   * L'humain ne répond pas : passé `review.escalationTimeoutSec`, chaque escalade ouverte
   * (sauf une suppression, jamais tranchée seule) reçoit l'option recommandée par l'agent,
   * devient une décision `auto_timeout` — renversable comme les autres — et le run reprend.
   * `null` : jamais d'auto-décision. Appelé par l'orchestrateur à chaque tour.
   */
  async autoDecideExpired(now: number): Promise<void> {
    const timeoutSec = this.#ctx.config.review.escalationTimeoutSec;
    if (timeoutSec === null) return;
    const deadline = now - timeoutSec * 1000;
    const byRun = new Map<string, EscalationRow[]>();
    for (const item of this.#ctx.store.listEscalations({ status: "open" })) {
      if (item.createdAt > deadline || item.category === "deletion") continue;
      if (item.recommended === null || item.recommended.trim() === "") continue;
      byRun.set(item.runId, [...(byRun.get(item.runId) ?? []), item]);
    }
    for (const [runId, items] of byRun) {
      await this.#serial(runId, () => this.#autoDecide(runId, items, timeoutSec)).catch((err: unknown) =>
        this.#ctx.log(
          `run ${runId} : auto-décision à l'échéance écartée (${err instanceof Error ? err.message : err})`,
        ),
      );
    }
  }

  async #autoDecide(runId: string, candidates: readonly EscalationRow[], timeoutSec: number): Promise<void> {
    const { store, git } = this.#ctx;
    const run = store.getRun(runId);
    // Seul un run qui ATTEND ses réponses se tranche : un runner vivant finit son étape d'abord.
    if (run?.state !== "escalated") return;
    const open = new Set(store.listEscalations({ runId, status: "open" }).map((item) => item.id));
    const rationale = `${TIMEOUT_REASON} ${timeoutSec} s sans réponse humaine`;
    const decided: { item: EscalationRow; decision: DecisionRow }[] = [];
    for (const item of candidates) {
      if (!open.has(item.id) || item.recommended === null) continue;
      const chosen = item.recommended.trim();
      const decision = store.transaction(() => {
        store.answerEscalation(item.id, chosen, null, rationale);
        const row = store.addDecision(
          {
            runId,
            stepId: item.stepId,
            question: item.question,
            options: item.options,
            chosen,
            rationale,
            context: item.context,
            impacts: item.impacts,
            category: item.category,
            checkpointSha: null,
            dependsOn: [],
          },
          "auto_timeout",
        );
        this.#ctx.event("decision_auto_timeout", runId, {
          id: item.id,
          seq: row.seq,
          category: item.category,
          question: item.question,
          chosen,
          timeoutSec,
        });
        return row;
      });
      decided.push({ item, decision });
    }
    if (decided.length === 0) return;
    // Le checkpoint : l'état d'AVANT l'application de l'option, d'où l'on repart si l'humain renverse.
    if (run.worktree !== null) {
      const sha = await git.commitAll(
        run.worktree,
        checkpointMessage(runId, decided[decided.length - 1]?.decision.seq ?? 0, {
          question: decided.map(({ decision }) => decision.question).join(" ; "),
          chosen: decided.map(({ decision }) => decision.chosen).join(" ; "),
          rationale,
        }),
      );
      store.transaction(() => {
        for (const { decision } of decided) store.setCheckpoint(decision.id, sha);
      });
    }
    const repo = this.#ctx.repo(run.repo);
    // L'oracle n'est pas attendu : une écriture lente se retente des minutes durant.
    for (const { item, decision } of decided) {
      void this.#ctx.oracle.retain(
        repo.scope,
        `Décision tranchée à l'échéance (${rationale}) — feature « ${run.title} » : ${decision.question} → « ${decision.chosen} » (recommandation de l'agent, non validée par l'humain). ` +
          `Options : ${item.options.join(" | ")}.${item.context ? ` Contexte : ${item.context}` : ""}`,
        ["harness", "decision", "auto_timeout"],
      );
    }
    await this.#resumeIfAllAnswered(runId, { by: null });
  }

  // -- décisions --------------------------------------------------------------

  acceptDecision(runId: string, seq: number, actor: Actor): Promise<DecisionRow> {
    return this.#serial(runId, async () => {
      const { store } = this.#ctx;
      this.#fresh(runId, actor);
      const decision = store.transaction(() => {
        const accepted = store.acceptDecision(runId, seq, actor.by);
        if (accepted) this.#ctx.event("decision_accepted", runId, { seq, ...byOf(actor) });
        return accepted;
      });
      if (!decision) throw new HarnessError(404, `décision inconnue : ${runId}#${seq}`);
      return decision;
    });
  }

  /** Toutes les décisions prises seules (`auto`, `auto_timeout`) du run passent en `accepted`, d'un geste. */
  acceptAllDecisions(runId: string, actor: Actor): Promise<{ accepted: number }> {
    return this.#serial(runId, async () => {
      const { store } = this.#ctx;
      this.#fresh(runId, actor);
      const accepted = store.transaction(() => {
        const pending = store.listDecisions({ runId, status: ["auto", "auto_timeout"] });
        const count = store.acceptAllDecisions(runId, actor.by);
        for (const decision of pending)
          this.#ctx.event("decision_accepted", runId, { seq: decision.seq, ...byOf(actor) });
        return count;
      });
      return { accepted };
    });
  }

  /**
   * Renverse la décision `seq` ; la raison de l'humain part dans l'oracle.
   * - Rien n'en dépend : pas de retour arrière, l'étape en cours (ou une correction
   *   après la revue) applique l'option sur l'état courant ; les autres décisions tiennent.
   * - Des décisions en découlent (`dependsOn`, transitivement) : les commits de la
   *   décision et de ses dépendantes sont REVERTÉS (le travail indépendant d'après
   *   reste dans l'arbre) ; si le revert entre en conflit, retour dur au checkpoint et
   *   les indépendantes sont réappliquées par consigne.
   * Un run déjà mergé : revert du commit squash sur main, puis un run de suite.
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
    if (decision.status === "reversed" || decision.status === "superseded")
      throw new HarnessError(409, `décision #${seq} déjà ${decision.status}`);
    if (option === "" || reason === "")
      throw new HarnessError(400, "option et reason sont requises : la raison retourne dans l'oracle");
    if (run.state === "merging" || this.#hooks.merging(runId))
      throw new HarnessError(409, "merge en cours : renverse après le merge (un run de suite sera ouvert)");
    const repo = this.#ctx.repo(run.repo);
    void oracle.retain(
      repo.scope,
      humanDecisionMemory({
        feature: run.title,
        question: decision.question,
        chosen: option,
        reason,
        category: decision.category,
        options: decision.options,
        reversedFrom: decision.chosen,
      }),
      ["harness", "decision", "renversement"],
    );
    const standing = store.listDecisions({ runId, status: ["auto", "auto_timeout", "accepted"] });
    const fallen = dependentsOf(standing, seq);

    if (run.state === "merged") return this.#reverseAfterMerge(run, decision, option, reason, fallen, actor);

    await this.#hooks.halt(runId);
    const fresh = this.#ctx.run(runId);
    if (fresh.state === "merging" || fresh.state === "merged" || fresh.state === "cancelled")
      throw new HarnessError(409, `le run est passé en ${fresh.state} pendant le renversement`);

    if (fallen.length === 0 || fresh.worktree === null || decision.checkpointSha === null)
      return this.#reworkOver(fresh, decision, option, reason, fallen, actor);

    const worktree = fresh.worktree;
    const stepKind = store.getStep(decision.stepId)?.kind ?? "impl";
    const cursor = { step: stepKind, fixes: fresh.fixes, attempts: 0 };
    // Tout ce qui est en cours entre dans l'historique : la plage à reverter va jusqu'à HEAD.
    if (await git.isDirty(worktree))
      await git.commitAll(worktree, `wip(${fresh.step ?? "fix"}): avant le renversement de #${seq}`.slice(0, 120));
    const chain = [seq, ...fallen];
    const last = Math.max(...chain);
    // La plage de la décision et de ses dépendantes : du checkpoint de `seq` à celui de la
    // première décision survivante postérieure (son commit porte le travail d'avant elle), sinon HEAD.
    const boundary = standing.filter((d) => d.seq > last && d.checkpointSha !== null).sort((a, b) => a.seq - b.seq)[0];
    const to = boundary?.checkpointSha ?? "HEAD";
    const reverted = await git.revertRange(worktree, decision.checkpointSha, to);
    const kept = standing.filter((d) => d.seq > seq && !chain.includes(d.seq));
    const common = () => {
      store.updateRun(runId, { verdict: null });
      store.reverseDecision(runId, seq, option, reason, fallen, actor.by);
      // Les escalades encore ouvertes portaient sur un travail qui vient d'être défait.
      for (const item of store.listEscalations({ runId, status: "open" }))
        store.answerEscalation(item.id, `caduque : reprise après le renversement de #${seq}`);
    };

    if (reverted.ok) {
      // Les survivantes prises dans la plage ont perdu leur travail, pas leur checkpoint ; celles d'après tiennent.
      const inside = kept.filter((d) => d.seq < last).map((d) => d.seq);
      const outside = kept.filter((d) => d.seq > last).map((d) => d.seq);
      store.transaction(() => {
        common();
        store.setInstructions(
          runId,
          `L'humain a renversé la décision #${seq} « ${decision.question} » : les commits après le checkpoint #${seq} ` +
            `(jusqu'à ${to === "HEAD" ? "HEAD" : `#${boundary?.seq}`}) ont été revertés (${reverted.sha.slice(0, 12)}) ; ` +
            `applique « ${option} » (raison : ${reason}). ` +
            `Les décisions ${list(fallen)} en découlaient : elles tombent, retranche-les si la question se repose.` +
            (inside.length > 0
              ? ` Les décisions ${list(inside)} n'en dépendaient pas mais leur travail était dans la plage revertée : réapplique-les telles quelles.`
              : "") +
            (outside.length > 0
              ? ` Les décisions ${list(outside)} n'en dépendent pas : elles tiennent et restent dans l'arbre.`
              : ""),
        );
        this.#ctx.event("decision_reversed", runId, {
          seq,
          option,
          step: stepKind,
          revert: reverted.sha,
          mode: "revert",
          superseded: fallen,
          ...byOf(actor),
        });
        this.#ctx.transition(this.#ctx.run(runId), resumeAtCheckpoint(cursor, stepKind, seq), [fresh.state], {
          actor: { by: actor.by },
        });
      });
      this.#hooks.tick();
      return this.#ctx.run(runId);
    }

    // Conflit : retour dur au checkpoint, seules les dépendantes tombent, les indépendantes sont réappliquées.
    await git.resetTo(worktree, decision.checkpointSha);
    const sha = await git.commitAll(
      worktree,
      checkpointMessage(runId, seq, {
        question: `${decision.question} (renversée)`,
        chosen: option,
        rationale: `Tranché par l'humain : ${reason}`,
      }),
    );
    store.transaction(() => {
      common();
      // Les indépendantes postérieures ont perdu leur commit : elles repartent de ce checkpoint.
      store.setCheckpoint(decision.id, sha);
      for (const survivor of kept) store.setCheckpoint(survivor.id, sha);
      store.setInstructions(
        runId,
        `Reprise au checkpoint #${seq} : l'humain a renversé « ${decision.question} ». Applique « ${option} » (raison : ${reason}). ` +
          `Le revert des commits suivants entrait en conflit (${reverted.conflicts.join(", ")}) : tout ce qui a été fait après ce checkpoint a été annulé ; refais la suite de l'étape avec ce choix. ` +
          `Les décisions ${list(fallen)} en découlaient : elles sont annulées, retranche-les si la question se repose.` +
          (kept.length > 0
            ? ` Les décisions ${list(kept.map((d) => d.seq))} n'en dépendaient pas : réapplique-les telles quelles.`
            : ""),
      );
      this.#ctx.event("decision_reversed", runId, {
        seq,
        option,
        step: stepKind,
        checkpoint: sha,
        conflicts: reverted.conflicts,
        mode: "reset",
        superseded: fallen,
        ...byOf(actor),
      });
      this.#ctx.transition(this.#ctx.run(runId), resumeAtCheckpoint(cursor, stepKind, seq), [fresh.state], {
        actor: { by: actor.by },
      });
    });
    this.#hooks.tick();
    return this.#ctx.run(runId);
  }

  /** Rien à défaire : on garde tout le travail, l'option s'applique par-dessus (l'étape, ou une correction). */
  async #reworkOver(
    fresh: RunRow,
    decision: DecisionRow,
    option: string,
    reason: string,
    fallen: readonly number[],
    actor: Actor,
  ): Promise<RunRow> {
    const { store, git } = this.#ctx;
    const runId = fresh.id;
    const seq = decision.seq;
    if (fresh.worktree !== null && (await git.isDirty(fresh.worktree)))
      await git.commitAll(
        fresh.worktree,
        `wip(${fresh.step ?? "fix"}): avant le renversement de #${seq}`.slice(0, 120),
      );
    store.transaction(() => {
      store.updateRun(runId, { verdict: null });
      store.reverseDecision(runId, seq, option, reason, fallen, actor.by);
      store.addInstructions(
        runId,
        `L'humain a renversé la décision #${seq} « ${decision.question} » : remplace « ${decision.chosen} » par « ${option} » (raison : ${reason}). ` +
          "Applique ce changement sur l'état actuel du code (et des artefacts qui le citent) ; rien n'a été annulé, les autres décisions tiennent." +
          (fallen.length > 0
            ? ` Les décisions ${list(fallen)} en découlaient : elles tombent, retranche-les si la question se repose.`
            : ""),
      );
      this.#ctx.event("decision_reversed", runId, { seq, option, mode: "rework", superseded: fallen, ...byOf(actor) });
      // Une étape qui attend ses escalades reprendra d'elle-même, avec la consigne ; sinon on la relance.
      if (fresh.state !== "escalated" && fresh.state !== "queued") {
        const step: StepKind = fresh.step === null || fresh.step === "review" ? "fix" : fresh.step;
        if (fresh.state === "running") {
          for (const item of store.listEscalations({ runId, status: "open" }))
            store.answerEscalation(item.id, `caduque : étape relancée après le renversement de #${seq}`);
        }
        this.#ctx.transition(
          this.#ctx.run(runId),
          reworkAfterReversal({ step, fixes: fresh.fixes, attempts: 0 }, step, seq),
          [fresh.state],
          { actor: { by: actor.by } },
        );
      }
    });
    this.#hooks.tick();
    return this.#ctx.run(runId);
  }

  /**
   * Le run est mergé : le commit squash est reverté sur main, puis un run de suite
   * réapplique la feature avec l'option de l'humain. Si le revert ne passe pas (push
   * refusé, conflit), le run de suite part seul et corrige par-dessus main.
   */
  async #reverseAfterMerge(
    run: RunRow,
    decision: DecisionRow,
    option: string,
    reason: string,
    fallen: readonly number[],
    actor: Actor,
  ): Promise<RunRow> {
    const { store } = this.#ctx;
    const seq = decision.seq;
    const change =
      `L'humain renverse la décision #${seq} « ${decision.question} → ${decision.chosen} » de la feature « ${run.title} » : « ${option} ». Raison : ${reason}.` +
      (fallen.length > 0 ? ` Les décisions qui en découlaient (${list(fallen)}) sont à revoir.` : "");
    store.transaction(() => {
      store.reverseDecision(run.id, seq, option, reason, fallen, actor.by);
      this.#ctx.event("decision_reversed", run.id, { seq, option, followUp: true, superseded: fallen, ...byOf(actor) });
    });
    try {
      const follow = await this.#hooks.revertMerge(run.id, actor);
      store.addInstructions(
        follow.id,
        `Le commit squash de « ${run.title} » a été reverté sur main. ${change} Réapplique la feature avec ce choix ; les autres décisions tiennent, reprends-les telles quelles.`,
      );
      return follow;
    } catch (err: unknown) {
      const why = err instanceof Error ? err.message : String(err);
      this.#ctx.event("revert_failed", run.id, { seq, reason: why.slice(0, 500), ...byOf(actor) });
      this.#ctx.log(`run ${run.id} : revert du merge impossible (${why.slice(0, 200)}) — run de suite seul`);
      return this.#hooks.followUp(
        {
          repo: run.repo,
          title: `Suite de « ${run.title} » : ${decision.question}`.slice(0, 120),
          request: `La feature « ${run.title} » a été mergée avec la décision « ${decision.question} → ${decision.chosen} » et son commit n'a pas pu être reverté. ${change} Applique ce changement par-dessus main.`,
          modules: run.modules,
          priority: run.priority,
        },
        actor,
      );
    }
  }

  // -- validation, relance, annulation, priorité ---------------------------------

  /** La validation humaine en attente : les specs (avant /impl) ou le verdict de revue. */
  validate(runId: string, approve: boolean, reason: string, actor: Actor): Promise<RunRow> {
    return this.#serial(runId, () => this.#validate(runId, approve, reason.trim(), actor));
  }

  async #validate(runId: string, approve: boolean, why: string, actor: Actor): Promise<RunRow> {
    const { store, oracle } = this.#ctx;
    const run = this.#fresh(runId, actor);
    if (run.state !== "awaiting_human")
      throw new HarnessError(409, `le run n'attend pas de validation (état ${run.state})`);
    const specs = run.step === "specs";
    if (!approve) {
      if (why === "") throw new HarnessError(400, "un refus porte sa raison");
      // Un refus du pilote n'est pas une correction humaine : l'oracle ne le rappellera pas comme tel.
      if (!actor.pilot)
        void oracle.retain(
          this.#ctx.repo(run.repo).scope,
          `Correction humaine — ${specs ? "specs de la " : ""}feature « ${run.title} » : ${why}`,
          ["harness", "correction"],
        );
    }
    const current = this.#ctx.run(runId);
    const cursor = { step: current.step ?? "review", fixes: current.fixes, attempts: 0 };
    const who = whoOf(actor);
    // Un merge arrêté au plafond : le valider rejouerait le même merge, qui buterait pareil.
    const stop = mergeStopOf(current);
    const transition =
      approve && stop !== null
        ? resumeAfterMergeStop({ ...cursor, step: stop }, who)
        : current.step === "specs"
          ? afterSpecsValidation(cursor, approve, why, who)
          : afterHumanValidation(cursor, approve, why, who);
    const patch: RunPatch =
      approve && stop !== null
        ? this.#mergeStopPatch(current)
        : !approve && current.step !== "specs"
          ? { verdict: current.verdict ? { ...current.verdict, blockers: [why] } : null }
          : {};
    const moved = store.transaction(() => {
      const next = this.#ctx.transition(current, transition, ["awaiting_human"], { patch, actor: { by: actor.by } });
      if (next && approve && stop !== null) store.addInstructions(runId, this.#mergeStopInstructions(current, stop));
      if (next && !approve) {
        const author = who.charAt(0).toUpperCase() + who.slice(1);
        store.addInstructions(
          runId,
          current.step === "specs"
            ? `${author} a refusé les specs : ${why}. Réécris \`specs.md\` en conséquence.`
            : `${author} a refusé le verdict : ${why}`,
        );
      }
      return next;
    });
    if (!moved) throw new HarnessError(409, `le run n'attend plus de validation (état ${current.state})`);
    this.#hooks.tick();
    return this.#ctx.run(runId);
  }

  /** La cause qui a arrêté le merge, sans la mention du plafond. */
  #mergeStopReason(run: RunRow): string {
    return (run.reason ?? "").replace(` — ${MERGE_CAP}`, "");
  }

  /** Un run repris après un merge arrêté : de nouvelles tentatives, la cause en bloquant (comme le merger). */
  #mergeStopPatch(run: RunRow): RunPatch {
    return {
      mergeRetries: 0,
      verdict: run.verdict ? { ...run.verdict, blockers: [this.#mergeStopReason(run)] } : null,
    };
  }

  #mergeStopInstructions(run: RunRow, step: "review" | "fix"): string {
    return `Le merge a été arrêté : ${this.#mergeStopReason(run)}. ${step === "fix" ? "Corrige, puis la revue reprendra." : "Reprends la revue."}`;
  }

  /**
   * Relance un run échoué ou en attente : même étape, compteur de tentatives à zéro, tout
   * de suite. `instructions` : la consigne que l'étape relancée recevra.
   */
  retry(runId: string, actor: Actor, instructions = ""): Promise<RunRow> {
    return this.#serial(runId, async () => {
      const { store } = this.#ctx;
      const run = this.#fresh(runId, actor);
      if (run.state !== "failed" && run.state !== "awaiting_human")
        throw new HarnessError(409, `seul un run échoué ou en attente se relance (état ${run.state})`);
      const stop = mergeStopOf(run);
      const moved = store.transaction(() => {
        const next = this.#ctx.transition(
          run,
          retried({ step: stop ?? run.step ?? "review", fixes: run.fixes, attempts: run.attempts }, whoOf(actor)),
          ["failed", "awaiting_human"],
          {
            patch: { notBefore: null, lastFailCause: null, ...(stop !== null ? this.#mergeStopPatch(run) : {}) },
            actor: { by: actor.by },
          },
        );
        if (next && stop !== null) store.addInstructions(runId, this.#mergeStopInstructions(run, stop));
        if (next && instructions.trim() !== "") store.addInstructions(runId, instructions.trim());
        if (next) this.#ctx.event("retried", runId, { from: run.state, step: next.step, ...byOf(actor) });
        return next;
      });
      if (!moved) throw new HarnessError(409, `le run a changé d'état (${this.#ctx.run(runId).state})`);
      this.#hooks.tick();
      return this.#ctx.run(runId);
    });
  }

  cancel(runId: string, actor: Actor): Promise<RunRow> {
    return this.#serial(runId, () => this.#cancel(runId, actor));
  }

  async #cancel(runId: string, actor: Actor): Promise<RunRow> {
    const { git } = this.#ctx;
    const run = this.#fresh(runId, actor);
    if (isTerminal(run.state)) throw new HarnessError(409, `run déjà ${run.state}`);
    // Un merge en cours touche main et le worktree : on ne l'interrompt pas à mi-chemin.
    if (run.state === "merging" || this.#hooks.merging(runId))
      throw new HarnessError(409, "merge en cours : impossible d'annuler");
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
      if (!Number.isInteger(priority) || Math.abs(priority) > 1000)
        throw new HarnessError(400, "priority : entier entre -1000 et 1000");
      store.transaction(() => {
        store.updateRun(runId, { priority });
        this.#ctx.event("priority", runId, { priority, ...byOf(actor) });
      });
      this.#hooks.tick();
      return this.#ctx.run(runId);
    });
  }
}
