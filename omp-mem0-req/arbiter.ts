// L'ARBITRE éphémère (S-9) : ce qu'il reçoit (prompt, corpus), ce qu'il rend
// (`arbiter_decide`) et la validation DÉTERMINISTE que le pilote en fait — qui lit
// le worktree en lecture seule pour vérifier les références `chemin:ligne`. Pas
// d'import de valeur de l'hôte : le lanceur (serviceRuns.ts), l'outil
// (extension.ts) et le contrôleur (lotController.ts) disent la même chose ici.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { JOURNAL_CONTEXT_MAX, journalLine, lotJournalLine } from "./context.ts";
import type { DecisionJustification, DecisionSource, JournalEntry } from "./context.ts";
import { contractSection, uncoveredAcIds, contractAcIds } from "./contract.ts";
import type { PipelinePhase } from "./contract.ts";
import { renderReviewEvidence } from "./arbiterReview.ts";
import type { ReviewEvidence } from "./arbiterReview.ts";
import { ARBITER_DIRECTIVE } from "./seeds.ts";

/** La ligne que le prompt d'un jalon « specs validées » porte (S-10) : ce que l'arbitre doit vérifier. */
const SPECS_CHECK = "vérification exigée : chaque AC-<n> du contrat est référencé par une spécification S-<n>, et les spécifications sont cohérentes avec le rapport";

/** Ce qu'une approbation de jalon porte, comme une réponse : sans justification vérifiée, le pilote escalade. */
const MILESTONE_JUSTIFICATION = "approbation justifiée : au moins une `citations` (passage du contrat ou du rapport copié tel quel), `references` (chemin:ligne du worktree) ou `rubriques` vérifiable, sinon l'élément est escaladé";

/** La ligne que le prompt d'un jalon « revue propre » porte : les critères tirés dont l'arbitre cite l'assertion de test. */
function reviewCheck(sampledAcIds: readonly string[]): string {
  return (
    `vérification exigée : pour ${sampledAcIds.join(" et ")}, cite en \`references\` (chemin:ligne d'un fichier du diff qui porte l'id du critère) ` +
    "l'assertion de test qui matérialise le « Then » du critère — sans cette référence, l'approbation est refusée"
  );
}

/** Les sections du contrat qu'une question reçoit, par étape : celles que l'étape écrit ou lit. */
const QUESTION_SECTIONS: Record<PipelinePhase, readonly string[]> = {
  req: ["Besoins", "Critères d'acceptation"],
  specs: ["Critères d'acceptation", "Spécifications", "Lots"],
  impl: ["Critères d'acceptation", "Spécifications", "Lots"],
  review: ["Critères d'acceptation", "Revue"],
  release: ["Besoins", "Critères d'acceptation", "Revue"],
};


/** L'échéance d'un run d'arbitre (S-9) : dix minutes. */
export const ARBITER_DEADLINE_MS = 600_000;

/**
 * Les SEULS outils d'une session d'arbitre (S-5) : le dépôt en lecture seule
 * (`read`, `grep`, `glob`, `lsp`) et l'outil de décision. Liste blanche : tout autre
 * outil (`bash`, `write`, `edit`, …) est retiré des outils actifs ET refusé à
 * l'appel.
 */
export const ARBITER_TOOLS = ["read", "grep", "glob", "lsp", "arbiter_decide"] as const;

/** Les genres d'éléments que l'arbitre peut juger : le quota n'y va JAMAIS. */
export type ArbiterItemKind = "ask" | "question" | "specs" | "review" | "cap" | "failure";

export type ArbiterItem = {
  kind: ArbiterItemKind;
  slug: string;
  phase: PipelinePhase;
  /** La question d'une étape (`ask`, `question`) ; `null` pour un jalon, un plafond et un échec. */
  question: string | null;
  options: string[];
  /** La raison d'arrêt de la feature (cap, failure). */
  stopReason?: string | null;
  /** La fin de sortie du run échoué (failure) : `feature.failureOutput ?? null`. */
  output?: { stderr: string; stdout: string } | null;
  /** Les sections `## Revue` et `## Corrections` du contrat du worktree (cap). */
  review?: string | null;
  corrections?: string | null;
};

/** Ce que l'outil `arbiter_decide` transporte (S-6). */
export type ArbiterDecision = {
  decision: "answer" | "approve" | "escalate" | "relaunch" | "abandon";
  answer?: string;
  source?: "contexte" | "arbitrage";
  /** Le recentrage d'une relance du plafond : les bloquants à lever et ce qui a déjà été tenté. */
  refocus?: string;
  /** Passages copiés tels quels du corpus (espaces repliés). */
  citations?: string[];
  /** `chemin:ligne` ou `chemin:début-fin`, chemin relatif au worktree. */
  references?: string[];
  /** Titres de rubriques du rapport. */
  rubriques?: string[];
  reason: string;
};

/** La décision retenue d'une session d'arbitre : le PREMIER appel de l'outil, ensuite plus rien. */
export type ArbiterCapture = { decision: ArbiterDecision | null };

/**
 * Ce que le pilote lit pour vérifier une décision (S-6) : le corpus (citations), le
 * rapport COMPLET (rubriques, pas le corpus tronqué), le worktree (références), le
 * contrat et l'évidence du jalon « revue propre » (`null` hors de ce jalon).
 */
export type ArbiterGround = {
  corpus: string;
  report: string | null;
  worktree: string;
  contract: string | null;
  review: ReviewEvidence | null;
};

/**
 * L'effet d'une décision VALIDÉE, que le contrôleur applique. `justification` : ce
 * que le pilote a vérifié, inscrit au journal (S-11) — le raccourci du journal n'en
 * porte pas.
 */
export type ArbiterEffect =
  | { kind: "answer"; answer: string; source: "contexte" | "arbitrage"; selected: boolean; justification?: DecisionJustification }
  | { kind: "approve"; justification?: DecisionJustification }
  | { kind: "escalate"; reason: string }
  | { kind: "relaunch"; refocus: string | null; justification: DecisionJustification }
  | { kind: "abandon"; reason: string; justification: DecisionJustification };

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


/** La question affichée d'un élément : celle de l'étape, le jalon, ou le plafond / l'échec (S-3 §5). */
export function itemQuestion(item: ArbiterItem): string {
  if (item.kind === "cap") return "plafond de la boucle revue ⇄ correction atteint : relancer un cycle, répondre au maillon /review ou abandonner ?";
  if (item.kind === "failure") return `échec du run /${item.phase} : relancer ou abandonner ?`;
  return item.question ?? milestoneQuestion(item.kind as "specs" | "review");
}


/** La borne du corpus de l'arbitre (S-4), en caractères (unités de `String.prototype.length`). */
export const ARBITER_CORPUS_MAX_CHARS = 200_000;

const NO_REPORT = "(aucun rapport)";
const NO_CONTRACT_SECTION = "(aucune section du contrat ne concerne cet élément)";
const NOT_SUBMITTED = "(non soumis à un plafond ou à un échec : revue, corrections et sortie du run font foi)";
const NO_BRIEF = "(aucun brief validé)";
const NO_CONTRACT = "(contrat absent)";
const NO_DECISION = "- (aucune décision consignée)";
const REPORT_CUT = "[… fin du rapport coupée]";
const CONTRACT_CUT = "[… fin du contrat coupée]";


/** Le plus petit entier de `[from, to]` pour lequel `ok` vaut vrai (`ok` croît avec l'entier), sinon `to`. */
function smallestFitting(from: number, to: number, ok: (n: number) => boolean): number {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}


/** Les sections `## <titre>` du contrat (dernière occurrence, titre compris) qui existent parmi `titles`, dans cet ordre. */
function keepSections(contract: string, titles: readonly string[]): string {
  const sections: string[] = [];
  for (const title of titles) {
    const body = contractSection(contract, title);
    if (body !== null) sections.push(`## ${title}\n${body.trim()}`);
  }
  return sections.join("\n\n");
}


/** Le contrat sans AUCUNE occurrence de `## <titre>` (un maillon peut l'avoir dupliquée). */
function dropSection(contract: string, title: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of contract.split("\n")) {
    if (line.trim() === `## ${title}`) {
      skipping = true;
      continue;
    }
    if (skipping && line.trimStart().startsWith("## ")) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim();
}


/**
 * Ce que l'arbitre lit du contrat selon le genre de l'élément : une question, les
 * sections de son étape (le contrat entier si l'étape n'est pas connue) ; « specs
 * validées », AC + Spécifications + Lots ; plafond et échec, AC + Revue + Corrections ;
 * « revue propre », le contrat SANS `## Revue` — l'arbitre juge le diff et les tests,
 * pas le verdict du reviewer, qu'il ne ferait que répéter.
 */
export function arbiterContractExcerpt(contract: string, kind: ArbiterItemKind, phase?: PipelinePhase): string {
  if (contract === "") return "";
  switch (kind) {
    case "review":
      return dropSection(contract, "Revue");
    case "specs":
      return keepSections(contract, QUESTION_SECTIONS.specs);
    case "cap":
    case "failure":
      return keepSections(contract, ["Critères d'acceptation", "Revue", "Corrections"]);
    default:
      return phase === undefined ? contract : keepSections(contract, QUESTION_SECTIONS[phase]);
  }
}


/**
 * Le CORPUS de l'arbitre (S-4), dans l'ordre : rapport, brief, contrat, journal du
 * LOT (les `lotMax` plus récentes entrées), journal de la feature (les 50 plus
 * récentes). Le contrat est réduit par genre (`arbiterContractExcerpt`) ; un plafond
 * ou un échec ne reçoit ni rapport ni brief (il se juge sur la revue, les corrections
 * et la sortie du run). Au-delà de `maxChars`, on sacrifie d'abord les plus anciennes
 * entrées du journal du lot, puis la fin du rapport, puis la fin du contrat — jamais
 * le brief ni le journal de la feature — et une ligne de tête annonce les coupes.
 */
export function buildArbiterCorpus(input: {
  kind: ArbiterItemKind;
  /** L'étape de l'élément : borne le contrat d'une question à ses sections. */
  phase?: PipelinePhase;
  report: string | null;
  brief: string | null;
  contract: string | null;
  slug: string;
  lotEntries: readonly JournalEntry[];
  lotMax: number;
  featureEntries: readonly JournalEntry[];
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? ARBITER_CORPUS_MAX_CHARS;
  const bare = input.kind === "cap" || input.kind === "failure";
  const report = bare ? "" : (input.report ?? "").trim();
  const whole = (input.contract ?? "").trim();
  const contract = arbiterContractExcerpt(whole, input.kind, input.phase);
  const brief = bare ? "" : (input.brief ?? "").trim();
  const noReport = bare ? NOT_SUBMITTED : NO_REPORT;
  const noBrief = bare ? NOT_SUBMITTED : NO_BRIEF;
  const noContract = whole === "" ? NO_CONTRACT : NO_CONTRACT_SECTION;
  const recentLot = input.lotEntries.slice(Math.max(0, input.lotEntries.length - Math.max(0, input.lotMax)));
  const lotBase = input.lotEntries.length - recentLot.length;
  const omittedFeature = Math.max(0, input.featureEntries.length - JOURNAL_CONTEXT_MAX);
  const featureLines = [
    ...(omittedFeature > 0 ? [`- (${omittedFeature} décisions plus anciennes omises)`] : []),
    ...input.featureEntries.slice(omittedFeature).map(journalLine),
  ];

  // `dropped` : entrées du lot retirées par la troncature ; `reportKeep`/`contractKeep` : caractères gardés.
  const render = (dropped: number, reportKeep: number, contractKeep: number): string => {
    const cut: string[] = [];
    if (dropped > 0) cut.push("journal du lot");
    if (reportKeep < report.length) cut.push("rapport");
    if (contractKeep < contract.length) cut.push("contrat");
    const omittedLot = lotBase + dropped;
    const lotLines = [
      ...(omittedLot > 0 ? [`- (${omittedLot} décisions plus anciennes omises)`] : []),
      ...recentLot.slice(dropped).map(lotJournalLine),
    ];
    return [
      ...(cut.length > 0 ? [`(corpus tronqué à ${maxChars} caractères — sections coupées : ${cut.join(", ")})`] : []),
      ["### Rapport", report === "" ? noReport : reportKeep < report.length ? `${report.slice(0, reportKeep)}\n${REPORT_CUT}` : report].join("\n"),
      ["### Brief", brief === "" ? noBrief : brief].join("\n"),
      ["### Contrat", contract === "" ? noContract : contractKeep < contract.length ? `${contract.slice(0, contractKeep)}\n${CONTRACT_CUT}` : contract].join("\n"),
      ["### Journal du lot", ...(lotLines.length > 0 ? lotLines : [NO_DECISION])].join("\n"),
      [`### Journal de la feature ${input.slug}`, ...(featureLines.length > 0 ? featureLines : [NO_DECISION])].join("\n"),
    ].join("\n\n");
  };

  let dropped = 0;
  let reportKeep = report.length;
  let contractKeep = contract.length;
  const fits = (): boolean => render(dropped, reportKeep, contractKeep).length <= maxChars;
  if (!fits()) {
    if (recentLot.length > 0) {
      dropped = smallestFitting(1, recentLot.length, (n) => render(n, reportKeep, contractKeep).length <= maxChars);
    }
    if (!fits() && report !== "") {
      // le rapport rendu ne décroît qu'avec `keep` : plus grand `keep` qui tient, sinon 0
      reportKeep = report.length - smallestFitting(1, report.length, (n) => render(dropped, report.length - n, contractKeep).length <= maxChars);
    }
    if (!fits() && contract !== "") {
      contractKeep = contract.length - smallestFitting(1, contract.length, (n) => render(dropped, reportKeep, contract.length - n).length <= maxChars);
    }
  }
  return render(dropped, reportKeep, contractKeep);
}


/**
 * Le bloc d'un élément de type plafond ou échec (S-2), ou `null` pour les autres genres.
 * Il suit `étape : /<phase>` dans le prompt ET précède le corpus dans le texte où les
 * citations sont vérifiées : une citation tirée de la revue, des corrections ou de la
 * sortie du run est donc vérifiable.
 */
export function arbiterItemBlock(item: ArbiterItem): string | null {
  if (item.kind === "cap") {
    return [
      "type : plafond de la boucle revue ⇄ correction",
      `motif : ${item.stopReason ?? "(sans motif)"}`,
      "décisions possibles :",
      "- relaunch : relancer un cycle de correction ; `refocus` OBLIGATOIRE — les bloquants précis à lever et ce qui a déjà été tenté",
      "- abandon : abandonner la feature (worktree et branche conservés) ; `reason` est le motif d'arrêt",
      "- escalate : seulement si les bloquants dépendent d'un préalable extérieur (PR à fusionner, décision produit)",
      "",
      "## Revue (bloquants)",
      item.review ?? "(section absente)",
      "",
      "## Corrections",
      item.corrections ?? "(section absente)",
    ].join("\n");
  }
  if (item.kind === "failure") {
    const output =
      item.output === undefined || item.output === null
        ? ["sortie : (aucune sortie conservée)"]
        : ["stderr (fin) :", item.output.stderr || "(vide)", "stdout (fin) :", item.output.stdout || "(vide)"];
    return [
      "type : échec du run",
      `raison d'arrêt : ${item.stopReason ?? "(sans motif)"}`,
      ...output,
      "décisions possibles :",
      "- relaunch : relancer le run tel quel (mêmes modèle principal et repli) ; `refocus` est ignoré",
      "- escalate : quand la cause est hors de portée d'une relance (binaire absent, git refusé, authentification)",
    ].join("\n");
  }
  return null;
}


/** Le prompt de l'arbitre : directive, élément, corpus (S-9). */
export function buildArbiterPrompt(item: ArbiterItem, corpus: string, review: ReviewEvidence | null = null): string {
  const head = [
    "## Élément à arbitrer",
    `feature : ${item.slug}`,
    `étape : /${item.phase}`,
  ];
  const block = arbiterItemBlock(item);
  if (block !== null) {
    head.push(block);
  } else if (item.question !== null) {
    head.push(`type : question`, `question : ${item.question}`);
    if (item.options.length > 0) head.push("options :", ...item.options.map((label, index) => `${index + 1}. ${label}`));
  } else {
    head.push(`type : jalon « ${item.kind === "specs" ? "specs validées" : "revue propre"} »`);
    if (item.kind === "specs") head.push(SPECS_CHECK);
    else if (review !== null && review.sampledAcIds.length > 0) head.push(reviewCheck(review.sampledAcIds));
    head.push(MILESTONE_JUSTIFICATION);
  }
  const evidence = item.kind === "review" && review !== null ? `\n\n${renderReviewEvidence(review)}` : "";
  return `${ARBITER_DIRECTIVE}\n\n${head.join("\n")}${evidence}\n\n## Corpus\n\n${corpus}`;
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
  if (
    decision !== "answer" &&
    decision !== "approve" &&
    decision !== "escalate" &&
    decision !== "relaunch" &&
    decision !== "abandon"
  ) {
    return { text: "Error: decision doit valoir answer, approve, escalate, relaunch ou abandon", isError: true };
  }
  const source = record.source === "contexte" || record.source === "arbitrage" ? record.source : undefined;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
  const citations = strings(record.citations);
  const references = strings(record.references);
  const rubriques = strings(record.rubriques);
  capture.decision = {
    decision,
    reason: typeof record.reason === "string" ? record.reason : "",
    ...(typeof record.answer === "string" ? { answer: record.answer } : {}),
    ...(typeof record.refocus === "string" ? { refocus: record.refocus } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(citations !== undefined ? { citations } : {}),
    ...(references !== undefined ? { references } : {}),
    ...(rubriques !== undefined ? { rubriques } : {}),
  };
  return { text: ARBITER_RECORDED, isError: false };
}


/** Le nombre de lignes d'un texte : une fin de fichier `\n` ne compte pas de ligne vide en plus. */
function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}


function leavesRoot(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}


const REFERENCE = /^(.+):(\d+)(?:-(\d+))?$/;


/**
 * Le motif de rejet d'une référence `chemin:ligne` / `chemin:début-fin` (S-6), ou
 * `null` si elle est valide : chemin relatif au worktree, fichier régulier qui y
 * est réellement (liens symboliques résolus), lignes dans sa plage.
 */
function referenceRejection(raw: string, worktree: string): string | null {
  const ref = raw.trim();
  const reject = (why: string): string => `référence rejetée « ${ref} » (${why})`;
  const match = REFERENCE.exec(ref);
  if (match === null) return reject("référence illisible");
  const file = match[1] as string;
  if (path.isAbsolute(file)) return reject("chemin absolu");
  let root: string;
  try {
    root = fs.realpathSync(worktree);
  } catch {
    return reject("fichier absent");
  }
  const resolved = path.resolve(root, file);
  if (leavesRoot(path.relative(root, resolved))) return reject("hors du worktree");
  let text: string;
  try {
    const real = fs.realpathSync(resolved);
    if (leavesRoot(path.relative(root, real))) return reject("hors du worktree");
    if (!fs.statSync(real).isFile()) return reject("fichier absent");
    text = fs.readFileSync(real, "utf8");
  } catch {
    return reject("fichier absent");
  }
  const lines = lineCount(text);
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (start < 1 || end < start || end > lines) return reject(`ligne hors du fichier, ${lines} lignes`);
  return null;
}


/** Une rubrique ou un titre, comparés : `#` de tête retirés, espaces repliés, minuscules. */
function normalizeRubrique(text: string): string {
  return foldSpaces(text.replace(/^\s*#+/, "")).toLowerCase();
}


/** Les titres markdown d'un rapport, normalisés. */
function reportTitles(report: string | null): Set<string> {
  const titles = new Set<string>();
  if (report === null) return titles;
  for (const line of report.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match !== null) titles.add(normalizeRubrique(match[1] as string));
  }
  return titles;
}


type VerifiedJustifications = {
  /** Combien de justifications non vides l'arbitre a fournies. */
  provided: number;
  citations: string[];
  references: string[];
  rubriques: string[];
  rejected: string[];
};


/** Vérifie CHAQUE citation, référence et rubrique (S-6) ; les rejetées sont écartées, avec leur motif. */
function verifyJustifications(decision: ArbiterDecision, ground: ArbiterGround): VerifiedJustifications {
  const kept = (values: readonly string[] | undefined): string[] => (values ?? []).filter((value) => value.trim() !== "");
  const out: VerifiedJustifications = { provided: 0, citations: [], references: [], rubriques: [], rejected: [] };
  const folded = foldSpaces(ground.corpus);
  for (const citation of kept(decision.citations)) {
    out.provided += 1;
    if (folded.includes(foldSpaces(citation))) out.citations.push(citation);
    else {
      const head = citation.trim().slice(0, 80);
      out.rejected.push(`citation absente du corpus « ${head}${citation.trim().length > 80 ? "[…]" : ""} »`);
    }
  }
  for (const reference of kept(decision.references)) {
    out.provided += 1;
    const rejection = referenceRejection(reference, ground.worktree);
    if (rejection === null) out.references.push(reference.trim());
    else out.rejected.push(rejection);
  }
  const rubriques = kept(decision.rubriques);
  const titles = rubriques.length > 0 ? reportTitles(ground.report) : new Set<string>();
  for (const rubrique of rubriques) {
    out.provided += 1;
    if (titles.has(normalizeRubrique(rubrique))) out.rubriques.push(rubrique.trim());
    else out.rejected.push(`rubrique absente du rapport « ${rubrique.trim()} »`);
  }
  return out;
}


/** `norm` de S-8 : espaces repliés, minuscules, ponctuation finale `[.!?;:,…]` retirée. */
function normalizeOption(text: string): string {
  return foldSpaces(text).toLowerCase().replace(/[.!?;:,…]+$/, "").trim();
}


/**
 * L'option qu'une réponse désigne (S-8) : son numéro, son libellé exact, son libellé
 * normalisé — le libellé CANONIQUE est rendu, sélectionné. Sinon la réponse reste
 * libre. Un numéro seul hors plage est refusé (`escalate`).
 */
function chooseOption(options: readonly string[], answer: string): { answer: string; selected: boolean } | { escalate: string } {
  if (options.length === 0) return { answer, selected: false };
  if (/^\d+$/.test(answer)) {
    const number = Number(answer);
    if (number < 1 || number > options.length) return { escalate: `option ${number} hors plage (1-${options.length})` };
    return { answer: options[number - 1] as string, selected: true };
  }
  const exact = options.find((label) => label === answer);
  if (exact !== undefined) return { answer: exact, selected: true };
  const wanted = normalizeOption(answer);
  const loose = options.find((label) => normalizeOption(label) === wanted);
  if (loose !== undefined) return { answer: loose, selected: true };
  return { answer, selected: false };
}


/**
 * Pourquoi le pilote refuse d'approuver un jalon (S-9, S-10), ou `null` : « specs
 * validées » exige un AC référencé par une S-<n> ; « revue propre » exige que chaque
 * AC porte au moins un fichier DU DIFF. Vérification DÉTERMINISTE, en plus du
 * jugement de l'arbitre.
 */
function approvalRefusal(item: ArbiterItem, ground: ArbiterGround): string | null {
  if (item.kind !== "specs" && item.kind !== "review") return null;
  const contract = ground.contract ?? "";
  if (contractAcIds(contract).length === 0) return "contrat sans critère d'acceptation";
  if (item.kind === "specs") {
    const uncovered = uncoveredAcIds(contract);
    return uncovered.length === 0 ? null : `critères sans spécification S-n : ${uncovered.join(", ")}`;
  }
  if (ground.review === null) return "recherche des critères impossible : évidence absente";
  if (ground.review.acFiles === null) return `recherche des critères impossible : ${ground.review.searchError ?? "erreur inconnue"}`;
  const bare = ground.review.acFiles.filter((entry) => entry.files.length === 0).map((entry) => entry.id);
  return bare.length === 0 ? null : `critères sans fichier dans le diff : ${bare.join(", ")}`;
}


/**
 * Les critères tirés qu'aucune référence VÉRIFIÉE n'atteste : une référence atteste
 * AC-<n> quand elle pointe dans un fichier du diff qui porte cet id (`acFiles`). Le
 * pilote ne lit pas l'assertion : il garantit seulement que l'arbitre a désigné un
 * endroit précis du diff pour chaque critère tiré, au lieu d'approuver sur le verdict.
 */
function unattestedAcIds(review: ReviewEvidence, references: readonly string[]): string[] {
  const cited = references.map((reference) => path.posix.normalize((REFERENCE.exec(reference)?.[1] ?? "").replace(/\\/g, "/")));
  return review.sampledAcIds.filter((id) => {
    const files = review.acFiles?.find((entry) => entry.id === id)?.files ?? [];
    return !cited.some((file) => files.includes(file));
  });
}


/**
 * La validation DÉTERMINISTE d'une décision (S-6, S-8). Question : `answer` exige une
 * réponse non vide, une source `contexte`/`arbitrage` et au moins UNE justification
 * VÉRIFIÉE — citation du corpus (espaces repliés), référence `chemin:ligne` qui
 * existe dans le worktree, rubrique du rapport —, puis la réponse est rapprochée des
 * options. Jalon : seul `approve` (motif non vide, `approvalRefusal` : couverture
 * AC → S-n ou AC → fichiers du diff, puis la même justification vérifiée qu'une
 * réponse, et pour « revue propre » une référence dans le diff pour chaque critère
 * tiré) ou `escalate` ; un refus d'approbation se rend « approbation refusée par le
 * pilote : <motif> ». Tout autre cas se rend en escalade, avec son motif ; une décision
 * `escalate` est toujours honorée telle quelle.
 */
export function validateArbiterDecision(
  item: ArbiterItem,
  decision: ArbiterDecision | null,
  ground: ArbiterGround,
): ArbiterEffect {
  if (decision === null) return { kind: "escalate", reason: "arbitre sans décision" };
  const invalid = (motif: string): ArbiterEffect => ({ kind: "escalate", reason: `décision d'arbitre invalide : ${motif}` });
  if (decision.decision === "escalate") {
    return { kind: "escalate", reason: decision.reason.trim() || "escalade demandée par l'arbitre" };
  }
  const justify = (verified: VerifiedJustifications): DecisionJustification => ({
    reason: decision.reason.trim(),
    citations: verified.citations,
    references: verified.references,
    rubriques: verified.rubriques,
  });
  /** Au moins une justification VÉRIFIÉE, sinon le motif du refus. */
  const verifiedOrRefusal = (): VerifiedJustifications | string => {
    const verified = verifyJustifications(decision, ground);
    if (verified.provided === 0) return "aucune justification";
    if (verified.citations.length + verified.references.length + verified.rubriques.length === 0) {
      return `aucune justification vérifiée — ${verified.rejected.join(" ; ")}`;
    }
    return verified;
  };
  if (item.kind === "cap" || item.kind === "failure") {
    const where = item.kind === "cap" ? "au plafond" : "à un échec";
    if (decision.decision === "answer" || decision.decision === "approve") return invalid(`« ${decision.decision} » ne s'applique pas ${where}`);
    if (decision.decision === "abandon" && item.kind === "failure") return invalid("« abandon » ne s'applique pas à un échec");
    const refocus = (decision.refocus ?? "").trim();
    if (item.kind === "cap" && decision.decision === "relaunch" && refocus === "") return invalid("recentrage vide");
    if (decision.reason.trim() === "") return invalid("motif d'approbation vide");
    const verified = verifiedOrRefusal();
    if (typeof verified === "string") return invalid(verified);
    if (decision.decision === "abandon") return { kind: "abandon", reason: decision.reason.trim(), justification: justify(verified) };
    return { kind: "relaunch", refocus: item.kind === "cap" ? refocus : null, justification: justify(verified) };
  }
  if (decision.decision === "relaunch" || decision.decision === "abandon") {
    return invalid(`« ${decision.decision} » ne s'applique qu'au plafond ou à un échec`);
  }
  if (item.question === null) {
    if (decision.decision !== "approve") return invalid("un jalon s'approuve ou s'escalade");
    if (decision.reason.trim() === "") return invalid("motif d'approbation vide");
    const refused = (motif: string): ArbiterEffect => ({ kind: "escalate", reason: `approbation refusée par le pilote : ${motif}` });
    const refusal = approvalRefusal(item, ground);
    if (refusal !== null) return refused(refusal);
    const verified = verifiedOrRefusal();
    if (typeof verified === "string") return refused(verified);
    if (item.kind === "review" && ground.review !== null) {
      const unattested = unattestedAcIds(ground.review, verified.references);
      if (unattested.length > 0) return refused(`assertion non citée pour ${unattested.join(", ")}`);
    }
    return { kind: "approve", justification: justify(verified) };
  }
  if (decision.decision !== "answer") return invalid("une question se répond ou s'escalade");
  const answer = (decision.answer ?? "").trim();
  if (answer === "") return invalid("réponse vide");
  if (decision.source !== "contexte" && decision.source !== "arbitrage") return invalid("source absente ou inconnue");
  const verified = verifiedOrRefusal();
  if (typeof verified === "string") return invalid(verified);
  const chosen = chooseOption(item.options, answer);
  if ("escalate" in chosen) return invalid(chosen.escalate);
  return { kind: "answer", answer: chosen.answer, source: decision.source, selected: chosen.selected, justification: justify(verified) };
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
      "Rend la décision de l'arbitre sur l'élément soumis, UNE seule fois : decision = answer (réponse à une question : answer — le libellé exact ou le numéro d'une option —, source contexte ou arbitrage, et au moins une justification : citations = passages du corpus copiés tels quels, references = chemin:ligne ou chemin:début-fin dans le worktree, rubriques = titres du rapport), approve (jalon : au moins une justification vérifiable comme une réponse ; jalon « revue propre » : references vers l'assertion de test de chaque critère tiré, dans un fichier du diff), relaunch (plafond de la boucle revue ⇄ correction : refocus = les bloquants précis à lever et ce qui a déjà été tenté ; échec d'un run : relance telle quelle), abandon (plafond seulement : reason est le motif d'arrêt) ou escalate (l'utilisateur tranchera) ; relaunch et abandon portent au moins une justification vérifiable ; sans justification vérifiée, le pilote escalade ; reason dit pourquoi en une phrase.",
    approval: "read",
    loadMode: "essential",
    parameters: pi.arktype({
      decision: "'answer' | 'approve' | 'escalate' | 'relaunch' | 'abandon'",
      "answer?": "string",
      "source?": "'contexte' | 'arbitrage'",
      "refocus?": "string",
      "citations?": "string[]",
      "references?": "string[]",
      "rubriques?": "string[]",
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
