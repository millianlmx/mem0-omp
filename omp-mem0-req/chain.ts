// La chaîne : décision pure du maillon suivant.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { contractHasSection, reviewVerdict } from "./contract.ts";
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
 * Le maillon suivant, décidé par le seul contrat (+ l'issue du run et les
 * compteurs du plafond). Pure : c'est la même décision pour une feature de lot et
 * pour une feature ouverte par /req (AC-4), et c'est elle que les tests figent.
 *
 * Les deux jalons de l'utilisateur sont ici : `specs` produit ⇒ `wait specs`
 * (AC-8), revue propre ⇒ `wait review` (AC-9). La boucle de correction est bornée
 * par `cap` (AC-7).
 */
export function nextChainAction(input: {
  phase: PipelinePhase;
  outcome: ChainOutcome;
  contract: string;
  fixes: number;
  reviewRuns: number;
  cap: number;
}): ChainAction {
  const { phase, outcome, contract, fixes, reviewRuns, cap } = input;
  // La raison précise est attachée par le pilote (dernière ligne de stderr,
  // dépassement, binaire absent) : ici on ne connaît que l'issue.
  if (outcome === "error") return { kind: "failed", reason: "exécution en échec" };
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
      return hasSpecs
        ? { kind: "wait", waitKind: "specs" }
        : { kind: "blocked", reason: "aucune spécification écrite par /specs" };
    case "impl":
      return hasSpecs
        ? { kind: "run", phase: "review", fix: false }
        : { kind: "blocked", reason: "le contrat n'a plus de section ## Spécifications" };
    case "review": {
      const verdict = reviewVerdict(contract);
      if (verdict === "clean") return { kind: "wait", waitKind: "review" };
      if (verdict === "blockers") {
        if (fixes < cap) return { kind: "run", phase: "impl", fix: true };
        return { kind: "blocked", reason: `plafond de ${cap} tours de correction atteint, revue toujours bloquante` };
      }
      if (reviewRuns <= cap) return { kind: "run", phase: "review", fix: false };
      return { kind: "blocked", reason: `verdict de revue illisible après ${cap + 1} passes` };
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


/** Contenu du contrat d'un worktree, `""` s'il est absent ou illisible. */
export function readContractText(worktree: string): string {
  try {
    return fs.readFileSync(contractPathFor(worktree), "utf8");
  } catch {
    return "";
  }
}
