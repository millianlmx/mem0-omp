// La scope mem0 d'un dépôt : la MÊME identité de projet que le plugin mémoire.
//
// Le plugin `omp-mem0-memory` nomme un projet d'après son manifeste (package.json,
// pyproject.toml, Cargo.toml, Package.swift, puis un .xcodeproj, puis le dossier).
// Le harness lit les mêmes manifestes — la même table, importée — dans l'arbre de
// `main` du clone (souvent nu, sans fichiers extraits) : souvenirs du Mac, des
// runners et de l'oracle tombent ainsi dans une seule mémoire de projet.
import * as path from "node:path";
import { MANIFESTS } from "../omp-mem0-memory/state.ts";
import type { Git } from "./git.ts";


/** La scope du projet d'après les manifestes de `ref`, sinon le nom du dossier du clone. */
export async function projectScope(git: Git, repo: string, ref: string): Promise<string> {
  for (const [file, extract] of MANIFESTS) {
    const shown = await git.raw(repo, ["show", `${ref}:${file}`]);
    if (shown.code !== 0) continue;
    const name = extract(shown.stdout);
    if (name) return name;
  }
  const top = await git.raw(repo, ["ls-tree", "--name-only", ref]);
  const xcode = top.stdout.split("\n").find(name => name.endsWith(".xcodeproj"));
  if (xcode) return path.basename(xcode, ".xcodeproj");
  // Un clone nu s'appelle souvent `<nom>.git` : le plugin, lui, voit le dossier extrait.
  return path.basename(repo).replace(/\.git$/, "");
}
