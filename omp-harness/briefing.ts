// La carte en tête des specs à valider et d'un arbitrage entre revue et correction : `briefing` sur le run,
// `{ feature, cards }` — une ligne « ce que fait la feature », puis les points qui demandent un regard humain,
// chacun à la forme de la carte d'une escalade. Lue au même endroit pour les deux : `GET /v1/runs/{id}` et l'entrée du
// run dans `GET /v1/inbox`. Vide (`{ feature: "", cards: [] }`) quand le run n'attend ni specs ni arbitrage.
//
// Les points des specs : les décisions et escalades de /req et /specs (elles ont leur carte), une carte par raison de
// porte (`gateReasons`) et une par constat resté contesté avec le contradicteur. Ceux d'un arbitrage : une carte par
// bloquant non levé. Les cartes écrites par le serveur passent par le relecteur « humain pressé » ; à défaut, le texte
// brut de la raison, du constat ou du bloquant part tel quel, `reviewed: false`.
//
// Écrit AVANT l'attente (`prepare`, par l'orchestrateur), dans l'artefact interne `_briefing.json` du run : aucune
// migration, caché de l'API, jamais purgé. Il ne bloque jamais une transition : une carte qu'on n'a pas pu écrire est
// journalisée, et le run attend avec un `briefing` vide.
import { buildCard, featureLine, maskCard } from "./card.ts";
import type { CardDraft, CardOption, DecisionCard } from "./card.ts";
import { headlineProblem } from "./card.ts";
import { reviewCard } from "./card-reader.ts";
import { CHALLENGE_STATE, readRecords } from "./challenge.ts";
import type { HarnessContext } from "./context.ts";
import type { RunRow } from "./db.ts";
import { humanWaitOf } from "./machine.ts";
import type { HumanWait, RunState, StepKind } from "./machine.ts";
import { gateReasons } from "./steps.ts";

export type Briefing = { feature: string; cards: DecisionCard[] };

export const BRIEFING_ARTIFACT = "_briefing.json";

const EMPTY: Briefing = { feature: "", cards: [] };

/** Ce que le briefing d'un run attend : les specs, ou un arbitrage (le reste n'a pas de carte en tête). */
type BriefingKind = "specs" | "arbitration";

const SPECS_OPTIONS: CardOption[] = [
  { label: "valider les specs", impact: "L'implémentation démarre sur ces specs.", reversible: true },
  {
    label: "refaire /specs",
    impact: "Les specs sont réécrites : un tour de plus avant le code.",
    reversible: true,
    cost: "moyen",
  },
];

const ARBITRATION_OPTIONS: CardOption[] = [
  { label: "valider malgré", impact: "Le bloquant reste dans le code livré.", reversible: false },
  {
    label: "corriger encore",
    impact: "Un tour de correction de plus, puis une nouvelle revue.",
    reversible: true,
    cost: "moyen",
  },
];

/** Une ligne, bornée : le texte brut d'un constat ou d'un bloquant n'a pas la forme d'une carte. */
function oneLine(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Le titre voulu s'il suit les règles de la carte, sinon `fallback` (un texte brut ne les suit pas). */
function headlineOr(wanted: string, fallback: string): string {
  const text = oneLine(wanted, 200);
  return headlineProblem(text) === null ? text : fallback;
}

function draftOf(
  parts: Pick<CardDraft, "headline" | "stake" | "established" | "recommended" | "confidence">,
  options: CardOption[],
): CardDraft {
  return { ...parts, options: options.map((option) => ({ ...option })) };
}

/** Une carte pour une décision ou une escalade posée sans carte (avant les cartes) : ses textes, tels quels. */
function legacyDraft(item: {
  question: string;
  context: string | null;
  options: string[];
  impacts: string[];
  recommended: string | null;
  reversible: boolean;
}): CardDraft {
  return {
    headline: oneLine(item.question, 200),
    stake: oneLine(item.context?.split("\n")[0] ?? "", 240) || "Non précisé.",
    established: "Non précisé : décision antérieure aux cartes.",
    options: item.options.map((label, index) => ({
      label,
      impact: item.impacts[index] ?? "Non précisé.",
      reversible: item.reversible,
    })),
    recommended:
      item.recommended !== null && item.options.includes(item.recommended) ? item.recommended : (item.options[0] ?? ""),
    confidence: "moyenne",
  };
}

export class Briefings {
  readonly #ctx: HarnessContext;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  /**
   * Écrit le briefing d'un run qui va attendre l'humain (specs à valider, arbitrage) ; ne fait rien pour les autres
   * attentes. Ne rejette jamais : la transition n'attend pas une carte.
   */
  async prepare(run: RunRow, wait: { state: RunState; step: StepKind | null; reason: string }): Promise<void> {
    const kind = kindOf(humanWaitOf(wait));
    if (kind === null) return;
    try {
      const briefing = kind === "specs" ? await this.#specs(run) : await this.#arbitration(run);
      this.#ctx.store.putArtifact(run.id, BRIEFING_ARTIFACT, JSON.stringify({ kind, briefing }), null);
    } catch (err) {
      this.#ctx.log(`run ${run.id} : briefing non écrit — ${err instanceof Error ? err.message : String(err)}`, {
        level: "warn",
        runId: run.id,
        repo: run.repo,
      });
    }
  }

  /** Le briefing d'un run tel que l'API le rend : celui de son attente actuelle, vide sinon (ou s'il est périmé). */
  read(run: RunRow): Briefing {
    const kind = kindOf(humanWaitOf(run));
    if (kind === null) return EMPTY;
    const raw = this.#ctx.store.getArtifact(run.id, BRIEFING_ARTIFACT);
    if (raw === null) return EMPTY;
    try {
      const saved = JSON.parse(raw) as { kind?: string; briefing?: Briefing };
      return saved.kind === kind && saved.briefing ? saved.briefing : EMPTY;
    } catch {
      return EMPTY;
    }
  }

  /** « Ce que fait cette feature » : la ligne des specs, sinon le titre du run (la voie directe n'a pas de specs). */
  #feature(run: RunRow): string {
    return featureLine(this.#ctx.store.getArtifact(run.id, "specs.md") ?? "") ?? run.title;
  }

  async #specs(run: RunRow): Promise<Briefing> {
    const { store } = this.#ctx;
    const specs = store.getArtifact(run.id, "specs.md") ?? "";
    const own = new Set(
      store
        .listSteps(run.id)
        .filter((step) => step.kind === "req" || step.kind === "specs")
        .map((step) => step.id),
    );
    const decisionCards = store.decisionCards(run.id);
    const secrets = Object.values(this.#ctx.providers.runnerEnv());
    const posed: DecisionCard[] = [
      ...store
        .listDecisions({ runId: run.id })
        .filter((item) => own.has(item.stepId) && item.status !== "superseded")
        .map(
          (item) =>
            decisionCards[String(item.seq)] ??
            buildCard(maskCard(legacyDraft({ ...item, recommended: item.chosen, reversible: true }), secrets), false),
        ),
      ...store
        .listEscalations({ runId: run.id })
        .filter((item) => own.has(item.stepId))
        .map((item) => item.card ?? buildCard(maskCard(legacyDraft({ ...item, reversible: false }), secrets), false)),
    ];
    const reasons = gateReasons(run, specs).map((reason) =>
      draftOf(
        {
          headline: headlineOr(`Specs à valider : ${reason}`, "Un point des specs demande ton accord"),
          stake: `Raison de la porte : ${reason}.`,
          established: "Les specs sont écrites ; ce point demande ton accord avant le code.",
          recommended: "valider les specs",
          confidence: "faible",
        },
        SPECS_OPTIONS,
      ),
    );
    const records = readRecords(store.getArtifact(run.id, CHALLENGE_STATE));
    const disputed = (["req", "specs"] as const).flatMap((step) =>
      (records[step]?.disputes ?? []).map((id) => {
        const finding = records[step]?.findings.find((item) => item.id === id);
        const answer = records[step]?.answers[id];
        return draftOf(
          {
            headline: `Le contradicteur conteste un point des ${step === "req" ? "besoins" : "specs"}`,
            stake: `Constat ${id} : ${oneLine(finding?.claim ?? "constat introuvable", 200)}`,
            established: answer
              ? `Réfutation de l'auteur : ${oneLine(answer.note, 200)}`
              : `L'auteur n'a pas répondu au constat ${id}.`,
            recommended: "refaire /specs",
            confidence: "moyenne",
          },
          SPECS_OPTIONS,
        );
      }),
    );
    return { feature: this.#feature(run), cards: [...posed, ...(await this.#written(run, [...reasons, ...disputed]))] };
  }

  async #arbitration(run: RunRow): Promise<Briefing> {
    const drafts = (run.verdict?.blockers ?? []).map((blocker) =>
      draftOf(
        {
          headline: headlineOr(`Bloquant non levé : ${blocker}`, "Un bloquant de la revue reste ouvert"),
          stake: oneLine(blocker),
          established: "La revue a trouvé ce bloquant et les corrections ne l'ont pas levé.",
          recommended: "corriger encore",
          confidence: "moyenne",
        },
        ARBITRATION_OPTIONS,
      ),
    );
    return { feature: this.#feature(run), cards: await this.#written(run, drafts) };
  }

  /**
   * Les cartes écrites par le serveur, relues une à une par le relecteur rapide (jusqu'à deux fois sa borne en tout) ;
   * celles qu'il n'a pas relues partent avec leur texte brut, `reviewed: false`.
   */
  async #written(run: RunRow, drafts: CardDraft[]): Promise<DecisionCard[]> {
    const { store, config } = this.#ctx;
    const secrets = Object.values(this.#ctx.providers.runnerEnv());
    const last = store.listSteps(run.id).at(-1) ?? null;
    const deadline = Date.now() + config.review.cardReaderSec * 2000;
    const cards: DecisionCard[] = [];
    for (const raw of drafts) {
      const draft = maskCard(raw, secrets);
      const read =
        last !== null && Date.now() < deadline
          ? await reviewCard(this.#ctx, run, last, draft)
          : { draft, reviewed: false };
      cards.push(buildCard(read.draft, read.reviewed));
    }
    return cards;
  }
}

function kindOf(wait: HumanWait | null): BriefingKind | null {
  if (wait === "specs" || wait === "irreversible") return "specs";
  return wait === "arbitration" ? "arbitration" : null;
}
