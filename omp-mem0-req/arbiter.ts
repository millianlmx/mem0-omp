// L'ARBITRE éphémère (S-9) : ce qu'il reçoit (prompt, corpus), ce qu'il rend
// (`arbiter_decide`) et la validation DÉTERMINISTE que le pilote en fait. Module
// pur, sans import de valeur de l'hôte : le lanceur (serviceRuns.ts), l'outil
// (extension.ts) et le contrôleur (lotController.ts) disent la même chose ici.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { journalLine } from "./context.ts";
import type { DecisionSource, JournalEntry } from "./context.ts";
import type { PipelinePhase } from "./contract.ts";
import { ARBITER_DIRECTIVE } from "./seeds.ts";


/** L'échéance d'un run d'arbitre (S-9) : dix minutes. */
export const ARBITER_DEADLINE_MS = 600_000;

/** Les genres d'éléments que l'arbitre peut juger : `cap`, `failure` et `quota` n'y vont JAMAIS. */
export type ArbiterItemKind = "ask" | "question" | "specs" | "review";

export type ArbiterItem = {
  kind: ArbiterItemKind;
  slug: string;
  phase: PipelinePhase;
  /** La question d'une étape (`ask`, `question`) ; `null` pour un jalon. */
  question: string | null;
  options: string[];
};

/** Ce que l'outil `arbiter_decide` transporte (S-9). */
export type ArbiterDecision = {
  decision: "answer" | "approve" | "escalate";
  answer?: string;
  source?: "contexte" | "arbitrage";
  citations?: string[];
  reason: string;
};

/** La décision retenue d'une session d'arbitre : le PREMIER appel de l'outil, ensuite plus rien. */
export type ArbiterCapture = { decision: ArbiterDecision | null };

/** L'effet d'une décision VALIDÉE, que le contrôleur applique. */
export type ArbiterEffect =
  | { kind: "answer"; answer: string; source: "contexte" | "arbitrage"; selected: boolean }
  | { kind: "approve" }
  | { kind: "escalate"; reason: string };

export const ARBITER_RECORDED = "décision enregistrée";
export const ARBITER_ALREADY = "Error: décision déjà enregistrée";


/** La question comparée au journal : espaces repliés, minuscules (S-9 « raccourci journal »). */
export function normalizeQuestion(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}


/** Le texte aux espaces repliés (citations et corpus, S-9). */
export function foldSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}


/** Le jalon qu'un élément de type `specs` ou `review` soumet, tel que le journal le nomme (S-7). */
export function milestoneQuestion(kind: "specs" | "review"): string {
  return kind === "specs" ? "specs validées ?" : "revue propre : livrer ?";
}


/** La question affichée d'un élément : celle de l'étape, ou le jalon. */
export function itemQuestion(item: ArbiterItem): string {
  return item.question ?? milestoneQuestion(item.kind as "specs" | "review");
}


/** Le CORPUS de l'arbitre : brief, journal de la feature (toutes ses entrées), contrat (S-9). */
export function buildArbiterCorpus(input: {
  brief: string | null;
  slug: string;
  entries: readonly JournalEntry[];
  contract: string | null;
}): string {
  const journal = input.entries.length === 0 ? ["- (aucune décision consignée)"] : input.entries.map(journalLine);
  return [
    "### Brief",
    input.brief !== null && input.brief.trim() !== "" ? input.brief.trim() : "(aucun brief validé)",
    "",
    `### Journal de la feature ${input.slug}`,
    ...journal,
    "",
    "### Contrat",
    input.contract !== null && input.contract.trim() !== "" ? input.contract.trim() : "(contrat absent)",
  ].join("\n");
}


/** Le prompt de l'arbitre : directive, élément, corpus (S-9). */
export function buildArbiterPrompt(item: ArbiterItem, corpus: string): string {
  const head = [
    "## Élément à arbitrer",
    `feature : ${item.slug}`,
    `étape : /${item.phase}`,
  ];
  if (item.question !== null) {
    head.push(`type : question`, `question : ${item.question}`);
    if (item.options.length > 0) head.push("options :", ...item.options.map((label, index) => `${index + 1}. ${label}`));
  } else {
    head.push(`type : jalon « ${item.kind === "specs" ? "specs validées" : "revue propre"} »`);
  }
  return `${ARBITER_DIRECTIVE}\n\n${head.join("\n")}\n\n## Corpus\n\n${corpus}`;
}


/**
 * L'outil `arbiter_decide` (S-9) : le premier appel est retenu, tout appel suivant
 * est refusé. Partagé par l'extension et par les doublures de test.
 */
export function recordArbiterDecision(
  capture: ArbiterCapture,
  params: unknown,
): { text: string; isError: boolean } {
  if (capture.decision !== null) return { text: ARBITER_ALREADY, isError: true };
  const record = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  const decision = record.decision;
  if (decision !== "answer" && decision !== "approve" && decision !== "escalate") {
    return { text: "Error: decision doit valoir answer, approve ou escalate", isError: true };
  }
  const source = record.source === "contexte" || record.source === "arbitrage" ? record.source : undefined;
  capture.decision = {
    decision,
    reason: typeof record.reason === "string" ? record.reason : "",
    ...(typeof record.answer === "string" ? { answer: record.answer } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(Array.isArray(record.citations)
      ? { citations: record.citations.filter((c): c is string => typeof c === "string") }
      : {}),
  };
  return { text: ARBITER_RECORDED, isError: false };
}


/**
 * La validation DÉTERMINISTE d'une décision (S-9). Question : `answer` exige une
 * réponse non vide, une source `contexte`/`arbitrage` et au moins une citation
 * dont la forme aux espaces repliés figure dans le corpus aux espaces repliés.
 * Jalon : seul `approve` (source forcée `arbitrage`, motif non vide) ou `escalate`.
 * Tout autre cas se rend en escalade, avec son motif.
 */
export function validateArbiterDecision(
  item: ArbiterItem,
  decision: ArbiterDecision | null,
  corpus: string,
): ArbiterEffect {
  if (decision === null) return { kind: "escalate", reason: "arbitre sans décision" };
  const invalid = (motif: string): ArbiterEffect => ({ kind: "escalate", reason: `décision d'arbitre invalide : ${motif}` });
  if (decision.decision === "escalate") {
    return { kind: "escalate", reason: decision.reason.trim() || "escalade demandée par l'arbitre" };
  }
  if (item.question === null) {
    if (decision.decision !== "approve") return invalid("un jalon s'approuve ou s'escalade");
    if (decision.reason.trim() === "") return invalid("motif d'approbation vide");
    return { kind: "approve" };
  }
  if (decision.decision !== "answer") return invalid("une question se répond ou s'escalade");
  const answer = (decision.answer ?? "").trim();
  if (answer === "") return invalid("réponse vide");
  if (decision.source !== "contexte" && decision.source !== "arbitrage") return invalid("source absente ou inconnue");
  const folded = foldSpaces(corpus);
  const cited = (decision.citations ?? []).map(foldSpaces).filter((c) => c !== "");
  if (cited.length === 0) return invalid("aucune citation du corpus");
  if (!cited.some((c) => folded.includes(c))) return invalid("aucune citation ne figure dans le corpus");
  return { kind: "answer", answer, source: decision.source, selected: item.options.includes(answer) };
}


/** La source qu'un effet porte au journal et au message reçu par l'étape. */
export function effectSource(effect: ArbiterEffect): DecisionSource {
  return effect.kind === "answer" ? effect.source : "arbitrage";
}


/** Inscrit l'outil `arbiter_decide` dans UNE session d'arbitre (S-9) : jamais ailleurs. */
export function registerArbiterTool(pi: ExtensionAPI, capture: ArbiterCapture): void {
  pi.registerTool({
    name: "arbiter_decide",
    label: "Arbitre — décider",
    description:
      "Rend la décision de l'arbitre sur l'élément soumis, UNE seule fois : decision = answer (réponse à une question : answer, source contexte ou arbitrage, citations = passages du corpus copiés mot pour mot), approve (jalon justifié par le contrat) ou escalate (l'utilisateur tranchera) ; reason dit pourquoi en une phrase.",
    approval: "read",
    loadMode: "essential",
    parameters: pi.arktype({
      decision: "'answer' | 'approve' | 'escalate'",
      "answer?": "string",
      "source?": "'contexte' | 'arbitrage'",
      "citations?": "string[]",
      reason: "string",
    }),
    async execute(_toolCallId: string, params: unknown) {
      const recorded = recordArbiterDecision(capture, params);
      return recorded.isError
        ? { content: [{ type: "text" as const, text: recorded.text }], isError: true }
        : { content: [{ type: "text" as const, text: recorded.text }] };
    },
  });
}
