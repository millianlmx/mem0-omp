// Les consignes permanentes de l'humain (« toujours faire ainsi ») : une phrase, pour un dépôt ou
// pour tous, que le prompt de chaque étape des runs du dépôt porte (prompts.ts `standingSection`).
//
// Elles naissent d'un geste d'humain : écrites à la main (`POST /v1/rules`), ou d'une réponse à une
// escalade, d'un refus ou d'une correction donnés avec `always: true` (gestures.ts). Un pilote n'en
// écrit jamais : sa demande est refusée (403), son `always` est ignoré.
import type { Actor, HarnessContext } from "./context.ts";
import type { RepoFilter, RunRow, StandingRule, StandingRulePatch, StandingRuleSource } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { newId } from "./ids.ts";

/** La plus longue consigne, en caractères. */
export const MAX_RULE_TEXT = 600;
/** Le plus grand nombre de consignes actives d'un dépôt (ou de tous les dépôts). */
export const MAX_ACTIVE_RULES = 40;
/** La plus longue question reprise dans une consigne née d'une réponse. */
const MAX_QUESTION = 200;

const PILOT_REFUSED = "geste réservé à l'humain — un pilote n'écrit pas de consigne permanente";

export type StandingRuleInput = {
  text: string;
  repo: string | null;
  source: StandingRuleSource;
  sourceRunId: string | null;
};

/** Une phrase : les blancs réduits, rognée. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export class StandingRules {
  readonly #ctx: HarnessContext;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  /** La consigne, si le client peut l'écrire : la sienne (404 sinon, on ne trahit pas son existence). */
  #writable(id: string, actor: Actor, repos: RepoFilter): StandingRule {
    if (actor.pilot) throw new HarnessError(403, PILOT_REFUSED);
    const rule = this.#ctx.store.getStandingRule(id);
    if (rule === null || (repos !== null && (rule.repo === null || !repos.includes(rule.repo))))
      throw new HarnessError(404, `consigne inconnue : ${id}`);
    return rule;
  }

  /** Refuse (400) `adding` consignes actives de plus quand le dépôt en porterait plus de `MAX_ACTIVE_RULES`. */
  assertRoom(repo: string | null, adding = 1): void {
    if (this.#ctx.store.countActiveStandingRules(repo) + adding > MAX_ACTIVE_RULES)
      throw new HarnessError(
        400,
        `${MAX_ACTIVE_RULES} consignes actives au plus ${repo === null ? "pour tous les dépôts" : `pour le dépôt ${repo}`} : désactive ou supprime-en une`,
      );
  }

  #text(raw: string): string {
    const text = oneLine(raw);
    if (text === "" || text.length > MAX_RULE_TEXT)
      throw new HarnessError(400, `text : de 1 à ${MAX_RULE_TEXT} caractères (${text.length})`);
    return text;
  }

  #insert(input: StandingRuleInput, text: string, actor: Actor): StandingRule {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const rule = store.insertStandingRule({
        id: newId("sr"),
        repo: input.repo,
        text,
        source: input.source,
        sourceRunId: input.sourceRunId,
        by: actor.by,
      });
      this.#ctx.event("standing_rule", null, { id: rule.id, repo: rule.repo, action: "created" }, rule.repo);
      return rule;
    });
  }

  /**
   * Une consigne écrite par l'humain. Un client borné (`repos`) n'écrit que pour ses dépôts, jamais pour
   * tous ; un pilote est refusé (403) ; le dépôt doit être déclaré (404) ; 400 au-delà de `MAX_ACTIVE_RULES`.
   */
  create(input: StandingRuleInput, actor: Actor, repos: RepoFilter = null): StandingRule {
    if (actor.pilot) throw new HarnessError(403, PILOT_REFUSED);
    if (repos !== null && (input.repo === null || !repos.includes(input.repo)))
      throw new HarnessError(
        403,
        input.repo === null
          ? "une consigne pour tous les dépôts est réservée à un client qui les voit tous"
          : `le client ${actor.by ?? "appelant"} n'a pas accès au dépôt ${input.repo}`,
      );
    if (input.repo !== null) this.#ctx.repo(input.repo);
    const text = this.#text(input.text);
    if (input.sourceRunId !== null) {
      const run = this.#ctx.store.getRun(input.sourceRunId);
      if (run === null || (repos !== null && !repos.includes(run.repo)))
        throw new HarnessError(400, `sourceRunId : run inconnu (${input.sourceRunId})`);
    }
    this.assertRoom(input.repo);
    return this.#insert(input, text, actor);
  }

  /** Change le texte d'une consigne, ou l'active et la désactive (la réactiver compte dans le plafond). */
  update(id: string, patch: StandingRulePatch, actor: Actor, repos: RepoFilter = null): StandingRule {
    const { store } = this.#ctx;
    const rule = this.#writable(id, actor, repos);
    const text = patch.text === undefined ? undefined : this.#text(patch.text);
    if (patch.enabled === true && !rule.enabled) this.assertRoom(rule.repo);
    return store.transaction(() => {
      const next = store.updateStandingRule(id, {
        ...(text !== undefined ? { text } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      });
      if (next === null) throw new HarnessError(404, `consigne inconnue : ${id}`);
      this.#ctx.event("standing_rule", null, { id, repo: next.repo, action: "updated" }, next.repo);
      return next;
    });
  }

  remove(id: string, actor: Actor, repos: RepoFilter = null): void {
    const { store } = this.#ctx;
    const rule = this.#writable(id, actor, repos);
    store.transaction(() => {
      store.deleteStandingRule(id);
      this.#ctx.event("standing_rule", null, { id, repo: rule.repo, action: "removed" }, rule.repo);
    });
  }

  /**
   * Une consigne née d'un geste (`always: true`), pour le dépôt du run. Ignorée (`null`) pour un pilote ;
   * la même phrase déjà active est rendue telle quelle. À appeler dans la transaction du geste, après
   * `assertRoom` (un dépôt plein refuse le geste AVANT qu'il n'écrive quoi que ce soit).
   */
  #always(run: RunRow, source: StandingRuleSource, raw: string, actor: Actor): StandingRule | null {
    if (actor.pilot) return null;
    const text = clip(oneLine(raw), MAX_RULE_TEXT);
    if (text === "") return null;
    const known = this.#ctx.store
      .activeStandingRules(run.repo)
      .find((rule) => rule.repo === run.repo && rule.text === text);
    return known ?? this.#insert({ text, repo: run.repo, source, sourceRunId: run.id }, text, actor);
  }

  /** La réponse à une escalade devient une consigne : « Quand la question « … » se pose : <réponse>. » */
  fromAnswer(run: RunRow, question: string, answer: string, actor: Actor): StandingRule | null {
    const asked = clip(oneLine(question), MAX_QUESTION);
    return this.#always(
      run,
      "answer",
      `Quand la question « ${asked} » se pose : ${oneLine(answer).replace(/[.\s]+$/, "")}.`,
      actor,
    );
  }

  /** La raison d'un refus ou d'une correction devient une consigne. */
  fromCorrection(run: RunRow, text: string, actor: Actor): StandingRule | null {
    return this.#always(run, "correction", text, actor);
  }
}
