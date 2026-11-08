// Le commit construit du service : `OMP_HARNESS_COMMIT`, posé par l'image (Dockerfile.harness,
// résolu au build par deploy/container/build-commit) ou par l'environnement du service. Rendu
// par `GET /v1/health` (`commit`) et par le rapport du matin, pour savoir quel code tourne.

/** Un sha git complet (40 hex), en minuscules ; null pour une valeur absente ou illisible, jamais rendue telle quelle. */
export function commitOf(raw: string | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(value) ? value : null;
}

/** Le commit du service, lu une fois au chargement. */
export const HARNESS_COMMIT: string | null = commitOf(process.env.OMP_HARNESS_COMMIT);
