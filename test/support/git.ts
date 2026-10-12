// Les dépôts git jetables des tests node : un environnement git isolé de la
// configuration de la machine, et le dépôt minimal (branche main, un commit
// vide) sur lequel les pilotes de lot et les worktrees s'appuient.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : seuls les
// tests l'importent.
import { spawnSync } from "node:child_process";
import { tmpdir } from "./repo.ts";

/**
 * L'environnement des `git` de test : ni configuration système ni globale (pas
 * de hook, de signature ou d'alias de la machine), une identité fixe. Instantané
 * de `process.env` pris au chargement du module.
 */
export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/**
 * Un dépôt git réel dans `<tmp>/<prefix>XXXX` (retiré en fin de fichier) :
 * branche `main` et un commit initial vide, dont les worktrees dépendent. Le
 * préfixe reste visible dans le basename du dépôt, que certains rendus portent.
 */
export function emptyGitRepo(prefix: string): string {
  const root = tmpdir(prefix);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: GIT_ENV, encoding: "utf8" });
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: root, env: GIT_ENV, encoding: "utf8" });
  return root;
}

/** Le runner `git` des pilotes de lot : du vrai git, sans réseau, jamais d'échec levé. */
export const gitRunner = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};
