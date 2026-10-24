// Le contradicteur : en fin de /req et de /specs, un agent NEUF relit l'artefact pour le
// prendre en défaut, avant que la suite du run ne le prenne pour acquis.
//
// Il ne surveille pas l'étape pendant qu'elle travaille : il juge un artefact fini, à la
// porte, dans un contexte vierge et — si la chaîne du tier en a un — chez un autre
// fournisseur que l'auteur (mêmes angles morts sinon). Il rend ses constats par l'outil
// hôte `challenge_report`, validés ici : chacun cite l'id qu'il vise et l'extrait qui le
// prouve. L'auteur répond ensuite dans l'artefact (`## Contradicteur`), point par point,
// `corrigé` ou `réfuté`. Un constat bloquant qui n'est pas corrigé est un DÉSACCORD entre
// deux agents : la porte des specs le soumet à l'humain, seul arbitre.
import type { ChallengeStep } from "./config.ts";

export type Severity = "bloquant" | "majeur" | "mineur";

export const SEVERITIES: readonly Severity[] = ["bloquant", "majeur", "mineur"];

/** Ce que le contradicteur peut reprocher à un artefact de contrat. */
export const FINDING_KINDS = [
  /** La demande admet plusieurs lectures et l'artefact en retient une sans le dire. */
  "ambiguite",
  /** La demande (ou l'oracle) implique un besoin que l'artefact n'a pas. */
  "besoin_manquant",
  /** L'artefact ajoute ce que personne n'a demandé. */
  "hors_demande",
  /** Un critère ne prouve pas son besoin (pas observable, trop large, tautologique). */
  "critere_faible",
  /** Un cas limite ou d'erreur que le comportement attendu laisse ouvert. */
  "cas_manquant",
  /** Une spec ou un critère qu'aucun test automatisé ne peut trancher. */
  "non_testable",
  /** Une spec qui s'écarte des besoins, du hors-périmètre ou d'une décision de l'oracle. */
  "derive",
  /** Deux passages, ou l'artefact et le dépôt, se contredisent. */
  "contradiction",
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

export type Finding = {
  /** `C-n`, posé par le service dans l'ordre du rapport. */
  id: string;
  /** L'id visé (`B-n`, `AC-n`, `S-n`), ou `""` pour l'artefact entier. */
  target: string;
  kind: FindingKind;
  severity: Severity;
  claim: string;
  /** L'extrait de la demande, de l'artefact ou du dépôt qui prouve le constat. */
  evidence: string;
  suggestion: string;
};

/** Les constats au-delà desquels le rapport est tronqué : le contradicteur hiérarchise. */
export const MAX_FINDINGS = 8;

const TARGET = /^(?:B|AC|S)-\d+$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Valide les arguments de `challenge_report` : chaque constat a un type et une gravité
 * connus, un énoncé, une PREUVE (un constat sans extrait n'en est pas un) et vise un id
 * de l'artefact ou rien. Les ids `C-n` sont posés ici, bloquants d'abord.
 */
export function parseFindings(
  args: Record<string, unknown>,
): { ok: true; findings: Finding[] } | { ok: false; error: string } {
  if (!Array.isArray(args.findings)) return { ok: false, error: "findings : liste attendue (vide si rien à redire)" };
  const findings: Omit<Finding, "id">[] = [];
  for (const [index, raw] of args.findings.entries()) {
    const item: Record<string, unknown> =
      typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...raw } : {};
    const kind = FINDING_KINDS.find((candidate) => candidate === item.kind);
    const severity = SEVERITIES.find((candidate) => candidate === item.severity);
    if (kind === undefined || severity === undefined)
      return {
        ok: false,
        error: `findings[${index}] : kind (${FINDING_KINDS.join(" | ")}) et severity (${SEVERITIES.join(" | ")}) attendus`,
      };
    const target = text(item.target);
    if (target !== "" && !TARGET.test(target))
      return { ok: false, error: `findings[${index}] : target est un id B-n, AC-n ou S-n, ou vide` };
    const claim = text(item.claim);
    const evidence = text(item.evidence);
    if (claim === "" || evidence === "")
      return {
        ok: false,
        error: `findings[${index}] : claim et evidence non vides attendus — un constat sans extrait qui le prouve n'en est pas un`,
      };
    findings.push({ target, kind, severity, claim, evidence, suggestion: text(item.suggestion) });
  }
  const ranked = findings
    .map((finding, order) => ({ finding, order }))
    .sort(
      (a, b) => SEVERITIES.indexOf(a.finding.severity) - SEVERITIES.indexOf(b.finding.severity) || a.order - b.order,
    )
    .slice(0, MAX_FINDINGS);
  return { ok: true, findings: ranked.map(({ finding }, index) => ({ id: `C-${index + 1}`, ...finding })) };
}

/** Les constats auxquels l'auteur doit répondre : les mineurs restent pour mémoire. */
export function toAnswer(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity !== "mineur");
}

export type Answer = { status: "corrigé" | "réfuté"; note: string };

/**
 * Les réponses de l'auteur, lues dans la section `## Contradicteur` de l'artefact :
 * une ligne `C-n : corrigé — …` ou `C-n : réfuté — …` par constat.
 */
export function parseAnswers(markdown: string): Map<string, Answer> {
  const answers = new Map<string, Answer>();
  let inside = false;
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inside = /^contradicteur/i.test(heading[1] ?? "");
      continue;
    }
    if (!inside) continue;
    const match =
      /^\s*(?:[-*]\s*)?\**(C-\d+)\**\s*:\s*\**(corrig[ée]e?s?|r[ée]fut[ée]e?s?)\**\s*(?:[—–:-]\s*)?(.*)$/i.exec(line);
    if (!match) continue;
    const id = match[1] as string;
    if (answers.has(id)) continue;
    const status = /^corrig/i.test(match[2] ?? "") ? "corrigé" : "réfuté";
    answers.set(id, { status, note: (match[3] ?? "").trim() });
  }
  return answers;
}

/** Les constats à répondre qui n'ont pas de réponse dans l'artefact. */
export function unanswered(findings: readonly Finding[], answers: ReadonlyMap<string, Answer>): string[] {
  return toAnswer(findings)
    .filter((finding) => !answers.has(finding.id))
    .map((finding) => finding.id);
}

/**
 * Les désaccords : un constat BLOQUANT que l'auteur n'a pas corrigé (réfuté, ou laissé
 * sans réponse). Deux agents ne s'entendent pas sur le contrat : l'humain tranche.
 */
export function disputes(findings: readonly Finding[], answers: ReadonlyMap<string, Answer>): string[] {
  return findings
    .filter((finding) => finding.severity === "bloquant" && answers.get(finding.id)?.status !== "corrigé")
    .map((finding) => finding.id);
}

/** Le passage du contradicteur sur une étape, tel que le service le garde (artefact interne). */
export type ChallengeRecord = {
  step: ChallengeStep;
  /** Le modèle du contradicteur (`fournisseur/modèle`), et celui de l'auteur relu. */
  model: string | null;
  authorModel: string | null;
  findings: Finding[];
  answers: Record<string, Answer>;
  disputes: string[];
};

/** L'artefact interne qui garde les passages du contradicteur (invisible des runners et des clients). */
export const CHALLENGE_STATE = "_contradicteur.json";

/** L'artefact lisible que les apps et les étapes suivantes voient. */
export const CHALLENGE_ARTIFACT = "contradicteur.md";

/** Les passages gardés d'un run, par étape (le dernier passage d'une étape remplace le précédent). */
export function readRecords(json: string | null): Partial<Record<ChallengeStep, ChallengeRecord>> {
  if (json === null) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Partial<Record<ChallengeStep, ChallengeRecord>>)
      : {};
  } catch {
    return {};
  }
}

/** `contradicteur.md` : chaque passage, ses constats et la réponse de l'auteur. */
export function renderRecords(records: Partial<Record<ChallengeStep, ChallengeRecord>>): string {
  const parts = ["# Contradicteur", ""];
  for (const step of ["req", "specs"] as const) {
    const record = records[step];
    if (!record) continue;
    parts.push(
      `## /${step} — relu par ${record.model ?? "modèle inconnu"} (auteur : ${record.authorModel ?? "modèle inconnu"})`,
      "",
    );
    if (record.findings.length === 0) parts.push("Rien à redire.", "");
    for (const finding of record.findings) {
      const answer = record.answers[finding.id];
      const verdict =
        finding.severity === "mineur"
          ? "pour mémoire"
          : answer
            ? `${answer.status}${answer.note ? ` — ${answer.note}` : ""}`
            : "sans réponse";
      parts.push(
        `- **${finding.id}** (${finding.severity}, ${finding.kind}${finding.target ? `, ${finding.target}` : ""}) : ${finding.claim}`,
        `  - preuve : ${finding.evidence}`,
        ...(finding.suggestion ? [`  - suggestion : ${finding.suggestion}`] : []),
        `  - réponse de l'auteur : ${verdict}`,
      );
    }
    if (record.disputes.length > 0) parts.push("", `Désaccord à trancher : ${record.disputes.join(", ")}.`);
    parts.push("");
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

/** Les désaccords encore ouverts de tous les passages, `/étape C-n`. */
export function openDisputes(records: Partial<Record<ChallengeStep, ChallengeRecord>>): string[] {
  return (["req", "specs"] as const).flatMap((step) => (records[step]?.disputes ?? []).map((id) => `/${step} ${id}`));
}
