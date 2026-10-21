// `main.ts --add-repo <url>` : déclare un dépôt sans éditer la configuration à la
// main. Le clone nu est fait par le service (sa clé SSH), l'accès en écriture est
// éprouvé à blanc, les commandes de test sont devinées depuis les manifestes de la
// branche principale, puis l'entrée est écrite dans config.json.
//
// Codes de sortie (lus par harness.sh, qui guide la clé de déploiement) :
//   0 ajouté (ou déjà là) · 3 lecture refusée · 4 écriture refusée · 1 autre échec.
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessConfig } from "./config.ts";
import type { Git } from "./git.ts";


export type TestPlan = { touched: string; full: string; testImage: string | null };

/** Les commandes de test d'un dépôt, d'après les fichiers à la racine de sa branche principale. */
export function detectTests(files: readonly string[]): TestPlan {
  const has = (name: string) => files.includes(name);
  if (has("package.json")) {
    const runner = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    return { touched: `${runner} test -- {files}`, full: `${runner} test`, testImage: null };
  }
  if (has("Cargo.toml")) return { touched: "cargo test", full: "cargo test", testImage: "docker.io/library/rust:1-bookworm" };
  if (has("go.mod")) return { touched: "go test ./...", full: "go test ./...", testImage: "docker.io/library/golang:1-bookworm" };
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    return { touched: "python -m pytest {files}", full: "python -m pytest", testImage: "docker.io/library/python:3-bookworm" };
  }
  // Rien de reconnu : les tests passent toujours, la revue lit le code.
  return { touched: "true {files}", full: "true", testImage: null };
}


/** Le nom d'un dépôt d'après son URL : `git@github.com:moi/mon-produit.git` → `mon-produit`. */
export function repoName(url: string): string {
  return (url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "").replace(/\.git$/, "");
}


export type AddResult = { code: 0 | 1 | 3 | 4; message: string };

export async function addRepo(
  configFile: string,
  config: HarnessConfig,
  git: Git,
  url: string,
  name = repoName(url),
): Promise<AddResult> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return { code: 1, message: `nom de dépôt invalide : « ${name} » (passe --name)` };
  const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as { repos?: Record<string, unknown>[] };
  const repos = (raw.repos ?? []).filter(repo => repo.name !== "mon-produit");
  if (repos.some(repo => repo.name === name)) return { code: 0, message: `${name} est déjà déclaré` };

  const reposRoot = path.dirname(config.dataDir);
  const clone = path.join(reposRoot, "repos", name);
  if (!fs.existsSync(clone)) {
    const read = await git.raw(reposRoot, ["ls-remote", "--heads", url]);
    if (read.code !== 0) return { code: 3, message: `lecture refusée sur ${url} : ${read.stderr.trim().split("\n")[0] ?? ""}` };
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    const cloned = await git.raw(reposRoot, ["clone", "--quiet", "--bare", url, clone]);
    if (cloned.code !== 0) return { code: 1, message: `clone impossible : ${cloned.stderr.trim()}` };
  }
  const head = await git.raw(clone, ["symbolic-ref", "--short", "HEAD"]);
  const mainBranch = head.code === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : "main";
  const write = await git.raw(clone, ["push", "--dry-run", "--porcelain", "origin", `refs/heads/${mainBranch}:refs/heads/omp-harness-check`]);
  if (write.code !== 0) return { code: 4, message: `écriture refusée sur ${url} : ${write.stderr.trim().split("\n")[0] ?? ""}` };

  const listed = await git.raw(clone, ["ls-tree", "--name-only", mainBranch]);
  const plan = detectTests(listed.code === 0 ? listed.stdout.split("\n").filter(Boolean) : []);
  repos.push({
    name,
    path: clone,
    mainBranch,
    tests: { touched: plan.touched, full: plan.full },
    ...(plan.testImage ? { testImage: plan.testImage } : {}),
    merge: "local",
    remote: "origin",
  });
  fs.writeFileSync(configFile, `${JSON.stringify({ ...raw, repos }, null, 2)}\n`);
  return { code: 0, message: `${name} ajouté — tests : « ${plan.full} »${plan.testImage ? ` dans ${plan.testImage}` : ""}` };
}
