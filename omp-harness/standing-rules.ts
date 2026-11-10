// Les consignes permanentes de l'humain (« toujours faire ainsi ») : une phrase, à trois niveaux — un
// dépôt, un espace (tous les dépôts d'un client) ou tous les dépôts — que le prompt de chaque étape des
// runs concernés porte (prompts.ts `standingSection`). Un dépôt reçoit les siennes, celles de SON espace
// et celles de tous ; jamais celles d'un autre espace.
//
// Elles naissent d'un geste d'humain : écrites à la main (`POST /v1/rules`), ou d'une réponse à une
// escalade, d'un refus ou d'une correction donnés avec `always: true` (gestures.ts). Un pilote n'en
// écrit jamais : sa demande est refusée (403), son `always` est ignoré. Une consigne née d'une
// réponse reprend un texte d'agent (la question, l'option retenue) : elle dit sa provenance.
import type { Actor, HarnessContext } from "./context.ts";
import type {
  EscalationRow,
  RepoFilter,
  RunRow,
  Space,
  StandingRule,
  StandingRulePatch,
  StandingRuleSource,
} from "./db.ts";
import { HarnessError } from "./errors.ts";
import { newId } from "./ids.ts";

/** La plus longue consigne, en caractères. */
export const MAX_RULE_TEXT = 600;
/** Le plus grand nombre de consignes actives d'un dépôt, celles de son espace comprises (ou de tous les dépôts). */
export const MAX_ACTIVE_RULES = 40;
/** La plus longue question reprise dans une consigne née d'une réponse. */
const MAX_QUESTION = 200;

const PILOT_REFUSED = "geste réservé à l'humain — un pilote n'écrit pas de consigne permanente";
const WHOLE_SPACE_ONLY = "une consigne d'espace est réservée à un client qui voit tous les dépôts de l'espace";

export type StandingRuleInput = {
  text: string;
  repo: string | null;
  /** L'espace (identifiant ou nom) dont la consigne vaut pour tous les dépôts ; jamais avec `repo`. */
  space?: string | null;
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

  /**
   * L'espace d'une consigne d'espace, si le client peut l'écrire : il le voit en ENTIER. Inconnu, ou sans
   * aucun dépôt visible du client : 404 (on ne trahit pas son existence) ; vu en partie : 403 — la consigne
   * partirait dans les prompts de dépôts qu'il ne voit pas.
   */
  #wholeSpace(space: Space | null, wanted: string, repos: RepoFilter): Space {
    if (space === null || (repos !== null && !space.repos.some((repo) => repos.includes(repo))))
      throw new HarnessError(404, `espace inconnu : ${wanted}`);
    if (repos !== null && !space.repos.every((repo) => repos.includes(repo)))
      throw new HarnessError(403, WHOLE_SPACE_ONLY);
    return space;
  }

  /**
   * La consigne, si le client peut l'écrire : celle d'un de ses dépôts, ou d'un espace qu'il voit en entier
   * (404 sinon, on ne trahit pas son existence). `within` (la requête porte `?space=`) : seulement une
   * consigne de cet espace ou de l'un de ses dépôts.
   */
  #writable(id: string, actor: Actor, repos: RepoFilter, within: Space | null): StandingRule {
    if (actor.pilot) throw new HarnessError(403, PILOT_REFUSED);
    const unknown = new HarnessError(404, `consigne inconnue : ${id}`);
    const rule = this.#ctx.store.getStandingRule(id);
    if (rule === null) throw unknown;
    if (rule.space !== null) {
      const space = this.#ctx.store.getSpace(rule.space);
      // Une consigne dont l'espace a disparu n'est plus qu'au propriétaire.
      if (repos !== null && (space === null || !space.repos.some((repo) => repos.includes(repo)))) throw unknown;
      if (space !== null) this.#wholeSpace(space, space.id, repos);
    } else if (repos !== null && (rule.repo === null || !repos.includes(rule.repo))) throw unknown;
    if (within !== null && rule.space !== within.id && (rule.repo === null || !within.repos.includes(rule.repo)))
      throw unknown;
    return rule;
  }

  /**
   * Refuse (400) `adding` consignes actives de plus quand un dépôt en porterait plus de `MAX_ACTIVE_RULES`,
   * celles de son espace comprises : pour un dépôt (`repo`), pour un espace (`space`, sans dépôt : chacun
   * de ses dépôts les reçoit), sinon pour tous les dépôts.
   */
  assertRoom(repo: string | null, adding = 1, space: string | null = null): void {
    const { store } = this.#ctx;
    const full = (where: string): HarnessError =>
      new HarnessError(400, `${MAX_ACTIVE_RULES} consignes actives au plus ${where} : désactive ou supprime-en une`);
    if (repo === null && space === null) {
      if (store.countActiveStandingRules(null) + adding > MAX_ACTIVE_RULES) throw full("pour tous les dépôts");
      return;
    }
    const owner = store.listSpaces().find((entry) => (repo === null ? entry.id === space : entry.repos.includes(repo)));
    const shared = owner ? store.countActiveStandingRules(null, owner.id) : 0;
    const fullest = Math.max(
      0,
      ...(repo === null ? (owner?.repos ?? []) : [repo]).map((name) => store.countActiveStandingRules(name)),
    );
    if (fullest + shared + adding <= MAX_ACTIVE_RULES) return;
    if (repo === null) throw full(`pour l'espace « ${owner?.name ?? space} », celles de ses dépôts comprises`);
    throw full(`pour le dépôt ${repo}${shared > 0 ? ", celles de son espace comprises" : ""}`);
  }

  #text(raw: string): string {
    const text = oneLine(raw);
    if (text === "" || text.length > MAX_RULE_TEXT)
      throw new HarnessError(400, `text : de 1 à ${MAX_RULE_TEXT} caractères (${text.length})`);
    return text;
  }

  #emit(rule: StandingRule, action: "created" | "updated" | "removed"): void {
    this.#ctx.event(
      "standing_rule",
      null,
      { id: rule.id, repo: rule.repo, ...(rule.space !== null ? { space: rule.space } : {}), action },
      rule.repo,
    );
  }

  #insert(input: StandingRuleInput, text: string, actor: Actor): StandingRule {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const rule = store.insertStandingRule({
        id: newId("sr"),
        repo: input.repo,
        space: input.space ?? null,
        text,
        source: input.source,
        sourceRunId: input.sourceRunId,
        by: actor.by,
      });
      this.#emit(rule, "created");
      return rule;
    });
  }

  /**
   * Une consigne écrite par l'humain, pour un dépôt, pour un espace (`space` : son identifiant ou son nom)
   * ou pour tous — au plus un des deux premiers (400). Un client borné (`repos`) n'écrit que pour ses
   * dépôts ou pour un espace qu'il voit en entier, jamais pour tous ; un pilote est refusé (403) ; le dépôt
   * doit être déclaré (404), l'espace connu (404) ; 400 au-delà de `MAX_ACTIVE_RULES`.
   */
  create(input: StandingRuleInput, actor: Actor, repos: RepoFilter = null): StandingRule {
    if (actor.pilot) throw new HarnessError(403, PILOT_REFUSED);
    const wanted = input.space?.trim() ?? null;
    if (wanted !== null && input.repo !== null)
      throw new HarnessError(400, "repo et space : au plus un des deux (un dépôt, un espace, ou tous les dépôts)");
    let space: Space | null = null;
    if (wanted !== null) {
      const spaces = this.#ctx.store.listSpaces();
      const found =
        spaces.find((entry) => entry.id === wanted) ??
        spaces.find((entry) => wanted !== "" && entry.name.toLowerCase() === wanted.toLowerCase());
      space = this.#wholeSpace(found ?? null, wanted, repos);
    } else if (repos !== null && (input.repo === null || !repos.includes(input.repo)))
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
    this.assertRoom(input.repo, 1, space?.id ?? null);
    return this.#insert({ ...input, space: space?.id ?? null }, text, actor);
  }

  /** Change le texte d'une consigne, ou l'active et la désactive (la réactiver compte dans le plafond). */
  update(
    id: string,
    patch: StandingRulePatch,
    actor: Actor,
    repos: RepoFilter = null,
    within: Space | null = null,
  ): StandingRule {
    const { store } = this.#ctx;
    const rule = this.#writable(id, actor, repos, within);
    const text = patch.text === undefined ? undefined : this.#text(patch.text);
    if (patch.enabled === true && !rule.enabled) this.assertRoom(rule.repo, 1, rule.space);
    return store.transaction(() => {
      const next = store.updateStandingRule(id, {
        ...(text !== undefined ? { text } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      });
      if (next === null) throw new HarnessError(404, `consigne inconnue : ${id}`);
      this.#emit(next, "updated");
      return next;
    });
  }

  remove(id: string, actor: Actor, repos: RepoFilter = null, within: Space | null = null): void {
    const { store } = this.#ctx;
    const rule = this.#writable(id, actor, repos, within);
    store.transaction(() => {
      store.deleteStandingRule(id);
      this.#emit(rule, "removed");
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

  /**
   * La réponse à une escalade devient une consigne. La question — et l'option, quand la réponse en est
   * une — ont été écrites par un agent : la consigne dit d'où vient chaque partie, pour qu'un texte
   * d'agent ne passe pas pour une phrase de l'humain. Seule une réponse qui est EXACTEMENT une option
   * proposée, ou sinon le texte que l'humain a écrit, en devient une ; une ligne, `MAX_RULE_TEXT` au plus
   * (la provenance est dite avant la réponse : une coupe ne l'emporte pas).
   */
  fromAnswer(
    run: RunRow,
    asked: Pick<EscalationRow, "question" | "options">,
    answer: string,
    actor: Actor,
  ): StandingRule | null {
    const said = oneLine(answer).replace(/[.\s]+$/, "");
    if (said === "") return null;
    const question = clip(oneLine(asked.question), MAX_QUESTION);
    const option = asked.options.some((candidate) => oneLine(candidate) === oneLine(answer));
    const origin = option ? "option proposée par l'agent, retenue" : "texte de l'humain";
    return this.#always(
      run,
      "answer",
      `Réponse de l'humain à la question de l'agent « ${question} » — ${origin} : ${said}.`,
      actor,
    );
  }

  /** La raison d'un refus ou d'une correction devient une consigne. */
  fromCorrection(run: RunRow, text: string, actor: Actor): StandingRule | null {
    return this.#always(run, "correction", text, actor);
  }
}
