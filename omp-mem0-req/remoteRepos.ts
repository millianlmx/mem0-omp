// Les DÉPÔTS CONNUS de l'API distante (S-3) : portage de `KnownProjects.roots` et de
// `RemoteActions.knownRepos` (omp-console/Sources/OMPConsole/ProjectChooser/KnownProjects.swift,
// Remote/RemoteActions.swift). Les autres modules de routes (conduite, audits, pull
// requests, documents, `GET /v1/repos`) résolvent un `repoKey` par ici — une seule voie.
import fs from "node:fs";
import path from "node:path";
import { realpathOr } from "./git.ts";
import { lotRepoKey } from "./lot.ts";
import type { RemoteContext } from "./remoteContext.ts";

/** `<path>/.git` existe, dossier OU fichier (un worktree lié porte un FICHIER) — `LaunchRepo.isGitRoot`. */
function isGitRoot(root: string): boolean {
  if (root === "") return false;
  return fs.existsSync(path.join(root, ".git"));
}

/**
 * Les racines des lots ∪ les racines des projets du magasin, `realpath`ées, filtrées
 * par la règle « racine git », dédupliquées puis triées par ordre croissant.
 */
export function knownRepoRoots(ctx: Pick<RemoteContext, "stateDir" | "store">): string[] {
  const snapshot = ctx.store.snapshot();
  const roots = new Set<string>();
  for (const lot of snapshot.lots.lots) if (lot.repoRoot !== "") roots.add(realpathOr(lot.repoRoot));
  for (const project of snapshot.projects.projects) if (project.repoRoot !== "") roots.add(realpathOr(project.repoRoot));
  return [...roots].filter(isGitRoot).sort();
}

/** La racine du dépôt connu dont la clé est `repoKey` ; `null` si aucun (`unknownRepository`). */
export function resolveRepoRoot(ctx: Pick<RemoteContext, "stateDir" | "store">, repoKey: string): string | null {
  return knownRepoRoots(ctx).find(root => lotRepoKey(root) === repoKey) ?? null;
}

/** Un dépôt connu de la coque (`RemoteRepoRow`) : sa clé, son chemin réel et son nom. */
export type RemoteRepoRow = { repoKey: string; repoRoot: string; name: string };

/** `RemoteActions.knownRepos` : une ligne par dépôt connu. Point d'extension : S-5/BR-4 y ajoutera `identity` et `handover`. */
export function repoRows(ctx: Pick<RemoteContext, "stateDir" | "store">): RemoteRepoRow[] {
  return knownRepoRoots(ctx).map(root => ({ repoKey: lotRepoKey(root), repoRoot: root, name: path.basename(root) }));
}
