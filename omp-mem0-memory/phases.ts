// Phases : registry persistant (~/.omp/agent/phases.json) et consignes déléguées en fin de phase.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PHASE_THRESHOLD, RECALL_LIMIT } from "./config.ts";
import { mem0, memoryLine, rows } from "./mem0Client.ts";
import { projectId } from "./state.ts";
import type { SessionState } from "./state.ts";
import { writeFileAtomic } from "./write.ts";

// ---------------------------------------------------------------------------
// Phases — rôles nommés qu'on active sur une session (/set-phase). À la fin d'une
// phase (l'agent a rendu la main → session_stop), on cherche en mémoire les
// instructions de la phase et on les DÉLÈGUE à l'agent : l'extension n'édite
// jamais un fichier elle-même. Registry global (partagé entre projets), persisté.
// ---------------------------------------------------------------------------

export const PHASES_FILE = path.join(os.homedir(), ".omp", "agent", "phases.json");

export type PhaseEntry = { brief: string };

export function loadPhases(): Map<string, PhaseEntry> {
  try {
    const raw = fs.readFileSync(PHASES_FILE, "utf8");
    const entries: Record<string, PhaseEntry> = JSON.parse(raw);
    return new Map(Object.entries(entries));
  } catch {
    return new Map();
  }
}

// Dernier message d'échec d'écriture, lu par les handlers de commande : `ctx`
// n'entre pas dans `mutatePhases`, qui reste sans UI.
export let phaseWriteError = "";

/**
 * Relit le disque, applique `mutate`, écrit atomiquement. Rend false si l'écriture a échoué.
 * Relire AVANT de muter est ce qui préserve les entrées écrites par une autre session OMP
 * depuis le chargement du module : `phases` en mémoire ne peut pas servir de base d'écriture,
 * le fichier est GLOBAL (tous les projets, tous les process), le dernier écrivain écraserait
 * les autres.
 */
export function mutatePhases(mutate: (registry: Map<string, PhaseEntry>) => void): boolean {
  const registry = loadPhases();
  mutate(registry);
  phases = registry;
  const obj: Record<string, PhaseEntry> = {};
  for (const [name, entry] of registry) obj[name] = entry;
  try {
    writeFileAtomic(PHASES_FILE, JSON.stringify(obj, null, 2));
    phaseWriteError = "";
    return true;
  } catch (err) {
    // Le registre en mémoire porte l'état fusionné, le disque est resté intact :
    // c'est au handler de commande de le dire, une fois, à l'utilisateur.
    phaseWriteError = (err as Error).message;
    return false;
  }
}

export const DEFAULT_PHASES: string[] = ["release", "version-bump", "deploy", "review"];

// Chargé une fois au chargement du module ; muté par /add-phase, /remove-phase, /set-phase --default.
export let phases = loadPhases();

// Repère un souvenir qui porte une instruction à exécuter. C'est l'agent qui
// juge et agit ; ce test ne fait que décider quels souvenirs lui présenter.
export const EXECUTION_KEYWORDS = ["version", "bump", "commit", "release"];

export const EXECUTABLE_RE = /\b(MUST|EXECUTE|TODO|ACTION|DO|RUN)\s*[:：。]/i;

/**
 * Consignes de fin de phase : cherche en mémoire les instructions de la phase
 * active et les rend à l'agent, qui les applique avec ses propres outils.
 * Rend null quand il n'y a rien à dire (aucune phase active, phase inconnue, ou
 * déjà déclenchée pour cette session). Pose `phaseTriggered` dès qu'elle agit :
 * une seule fois, même si la recherche échoue ou ne rend rien.
 */
export async function phaseStopContext(st: SessionState, cwd: string): Promise<string | null> {
  const phaseName = st.currentPhase;
  if (!phaseName || !phases.has(phaseName) || st.phaseTriggered) return null;
  st.phaseTriggered = true;
  const scope = projectId(cwd);
  const brief = phases.get(phaseName)?.brief ?? "";
  try {
    // Requête = intention de la phase (nom + brief). On NE concatène PAS les
    // mots-clés fixes dans le texte embeddé : padder la requête détruit sa
    // pertinence (mesuré). Les mots-clés servent de tri lexical en aval.
    const query = brief ? `${phaseName} ${brief}` : phaseName;
    const found = rows(await mem0.search(query, scope, RECALL_LIMIT, PHASE_THRESHOLD)).map(memoryLine);
    const executable = found
      .filter((t) => EXECUTABLE_RE.test(t))
      .map((t) => ({ t, rank: EXECUTION_KEYWORDS.some((k) => t.toLowerCase().includes(k)) ? 1 : 0 }))
      .sort((a, b) => b.rank - a.rank)
      .map((x) => x.t);

    return executable.length
      ? `[mem0 phase "${phaseName}"] Phase terminée. Instructions trouvées en mémoire à appliquer maintenant, ` +
          `avec tes propres outils (édition, bash/git) et sous les gardes d'approbation :\n` +
          executable.map((t, i) => `${i + 1}. ${t}`).join("\n") +
          `\n\nApplique celles qui sont pertinentes puis rends la main. Si une instruction ne colle pas ` +
          `à l'état réel du dépôt, dis-le au lieu de l'exécuter.`
      : `[mem0 phase "${phaseName}"] Phase terminée, aucune instruction exécutable en mémoire pour cette phase. ` +
          `Si elle doit déclencher des actions (bump de version, commit, release, déploiement), enregistre-les ` +
          `avec mem0_add sous forme d'instruction, par exemple : « ${phaseName} — RUN: incrémenter la version ` +
          `dans package.json et marketplace.json puis commiter ». Elles seront présentées à la prochaine fin de phase.`;
  } catch (err) {
    return `[mem0 phase "${phaseName}"] Recherche mémoire indisponible : ${(err as Error).message}. Aucune action automatique ce tour.`;
  }
}
