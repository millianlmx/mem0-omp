// L'autonomie par paliers : le serveur lève seul une attente humaine (`specs`, `verdict`) quand
// la première règle du dépôt qui correspond au run le permet et que toutes ses exigences sont
// prouvées. Les gardes sont tenues ICI, jamais par un prompt : échec fermé (le moindre doute, la
// moindre exception laisse l'attente à l'humain).
//
// L'évaluation (`evaluate`) est synchrone et n'écrit rien. Elle a lieu à la pose de l'attente
// (`#drive` retient alors les notifications : événement `autonomy` `hold`), puis `tick` valide par le
// MÊME geste que l'humain (`HumanLoop.validate`, `assertPilotMay` en seconde barrière), ou renonce
// (`defer`) et publie l'événement retenu. La validation s'inscrit au journal des décisions prises
// seules : accepter ou renverser se fait par les gestes existants.
//
// Seules sont levables : à la porte des specs, une attente sans aucune raison de porte (celle que
// pose `review.specsGate: true`) ; à la porte de verdict, la SEULE raison « diff au-delà de
// `review.maxDiffLines` », sous `match.maxDiffLines` de la règle.
//
// Le curseur du run passe avant les règles : `ask` (« tout me demander ») ne lève jamais rien ;
// `deliver` (« livre et préviens-moi ») tient lieu de règle `auto` (rang 0) sans règle de dépôt ni
// type de travail — specs sans raison de porte, revue dont le diff reste sous
// `DELIVER_DIFF_FACTOR × review.maxDiffLines`, suite complète verte et critères prouvés. Toutes les
// autres gardes restent.
import type { AutonomyGate, AutonomyProof, AutonomyRule, RuleFacts } from "./autonomy-rules.ts";
import { AUTONOMY_BY, firstRule } from "./autonomy-rules.ts";
import { CHALLENGE_STATE, openDisputes, readRecords } from "./challenge.ts";
import type { Actor, HarnessContext } from "./context.ts";
import type { RunRow } from "./db.ts";
import { detectIrreversible } from "./decisions.ts";
import { HarnessError } from "./errors.ts";
import { humanWaitOf, mergeStopOf } from "./machine.ts";
import { REVIEW_EVIDENCE, SPECS_BASELINE, gateReasons } from "./steps.ts";
import type { MergeDecision, ReviewEvidence } from "./verdict.ts";
import { mergeDecision } from "./verdict.ts";

export type AutonomyVerdict =
  | { ok: true; gate: AutonomyGate; rank: number; rule: AutonomyRule; proofs: Record<string, unknown> }
  | { ok: false; why: string };

/** Le plus gros diff que le curseur « livre et préviens-moi » valide seul, en multiple de `review.maxDiffLines`. */
export const DELIVER_DIFF_FACTOR = 4;

/** Le nom du curseur d'un run dans l'auteur d'une validation prise seule : `autonomie:<dépôt>#curseur`. */
const CURSOR = "curseur";

/** Les gestes de l'humain que l'autonomie emprunte (orchestrator.ts les branche sur `HumanLoop`). */
export type AutonomyHooks = {
  validate: (
    runId: string,
    approve: boolean,
    reason: string,
    actor: Actor,
    options: { inscribe: (next: RunRow) => void },
  ) => Promise<RunRow>;
  /** Le run a-t-il été lancé par la vigie (vigie/desk.ts) ? */
  launchedByVigie: (runId: string) => boolean;
};

/** Ce qu'une attente a de levable, indépendamment des règles. */
type Liftable =
  | { gate: "specs"; facts: RuleFacts }
  | { gate: "review"; facts: RuleFacts; evidence: ReviewEvidence; merge: MergeDecision };

/** La porte d'un run qui a un hold ouvert : lue dans l'événement. */
function gateOf(value: unknown): AutonomyGate {
  return value === "specs" ? "specs" : "review";
}

export class AutonomyGates {
  readonly #ctx: HarnessContext;
  readonly #hooks: AutonomyHooks;

  constructor(ctx: HarnessContext, hooks: AutonomyHooks) {
    this.#ctx = ctx;
    this.#hooks = hooks;
  }

  /** Ce que la porte pourrait lever pour ce run (une chaîne : pourquoi pas). Sans effet de bord. */
  #lift(run: RunRow): Liftable | string {
    const { store } = this.#ctx;
    const wait = humanWaitOf(run);
    if (wait !== "specs" && wait !== "verdict") return "l'attente n'est ni des specs ni un verdict";
    if (mergeStopOf(run) !== null) return "merge arrêté au plafond de ses tentatives";
    const facts: RuleFacts = { kind: run.kind, labels: run.labels };
    if (wait === "specs") {
      const disputes = openDisputes(readRecords(store.getArtifact(run.id, CHALLENGE_STATE)));
      const reasons = [
        ...gateReasons(run, store.getArtifact(run.id, "specs.md") ?? ""),
        ...(disputes.length > 0 ? ["désaccord avec le contradicteur"] : []),
      ];
      return reasons.length > 0
        ? `les specs portent une raison de porte : ${reasons.join(" ; ")}`
        : { gate: "specs", facts };
    }
    const raw = store.getArtifact(run.id, REVIEW_EVIDENCE);
    if (raw === null || run.verdict === null) return "évidence de revue absente";
    const saved = JSON.parse(raw) as { merge?: MergeDecision; evidence?: ReviewEvidence };
    const { merge, evidence } = saved;
    if (!merge || !evidence || !Array.isArray(evidence.touchedFiles) || !Array.isArray(evidence.reproTests))
      return "évidence de revue illisible";
    if (evidence.reviewSha !== run.lastReviewSha) return "l'évidence de revue n'est pas celle du dernier arbre relu";
    if (merge.auto) return "l'auto-merge n'a pas refusé";
    if (!mergeDecision(run.verdict, { ...evidence, maxDiffLines: Number.POSITIVE_INFINITY }).auto)
      return "le diff n'est pas la seule raison de refus";
    if (!(evidence.diffLines > evidence.maxDiffLines)) return "le diff ne dépasse pas review.maxDiffLines";
    // Des specs validées avec un geste irréversible restent à l'humain jusqu'au merge.
    if (detectIrreversible(store.getArtifact(run.id, SPECS_BASELINE) ?? "") !== null)
      return "les specs validées portent un geste irréversible";
    return {
      gate: "review",
      facts: { ...facts, touchedFiles: evidence.touchedFiles, diffLines: evidence.diffLines },
      evidence,
      merge,
    };
  }

  /** Une règle qui correspond pourrait-elle lever l'attente de ce run, règles et type mis à part ? */
  liftable(run: RunRow): boolean {
    try {
      return typeof this.#lift(run) === "object";
    } catch {
      return false;
    }
  }

  /** Le serveur peut-il valider seul l'attente de ce run ? Synchrone, sans écriture, échec fermé. */
  evaluate(run: RunRow): AutonomyVerdict {
    try {
      return this.#evaluate(run);
    } catch (err: unknown) {
      return {
        ok: false,
        why: `évaluation impossible : ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      };
    }
  }

  #evaluate(run: RunRow): AutonomyVerdict {
    const { store, monitor } = this.#ctx;
    const no = (why: string): AutonomyVerdict => ({ ok: false, why });
    if (run.state !== "awaiting_human") return no("le run n'attend pas l'humain");
    const wait = humanWaitOf(run);
    if (wait !== "specs" && wait !== "verdict") return no(`attente « ${wait} » : réservée à l'humain`);
    if (run.autonomy === "ask") return no("autonomie « tout me demander » : chaque attente revient à l'humain");
    const deliver = run.autonomy === "deliver";
    const rules = this.#ctx.repo(run.repo).autonomy?.rules ?? [];
    if (!deliver && run.kind === null) return no("run sans type de travail");
    if (!deliver && rules.length === 0) return no("le dépôt n'a pas de règle d'autonomie");
    if (mergeStopOf(run) !== null) return no("merge arrêté au plafond de ses tentatives");
    const { budget, threshold, cost } = monitor.budget(run.id);
    if (budget !== null && threshold !== null && cost >= threshold) return no("budget dépassé");
    for (const item of store.listEscalations({ runId: run.id })) {
      if (item.category === "schema" || item.category === "public_api" || item.category === "deletion")
        return no(`escalade ${item.category} portée par le run`);
      if (item.status === "open") return no("escalade ouverte");
    }
    if (this.#hooks.launchedByVigie(run.id)) return no("run lancé par la vigie");
    if (store.listDecisions({ runId: run.id, status: ["reversed"] }).some((d) => d.autonomy !== null))
      return no("une validation prise seule a été renversée par l'humain");

    const lift = this.#lift(run);
    if (typeof lift === "string") return no(lift);
    const byRule = firstRule(rules, lift.facts, lift.gate);
    if (!deliver) return byRule === null ? no("aucune règle ne correspond") : this.#judge(run, lift, byRule);
    // « Livre et préviens-moi » : le curseur tient lieu de règle (rang 0) ; une règle du dépôt plus large vaut encore.
    const cursor = this.#judge(run, lift, {
      rank: 0,
      rule: {
        match: {
          kind: run.kind ?? "feature",
          maxDiffLines: DELIVER_DIFF_FACTOR * this.#ctx.config.review.maxDiffLines,
        },
        require: { greenChecks: true, proofs: true },
        gates: { specs: "auto", review: "auto" },
      },
    });
    if (cursor.ok || byRule === null) return cursor;
    const ruled = this.#judge(run, lift, byRule);
    return ruled.ok ? ruled : cursor;
  }

  /** La règle retenue lève-t-elle cette attente : sa porte en auto, son seuil de diff et ses exigences prouvées ? */
  #judge(run: RunRow, lift: Liftable, match: { rule: AutonomyRule; rank: number }): AutonomyVerdict {
    const no = (why: string): AutonomyVerdict => ({ ok: false, why });
    const { rule, rank } = match;
    const gate = lift.gate;
    const named = rank === 0 ? "le curseur du run" : `la règle ${rank}`;
    if (rule.gates[gate] !== "auto")
      return no(`${named} laisse la porte ${gate === "specs" ? "specs" : "revue"} à l'humain`);
    const base = { kind: run.kind, labels: run.labels };
    if (lift.gate === "specs") return { ok: true, gate, rank, rule, proofs: { ...base, gateReasons: [] } };

    const { evidence } = lift;
    if (run.verdict === null) return no("évidence de revue absente");
    if (rule.match.maxDiffLines === undefined) return no("la règle ne fixe pas match.maxDiffLines");
    if (evidence.diffLines > rule.match.maxDiffLines)
      return no(
        `diff de ${evidence.diffLines} lignes : au-delà des ${rule.match.maxDiffLines} que ${named} valide seul`,
      );
    if (rule.require.reproTest === true && !(evidence.reproTests.length > 0 && evidence.fullTests === "pass"))
      return no("aucun test de reproduction vert (ajouté ou modifié par le run)");
    if (rule.require.greenChecks === true && evidence.fullTests !== "pass") return no("suite complète non verte");
    const proven = run.verdict.criteria.filter((c) => c.status === "pass").map((c) => c.id);
    if (rule.require.proofs === true && !evidence.acIds.every((id) => proven.includes(id)))
      return no("un critère d'acceptation n'est pas prouvé");
    return {
      ok: true,
      gate,
      rank,
      rule,
      proofs: {
        ...base,
        diffLines: evidence.diffLines,
        reviewMaxDiffLines: evidence.maxDiffLines,
        ruleMaxDiffLines: rule.match.maxDiffLines,
        fullTests: evidence.fullTests,
        reproTests: evidence.reproTests,
        provenCriteria: proven,
        reviewSha: evidence.reviewSha,
      },
    };
  }

  /**
   * Le curseur d'un run vient de passer à « livre et préviens-moi » alors qu'il attend déjà l'humain : une
   * attente levable est retenue (`hold`), le prochain tour la valide ou y renonce comme à sa pose.
   */
  reconsider(runId: string): void {
    const run = this.#ctx.store.getRun(runId);
    if (run?.autonomy !== "deliver" || run.state !== "awaiting_human" || this.#holdOpen(run.id) !== null) return;
    const verdict = this.evaluate(run);
    if (verdict.ok) this.#ctx.event("autonomy", run.id, { action: "hold", gate: verdict.gate, rev: run.rev });
  }

  /** L'attente retenue (`hold`) de ce run est-elle encore ouverte : aucune décision de l'autonomie ni `run_state` depuis ? */
  #holdOpen(runId: string): { gate: AutonomyGate } | null {
    const { store } = this.#ctx;
    const last = store.lastRunEvent(runId, "autonomy");
    if (last === null || last.payload.action !== "hold") return null;
    const state = store.lastRunEvent(runId, "run_state");
    return state !== null && state.id > last.id ? null : { gate: gateOf(last.payload.gate) };
  }

  /**
   * Un tour : chaque run dont l'attente est retenue est réévalué, puis validé par le geste de l'humain,
   * ou rendu à l'humain (`defer`, l'événement retenu part). Une exception sur un run ne touche pas les autres.
   */
  async tick(): Promise<void> {
    for (const run of this.#ctx.store.listRuns({ state: ["awaiting_human"] })) {
      if (this.#holdOpen(run.id) === null) continue;
      try {
        await this.#settle(run);
      } catch (err: unknown) {
        const why = `erreur : ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
        this.#ctx.log(`autonomie : run ${run.id} — ${why}`, { level: "error", runId: run.id, repo: run.repo, err });
        try {
          this.#defer(run.id, why);
        } catch (deferErr: unknown) {
          this.#ctx.log(`autonomie : run ${run.id} — renoncement impossible`, {
            level: "error",
            runId: run.id,
            repo: run.repo,
            err: deferErr,
          });
        }
      }
    }
  }

  async #settle(run: RunRow): Promise<void> {
    const verdict = this.evaluate(run);
    if (!verdict.ok) return this.#defer(run.id, verdict.why);
    if (
      verdict.gate === "review" &&
      (await this.#ctx.git.revParse(run.worktree as string, "HEAD")) !== run.lastReviewSha
    )
      return this.#defer(run.id, "l'arbre a changé depuis la revue");
    try {
      await this.#hooks.validate(
        run.id,
        true,
        "",
        {
          by: `${AUTONOMY_BY}${run.repo}#${verdict.rank === 0 ? CURSOR : verdict.rank}`,
          rev: run.rev,
          pilot: true,
        },
        { inscribe: (next) => this.#inscribe(next, verdict) },
      );
    } catch (err: unknown) {
      if (err instanceof HarnessError && [403, 409, 412].includes(err.status))
        return this.#defer(run.id, `geste refusé (${err.status}) : ${err.message}`.slice(0, 300));
      throw err;
    }
  }

  /** Renonce : si l'attente est encore retenue, `defer` est écrit et l'événement retenu part (les notifications aussi). */
  #defer(runId: string, why: string): void {
    const { store } = this.#ctx;
    store.transaction(() => {
      const run = this.#ctx.run(runId);
      const held = this.#holdOpen(runId);
      if (held === null || run.state !== "awaiting_human") return;
      this.#ctx.event("autonomy", runId, { action: "defer", gate: held.gate, rev: run.rev, why });
      if (run.step === "specs") this.#ctx.event("specs_ready", runId, { reason: run.reason });
      else this.#ctx.event("verdict", runId, { verdict: run.verdict, reason: run.reason });
    });
  }

  /** Inscrit, dans la transaction de la validation, la décision prise seule et l'événement `validate`. */
  #inscribe(next: RunRow, verdict: Extract<AutonomyVerdict, { ok: true }>): void {
    const { store } = this.#ctx;
    const { gate, rank, rule, proofs } = verdict;
    const steps = store.listSteps(next.id);
    const step = steps[steps.length - 1];
    if (!step) throw new Error(`run ${next.id} : aucune étape où inscrire la décision`);
    const specs = gate === "specs";
    const autonomy: AutonomyProof = {
      gate,
      rule: { rank, match: rule.match, require: rule.require, gates: rule.gates },
      proofs,
    };
    const decision = store.addDecision(
      {
        runId: next.id,
        stepId: step.id,
        question: specs
          ? "Valider les specs sans geste humain (autonomie) ?"
          : "Valider le verdict et fusionner sans geste humain (autonomie) ?",
        options: ["valider", "laisser à l'humain"],
        chosen: "valider",
        rationale:
          rank === 0
            ? `Curseur « livre et préviens-moi » du run : porte ${specs ? "specs" : "revue"} levée, exigences prouvées.`
            : `Règle ${rank} de ${next.repo} : ${String(proofs.kind)}, porte ${specs ? "specs" : "revue"} en auto, exigences prouvées.`,
        context: proofLines(proofs, specs).join("\n"),
        impacts: [],
        category: "reversible",
        checkpointSha: null,
        dependsOn: [],
        autonomy,
      },
      "auto",
    );
    this.#ctx.event("autonomy", next.id, { action: "validate", gate, rev: next.rev, seq: decision.seq, rank });
  }
}

/** Les preuves d'une validation prise seule, une ligne Markdown chacune. */
function proofLines(proofs: Record<string, unknown>, specs: boolean): string[] {
  const list = (value: unknown): string => (Array.isArray(value) && value.length > 0 ? value.join(", ") : "aucun");
  const lines = [`- type de travail : ${String(proofs.kind ?? "non déclaré")}`, `- labels : ${list(proofs.labels)}`];
  if (specs) return [...lines, "- raisons de porte des specs : aucune"];
  return [
    ...lines,
    `- lignes de diff : ${String(proofs.diffLines)} (seuil du serveur ${String(proofs.reviewMaxDiffLines)}, de la règle ${String(proofs.ruleMaxDiffLines)})`,
    `- suite complète : verte sur ${String(proofs.reviewSha).slice(0, 8)}`,
    `- test de reproduction : ${list(proofs.reproTests)}`,
    `- critères prouvés : ${list(proofs.provenCriteria)}`,
  ];
}
