// La porte de l'intégration continue GitHub (S-9, B-9) : pour une feature d'un dépôt
// conduit par le VPS qui touche du Swift, le VPS ne peut pas compiler — le verdict
// vient de la CI GitHub, lue sur le commit de travail que le pilote pousse à la fin
// de chaque /impl. Ce module porte les briques MÉCANIQUES (détection du Swift,
// commit de travail sans toucher la branche ni l'index, push, lecture des
// check-runs) ; la chaîne et les transitions restent celles du pilote
// (`lotController.ts`, `chain.ts`).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GitResult, GitRunner } from "./git.ts";
import type { CiFailure, FeatureCi } from "./lot.ts";
import { releaseTarget } from "./runs.ts";

/** Période de lecture du verdict tant que la porte est en attente (S-9). */
export const CI_POLL_MS = 60_000;

/** Aucun contrôle GitHub démarré passé ce délai après le push : `blocked`. */
export const CI_NO_CHECK_MS = 15 * 60_000;

/** Aucun verdict passé ce délai après le push : `blocked`. */
export const CI_NO_VERDICT_MS = 120 * 60_000;

/** Le motif du refus de livrer (commande `verdict` `y`) tant que la porte n'est pas verte sur l'arbre courant. */
export const CI_DELIVERY_REFUSAL = "livraison impossible : l’intégration continue GitHub n’est pas verte sur l’arbre courant";

/** Le texte de l'attente de la porte, tel que Mac et iOS l'affichent. */
export const CI_WAIT_TEXT = "Attente de l’intégration continue GitHub";

/** Le motif d'un blocage quand aucun contrôle GitHub n'a démarré dans les 15 minutes. */
export function ciNoCheckReason(branch: string, sha: string): string {
  return `aucune vérification GitHub n’a démarré sur ${branch} (${sha.slice(0, 7)}) en 15 min`;
}

/** Le motif d'un blocage quand la porte reste sans verdict 120 minutes après le push. */
export const CI_NO_VERDICT_REASON = "intégration continue GitHub sans verdict après 120 min";

/** Le motif d'un push de la branche de travail en échec. */
export function ciPushRefusal(detail: string): string {
  return `push de la branche de travail refusé : ${detail}`;
}

/** La ligne ajoutée au prompt d'un `--fix` renvoyé par la porte : les contrôles rouges, nom et lien. */
export function ciBlockersLine(sha: string, failures: readonly CiFailure[]): string {
  return `Bloquant de l’intégration continue GitHub sur ${sha.slice(0, 7)} : ${failures.map((f) => `${f.name} (${f.url})`).join(" ; ")}`;
}


// --- « touche du Swift » ------------------------------------------------------

/**
 * Un chemin touche-t-il le Swift ? `.swift`, un projet ou un espace de travail Xcode
 * (`.xcodeproj/`, `.xcworkspace/`), ou `Package.resolved` (`Package.swift` finit déjà
 * par `.swift`). Les séparateurs sont ceux de git : toujours `/`.
 */
export function pathTouchesSwift(file: string): boolean {
  if (file.endsWith(".swift")) return true;
  if (file.includes(".xcodeproj/") || file.includes(".xcworkspace/")) return true;
  return file === "Package.resolved" || file.endsWith("/Package.resolved");
}

/** Le dernier détail utile d'une commande git en échec. */
function detailOf(res: GitResult): string {
  const lines = (res.stderr.trim() || res.stdout.trim()).split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const last = lines.length > 0 ? (lines[lines.length - 1] as string) : `code ${res.code}`;
  return last.length > 200 ? `${last.slice(0, 199)}…` : last;
}

/**
 * La base du diff d'une feature : le PREMIER commit de la branche (l'entrée la plus
 * ancienne de son journal de références — `worktree add -b` l'écrit), à défaut le
 * sha de base du lot, à défaut `HEAD` (seul le travail non commité compte alors).
 */
async function diffBase(run: GitRunner, worktree: string, branch: string, fallback: string | null): Promise<string> {
  const log = await run(["reflog", "show", "--format=%H", `refs/heads/${branch}`], worktree);
  if (log.code === 0) {
    const shas = log.stdout.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l));
    const oldest = shas[shas.length - 1];
    if (oldest !== undefined) return oldest;
  }
  return fallback ?? "HEAD";
}

/**
 * Les chemins que la feature a touchés depuis sa base : fichiers suivis modifiés
 * (commités ou non, suppressions comprises) + fichiers non suivis non ignorés.
 * Un échec de git rend un texte (jamais une exception).
 */
export async function touchedPaths(
  run: GitRunner,
  input: { worktree: string; branch: string; base?: string | null },
): Promise<string[] | string> {
  const base = await diffBase(run, input.worktree, input.branch, input.base ?? null);
  const tracked = await run(["diff", "--name-only", "--no-renames", "-z", base], input.worktree);
  if (tracked.code !== 0) return `git diff : ${detailOf(tracked)}`;
  const untracked = await run(["ls-files", "--others", "--exclude-standard", "-z"], input.worktree);
  if (untracked.code !== 0) return `git ls-files : ${detailOf(untracked)}`;
  const entries = (out: string): string[] => out.split("\0").filter((entry) => entry !== "");
  return [...entries(tracked.stdout), ...entries(untracked.stdout)];
}


// --- le commit de travail -----------------------------------------------------

/**
 * L'arbre du worktree, tel que `git add -A` le figerait, SANS toucher l'index ni la
 * branche : un index temporaire (`GIT_INDEX_FILE`) amorcé sur HEAD, `add -A`,
 * `write-tree`. Les fichiers suivis mais ignorés restent donc dans l'arbre.
 */
export async function worktreeTree(run: GitRunner, worktree: string): Promise<{ tree: string } | { error: string }> {
  if (!fs.existsSync(worktree)) return { error: "worktree introuvable" };
  const index = path.join(os.tmpdir(), `omp-ci-index-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const seeded = await run(["read-tree", "HEAD"], worktree, undefined, env);
    if (seeded.code !== 0) return { error: `git read-tree : ${detailOf(seeded)}` };
    const added = await run(["add", "-A"], worktree, undefined, env);
    if (added.code !== 0) return { error: `git add : ${detailOf(added)}` };
    const written = await run(["write-tree"], worktree, undefined, env);
    const tree = written.stdout.trim();
    if (written.code !== 0 || tree === "") return { error: `git write-tree : ${detailOf(written)}` };
    return { tree };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** L'identité de repli d'un commit de travail quand git n'en connaît aucune (VPS neuf). */
const FALLBACK_IDENT: Record<string, string> = {
  GIT_AUTHOR_NAME: "omp-pipeline",
  GIT_AUTHOR_EMAIL: "omp-pipeline@localhost",
  GIT_COMMITTER_NAME: "omp-pipeline",
  GIT_COMMITTER_EMAIL: "omp-pipeline@localhost",
};

/** Le commit de travail d'un arbre : fils de HEAD, `wip(<slug>): /impl <n>`. La branche locale ne bouge pas. */
export async function commitWorkTree(
  run: GitRunner,
  input: { worktree: string; slug: string; n: number; tree: string },
): Promise<{ sha: string } | { error: string }> {
  const args = ["commit-tree", input.tree, "-p", "HEAD", "-m", `wip(${input.slug}): /impl ${input.n}`];
  let made = await run(args, input.worktree);
  if (made.code !== 0 && /ident|who you are/i.test(made.stderr)) made = await run(args, input.worktree, undefined, FALLBACK_IDENT);
  const sha = made.stdout.trim();
  if (made.code !== 0 || sha === "") return { error: `git commit-tree : ${detailOf(made)}` };
  return { sha };
}


// --- le push de la branche de travail ----------------------------------------

export type CiPushDeps = {
  run: GitRunner;
  net: GitRunner;
  gh: ((args: string[], cwd: string) => Promise<GitResult>) | undefined;
  now: () => number;
};

/**
 * Fige le worktree dans un commit de travail et le pousse sur `refs/heads/<branche>` du
 * dépôt (`git push --force <URL HTTPS de gh repo view> <sha>:refs/heads/<branche>`).
 * `sameTreeAs` : un arbre identique à celui déjà poussé ne repart pas (`unchanged`).
 * Rend la porte neuve (`pending`) ou le motif de blocage.
 */
export async function pushWorkBranch(
  deps: CiPushDeps,
  input: { worktree: string; branch: string; slug: string; n: number; sameTreeAs?: string | null },
): Promise<{ ci: FeatureCi } | { unchanged: true } | { blocked: string }> {
  const refuse = (detail: string) => ({ blocked: ciPushRefusal(detail) });
  const tree = await worktreeTree(deps.run, input.worktree);
  if ("error" in tree) return refuse(tree.error);
  if (input.sameTreeAs !== undefined && input.sameTreeAs !== null && input.sameTreeAs === tree.tree) return { unchanged: true };
  if (!deps.gh) return refuse("gh introuvable");
  const view = await deps.gh(["repo", "view", "--json", "url,defaultBranchRef"], input.worktree);
  if (view.code !== 0) return refuse(view.code === 127 ? "gh introuvable" : `gh indisponible : ${detailOf(view)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(view.stdout);
  } catch {
    parsed = null;
  }
  const target = releaseTarget(parsed);
  if (!target.pushUrl) return refuse("URL HTTPS du dépôt introuvable (gh repo view)");
  const commit = await commitWorkTree(deps.run, { worktree: input.worktree, slug: input.slug, n: input.n, tree: tree.tree });
  if ("error" in commit) return refuse(commit.error);
  const pushed = await deps.net(["push", "--force", target.pushUrl, `${commit.sha}:refs/heads/${input.branch}`], input.worktree);
  if (pushed.code !== 0) return refuse(detailOf(pushed));
  return { ci: { sha: commit.sha, tree: tree.tree, pushedAt: deps.now(), state: "pending", checkedAt: null, failures: [] } };
}


// --- la lecture du verdict ----------------------------------------------------

/** Conclusions qui rougissent la porte. */
const RED_CONCLUSIONS: Record<string, true> = {
  failure: true,
  cancelled: true,
  timed_out: true,
  action_required: true,
  stale: true,
  startup_failure: true,
};

/** Conclusions qui comptent pour vert (avec au moins un contrôle, tous terminés). */
const GREEN_CONCLUSIONS: Record<string, true> = { success: true, neutral: true, skipped: true };

/**
 * Les valeurs JSON de premier niveau d'un texte. `gh api --paginate` imprime UNE
 * charge par page, collées bout à bout (`{…}{…}`) : ce n'est pas un document JSON.
 */
function topLevelJson(text: string): unknown[] {
  const values: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          values.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* une charge illisible est ignorée : le verdict reste « en attente » */
        }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return values;
}

export type CiReading = { state: FeatureCi["state"]; failures: CiFailure[]; total: number };

/**
 * Le verdict d'une sortie `gh api …/check-runs --paginate` : rouge = au moins un
 * contrôle terminé en échec ; vert = au moins un contrôle et tous terminés en
 * succès, neutre ou ignorés ; sinon en attente. `total` sert au délai « aucun
 * contrôle démarré ».
 */
export function readCheckRuns(stdout: string): CiReading {
  const runs: Array<Record<string, unknown>> = [];
  for (const page of topLevelJson(stdout)) {
    const items = Array.isArray(page)
      ? page
      : page && typeof page === "object" && Array.isArray((page as Record<string, unknown>).check_runs)
        ? ((page as Record<string, unknown>).check_runs as unknown[])
        : [];
    for (const item of items) if (item && typeof item === "object") runs.push(item as Record<string, unknown>);
  }
  const failures: CiFailure[] = [];
  let allGreen = runs.length > 0;
  for (const entry of runs) {
    const completed = entry.status === "completed";
    const conclusion = typeof entry.conclusion === "string" ? entry.conclusion : "";
    if (completed && RED_CONCLUSIONS[conclusion] === true) {
      failures.push({
        name: typeof entry.name === "string" ? entry.name : "",
        url: typeof entry.html_url === "string" ? entry.html_url : "",
      });
    }
    if (!completed || GREEN_CONCLUSIONS[conclusion] !== true) allGreen = false;
  }
  if (failures.length > 0) return { state: "red", failures, total: runs.length };
  return { state: allGreen ? "green" : "pending", failures: [], total: runs.length };
}

/** Lit les contrôles du commit poussé (`gh api` sur le dépôt du worktree) ; un échec rend son détail. */
export async function fetchCiReading(
  gh: (args: string[], cwd: string) => Promise<GitResult>,
  worktree: string,
  sha: string,
): Promise<CiReading | { error: string }> {
  const res = await gh(["api", `repos/{owner}/{repo}/commits/${sha}/check-runs`, "--paginate"], worktree);
  if (res.code !== 0) return { error: res.code === 127 ? "gh introuvable" : `gh api : ${detailOf(res)}` };
  return readCheckRuns(res.stdout);
}
