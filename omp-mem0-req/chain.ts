// La chaîne : décision pure du maillon suivant.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { contractHasSection, contractSection, reviewVerdict } from "./contract.ts";
import type { PipelinePhase } from "./contract.ts";
import { contractPathFor } from "./git.ts";
import type { LotWaitKind } from "./lot.ts";



// --- la chaîne : une décision pure, appliquée par le pilote (S-4, S-5) --------

export type ChainOutcome = "ok" | "error";

export type ChainAction =
  | { kind: "run"; phase: PipelinePhase; fix: boolean }
  | { kind: "wait"; waitKind: LotWaitKind }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "done" };


/**
 * Le verdict d'un run de revue, du point de vue du pilote : `unreadable` quand la
 * section `## Revue` n'a pas été réécrite par CE run — le texte lu viendrait alors
 * d'un autre maillon, jamais d'une revue. Partagé par la décision (`nextChainAction`)
 * et par ce que le pilote PUBLIE de ce verdict : une seule règle, deux lecteurs.
 */
export function effectiveReviewVerdict(contract: string, reviewRewritten: boolean): "blockers" | "clean" | "unreadable" {
  if (!reviewRewritten) return "unreadable";
  return reviewVerdict(contract);
}


/** Le motif de blocage d'une boucle revue ⇄ correction arrivée à son plafond (S-6). */
export function reviewCapReason(cap: number): string {
  return `plafond de ${cap} tours de correction atteint, revue toujours bloquante`;
}


/** Le motif est-il celui du plafond de la boucle revue ⇄ correction ? */
export function isReviewCapReason(reason: string | null): boolean {
  return reason !== null && /^plafond de \d+ tours de correction atteint, revue toujours bloquante$/.test(reason);
}


/**
 * Le maillon suivant, décidé par le seul contrat (+ l'issue du run, la question
 * qui a terminé sa sortie et les compteurs du plafond). Pure : c'est la même
 * décision pour une feature de lot et pour une feature ouverte par /req (AC-4), et
 * c'est elle que les tests figent.
 *
 * Les deux jalons de l'utilisateur sont ici : `specs` produit ⇒ `wait specs`
 * (AC-8), revue propre ⇒ `wait review` (AC-9). La boucle de correction est bornée
 * par `cap` (AC-7).
 *
 * `question` est la question en TEXTE qui a terminé la sortie du run (S-8 §1) :
 * un maillon specs/impl/review qui n'a pas rendu son livrable et pose ses
 * questions attend une réponse — le relancer en aveugle perdrait la question, et
 * un /review sans verdict relancé jusqu'au plafond finit en « illisible » alors
 * que l'agent attendait depuis le premier tour. `reviewRewritten` dit si la
 * section `## Revue` a été réécrite par CE run : une section inchangée n'est pas
 * un verdict de revue (le texte lu viendrait de /impl --fix).
 */
export function nextChainAction(input: {
  phase: PipelinePhase;
  outcome: ChainOutcome;
  contract: string;
  fixes: number;
  /**
   * Passes de revue au verdict ILLISIBLE déjà consommées. Facultatif : un appelant
   * qui ne le fournit pas est traité comme « aucune » — un compteur absent ne doit
   * jamais faire bloquer une feature, et le pilote, lui, le passe toujours.
   */
  unreadableRuns?: number;
  cap: number;
  question?: string | null;
  reviewRewritten?: boolean;
}): ChainAction {
  const { phase, outcome, contract, fixes, cap } = input;
  const unreadableRuns = input.unreadableRuns ?? 0;
  // La raison précise est attachée par le pilote (dernière ligne de stderr,
  // dépassement, binaire absent) : ici on ne connaît que l'issue.
  if (outcome === "error") return { kind: "failed", reason: "exécution en échec" };
  const asked = typeof input.question === "string" && input.question.trim() !== "" ? input.question : null;
  const hasSpecs = contractHasSection(contract, "Spécifications");
  switch (phase) {
    case "req": {
      const closed =
        contractHasSection(contract, "Besoins") && contractHasSection(contract, "Critères d'acceptation");
      // Collecte close (les deux sections sont écrites) ⇒ specs ; sinon le run a
      // posé ses questions et l'utilisateur doit répondre (AC-12).
      return closed ? { kind: "run", phase: "specs", fix: false } : { kind: "wait", waitKind: "answer" };
    }
    case "specs":
      if (hasSpecs) return { kind: "wait", waitKind: "specs" };
      // Le livrable manque ET l'agent a posé une question : il attend une réponse,
      // il n'a pas échoué (S-8 §1). La détection vient APRÈS le livrable : une
      // sortie qui a écrit les specs garde son jalon, options comprises.
      if (asked !== null) return { kind: "wait", waitKind: "answer" };
      return { kind: "blocked", reason: "aucune spécification écrite par /specs" };
    case "impl":
      if (asked !== null) return { kind: "wait", waitKind: "answer" };
      return hasSpecs
        ? { kind: "run", phase: "review", fix: false }
        : { kind: "blocked", reason: "le contrat n'a plus de section ## Spécifications" };
    case "review": {
      // Une section `## Revue` inchangée veut dire que CE run de revue n'a rien
      // écrit : le verdict n'est pas lisible, quel que soit le texte laissé par un
      // autre maillon (/impl --fix écrit sous `## Corrections`, jamais là).
      const verdict = effectiveReviewVerdict(contract, input.reviewRewritten !== false);
      if (verdict === "clean") return { kind: "wait", waitKind: "review" };
      if (verdict === "blockers") {
        if (fixes < cap) return { kind: "run", phase: "impl", fix: true };
        return { kind: "blocked", reason: reviewCapReason(cap) };
      }
      // Illisible : la question en texte du run passe avant une nouvelle passe.
      if (asked !== null) return { kind: "wait", waitKind: "answer" };
      // Le budget de l'illisible est le SIEN (S-5) : le compter sur `reviewRuns`
      // faisait bloquer une feature dès qu'elle avait corrigé ses bloquants.
      if (unreadableRuns < cap) return { kind: "run", phase: "review", fix: false };
      return { kind: "blocked", reason: `verdict de revue illisible après ${cap} passes` };
    }
    case "release":
      return { kind: "done" };
  }
}


/**
 * Un run interrompu (pilote disparu) se juge sur le seul indice disponible : le
 * contrat a-t-il bougé ? Modifié ⇒ le maillon a fait son travail, la chaîne
 * reprend ; inchangé ⇒ rien n'a été produit, la feature échoue et reste
 * relançable (S-1).
 */
export function reconcileInterrupted(input: {
  contractHashAtStart: string | null;
  currentContractHash: string | null;
}): "continue" | "failed" {
  if (input.currentContractHash !== null && input.currentContractHash !== input.contractHashAtStart) return "continue";
  return "failed";
}


/** sha1 du contrat d'un worktree, `null` s'il n'existe pas encore. */
export function contractHashOf(worktree: string): string | null {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(contractPathFor(worktree), "utf8")).digest("hex");
  } catch {
    return null;
  }
}


/**
 * sha1 de la DERNIÈRE section `## Revue` d'un worktree, `null` si elle n'existe
 * pas. Le pilote le fige au LANCEMENT d'un run de revue et le relit à sa fin :
 * une empreinte identique veut dire que ce run n'a rien écrit — le verdict lu ne
 * serait donc pas celui d'une revue, et vaut `unreadable` (jamais `clean`).
 */
export function reviewSectionHash(worktree: string): string | null {
  const section = contractSection(readContractText(worktree), "Revue");
  if (section === null) return null;
  return crypto.createHash("sha1").update(section).digest("hex");
}


/** Contenu du contrat d'un worktree, `""` s'il est absent ou illisible. */
export function readContractText(worktree: string): string {
  try {
    return fs.readFileSync(contractPathFor(worktree), "utf8");
  } catch {
    return "";
  }
}
