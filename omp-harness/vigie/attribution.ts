// À qui revient un signal de la vigie, et ce que sa correction peut réserver.
//
// Une trace relevée dans un runner — son unité ou son conteneur `omp-runner-<run>-<étape>`
// (runner.ts `runnerUnit`) — vient de l'agent d'un run : sa mémoire de 1 Go, ses tests,
// ses commandes. Elle revient à ce run, jamais au harness : ni issue ni correction. Un run
// tué faute de mémoire (code 137) l'est aussi : le harness le traite déjà lui-même
// (machine.ts `isRunnerOom` : relance avec consigne, puis attente humaine).
//
// Une correction de la vigie ne réserve que les FICHIERS que son incident nomme (piles,
// chemins, fichiers du tri), jamais un dossier entier : `omp-harness` ou `test/harness`
// chevaucheraient tous les runs créés après elle, admis dans l'ordre de création.
import { isRunnerOom } from "../machine.ts";
import type { Signal } from "./fingerprint.ts";

const RUNNER_UNIT = /\bomp-runner-([a-z0-9]+)(?:-\d+)?/i;

/** Le runner qu'un texte nomme (`omp-runner-<run>-<étape>`) et l'id de son run, ou `null`. */
export function runnerUnitOf(text: string): { unit: string; runId: string } | null {
  const match = RUNNER_UNIT.exec(text);
  return match ? { unit: match[0], runId: match[1] as string } : null;
}

/** La trace d'un runner et le run qu'elle désigne (`null` : celui du signal), ou `null` : un signal du harness. */
export type RunnerTrace = { unit: string; runId: string | null };

/**
 * Un signal venu d'un runner : sa source ou son emplacement nomme une unité de runner, ou
 * c'est l'échec d'un run dont le runner a été tué faute de mémoire. Le message seul ne
 * suffit pas : le harness nomme aussi les runners qu'il lance et arrête.
 */
export function runnerTraceOf(signal: Signal & { runId?: string | null }): RunnerTrace | null {
  for (const text of [signal.source, signal.location]) {
    const named = runnerUnitOf(text);
    if (named) return named;
  }
  if (signal.source === "run" && isRunnerOom(signal.message)) return { unit: "runner", runId: signal.runId ?? null };
  return null;
}

/** Un chemin de fichier dans un texte : `dossier/fichier.ext`, éventuellement absolu ou suivi de `:ligne`. */
const FILE_PATH = /(?:[\w@+-]+\/)*[\w@+-]+\.[A-Za-z]\w*/g;

/**
 * Les fichiers suivis du dépôt que nomment des textes, triés : un chemin exact, sa fin
 * (une pile `/app/omp-harness/x.ts` donne `omp-harness/x.ts`), ou le seul fichier suivi
 * qui finisse par lui (`vigie/desk.ts`). Jamais un dossier.
 */
export function namedFiles(texts: readonly string[], files: readonly string[]): string[] {
  const tracked = new Set(files);
  const found = new Set<string>();
  for (const text of texts) {
    for (const [candidate] of text.matchAll(FILE_PATH)) {
      const parts = candidate.split("/");
      // Les fins de deux segments au moins : `x/README.md` ne désigne pas le README de la racine.
      const tails =
        parts.length === 1 ? [candidate] : parts.slice(0, -1).map((_, start) => parts.slice(start).join("/"));
      const exact = tails.find((tail) => tracked.has(tail));
      if (exact !== undefined) {
        found.add(exact);
        continue;
      }
      const suffixed = files.filter((file) => file.endsWith(`/${candidate}`));
      if (suffixed.length === 1) found.add(suffixed[0] as string);
    }
  }
  return [...found].sort();
}
