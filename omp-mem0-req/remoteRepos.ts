// Les DÉPÔTS CONNUS de l'API distante (S-3) : portage de `KnownProjects.roots` et de
// `RemoteActions.knownRepos` (omp-console/Sources/OMPConsole/ProjectChooser/KnownProjects.swift,
// Remote/RemoteActions.swift). Les autres modules de routes (conduite, audits, pull
// requests, documents, `GET /v1/repos`) résolvent un `repoKey` par ici — une seule voie.
import fs from "node:fs";
import path from "node:path";
import { realpathOr } from "./git.ts";
import type { GitRunner } from "./git.ts";
import { readAdoptedRepos, readHandovers, repoIdentity } from "./handover.ts";
import { lotRepoKey } from "./lot.ts";
import type { RemoteContext } from "./remoteContext.ts";
import type { MachineKind } from "./serviceState.ts";

/** `<path>/.git` existe, dossier OU fichier (un worktree lié porte un FICHIER) — `LaunchRepo.isGitRoot`. */
function isGitRoot(root: string): boolean {
  if (root === "") return false;
  return fs.existsSync(path.join(root, ".git"));
}

/**
 * Les racines des lots ∪ les racines des projets du magasin ∪ les dépôts ADOPTÉS par
 * une bascule (`repos.json`, S-5), `realpath`ées, filtrées
 * par la règle « racine git », dédupliquées puis triées par ordre croissant.
 */
export function knownRepoRoots(ctx: Pick<RemoteContext, "stateDir" | "store">): string[] {
  const snapshot = ctx.store.snapshot();
  const roots = new Set<string>();
  for (const lot of snapshot.lots.lots) if (lot.repoRoot !== "") roots.add(realpathOr(lot.repoRoot));
  for (const project of snapshot.projects.projects) if (project.repoRoot !== "") roots.add(realpathOr(project.repoRoot));
  for (const repo of readAdoptedRepos(ctx.stateDir)) if (repo.repoRoot !== "") roots.add(realpathOr(repo.repoRoot));
  return [...roots].filter(isGitRoot).sort();
}

/** La racine du dépôt connu dont la clé est `repoKey` ; `null` si aucun (`unknownRepository`). */
export function resolveRepoRoot(ctx: Pick<RemoteContext, "stateDir" | "store">, repoKey: string): string | null {
  return knownRepoRoots(ctx).find(root => lotRepoKey(root) === repoKey) ?? null;
}

/** La bascule d'un dépôt (S-5) : son identifiant, la machine cible et son état. */
export type RemoteRepoHandover = { id: string; to: MachineKind; state: "frozen" | "done" };

/** Un dépôt connu de la coque (`RemoteRepoRow`) : sa clé, son chemin réel, son nom, son identité GitHub et sa bascule (absents quand inconnus). */
export type RemoteRepoRow = {
  repoKey: string;
  repoRoot: string;
  name: string;
  identity?: string;
  handover?: RemoteRepoHandover;
};

/** `git` par l'exécuteur du contexte : jamais une exception, `code: null` quand git manque ou dépasse le délai. */
function gitRunner(ctx: Pick<RemoteContext, "exec">): GitRunner {
  return async (args, cwd, timeoutMs) => {
    const res = await ctx.exec("git", args, { cwd, timeoutMs: timeoutMs ?? 10_000 });
    return { code: res.code ?? -1, stdout: res.stdout, stderr: res.stderr };
  };
}

/** `RemoteActions.knownRepos` : une ligne par dépôt connu, avec son identité (`origin`, sinon celle de `repos.json`) et sa bascule. */
export async function repoRows(ctx: Pick<RemoteContext, "stateDir" | "store" | "exec">): Promise<RemoteRepoRow[]> {
  const runGit = gitRunner(ctx);
  const adopted = readAdoptedRepos(ctx.stateDir);
  const handovers = readHandovers(ctx.stateDir);
  return Promise.all(
    knownRepoRoots(ctx).map(async root => {
      const repoKey = lotRepoKey(root);
      const identity =
        (await repoIdentity(root, runGit)) ?? adopted.find(repo => realpathOr(repo.repoRoot) === root)?.identity ?? null;
      const handover = handovers[repoKey];
      const row: RemoteRepoRow = { repoKey, repoRoot: root, name: path.basename(root) };
      if (identity !== null) row.identity = identity;
      if (handover !== undefined) row.handover = { id: handover.id, to: handover.to, state: handover.state };
      return row;
    }),
  );
}
