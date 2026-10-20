// Les gestes git du harness : un worktree par run, tree hash du répertoire de travail,
// commits WIP de décision (checkpoints), retour à un checkpoint, rebase sur main,
// merge squash par update-ref (compare-and-swap) et taille du diff.
//
// Un worktree est INSCRIPTIBLE par les runners et les jobs heavy : son fichier
// `.git` peut avoir été repointé vers un gitdir piégé (hooks, fsmonitor, filtres).
// Le service ne le lit donc jamais : chaque commande dans un worktree passe un
// `--git-dir` explicite, retrouvé dans le dossier d'administration du CLONE (que le
// groupe ne peut pas écrire, `core.sharedRepository=0640`), et chaque appel force
// hooks et fsmonitor à rien.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Exec, ProcResult } from "./proc.ts";
import { parseCheckpointTrailer } from "./decisions.ts";


export type GitIdentity = { authorName: string; authorEmail: string };

/** Le dossier des artefacts d'étape dans un worktree : exclu de git, ingéré par le service. */
export const ARTIFACTS_DIR = ".harness";


/** Forcé sur chaque appel : aucun programme tiers ne part d'une config ou d'un hook. */
const HARDENING = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "-c", "protocol.ext.allow=never"];


export class GitError extends Error {
  readonly result: ProcResult;
  constructor(args: string[], result: ProcResult) {
    super(`git ${args.join(" ")} : ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    this.result = result;
  }
}


export class Git {
  readonly #exec: Exec;
  readonly #identity: GitIdentity;
  /** Worktree (chemin résolu) → son gitdir, lu côté clone au moment où on le reconnaît. */
  readonly #worktrees = new Map<string, string>();

  constructor(exec: Exec, identity: GitIdentity) {
    this.#exec = exec;
    this.#identity = identity;
  }

  #env(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "LANG", "TMPDIR"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return {
      ...env,
      GIT_AUTHOR_NAME: this.#identity.authorName,
      GIT_AUTHOR_EMAIL: this.#identity.authorEmail,
      GIT_COMMITTER_NAME: this.#identity.authorName,
      GIT_COMMITTER_EMAIL: this.#identity.authorEmail,
      GIT_TERMINAL_PROMPT: "0",
      ...extra,
    };
  }

  /** git brut : l'issue telle quelle, sans lever. */
  raw(cwd: string, args: string[], env: Record<string, string> = {}): Promise<ProcResult> {
    const gitDir = this.#worktrees.get(path.resolve(cwd));
    const located = gitDir ? ["--git-dir", gitDir, "--work-tree", cwd] : [];
    return this.#exec("git", [...HARDENING, ...located, ...args], { cwd, env: this.#env(env), timeoutMs: 120_000 });
  }

  /**
   * Reconnaît `worktree` comme un worktree de `repo` : son gitdir est cherché dans
   * `<clone>/worktrees/*` (le fichier `gitdir` y pointe sur `<worktree>/.git`), jamais
   * lu dans le worktree. Un worktree que le clone ne connaît pas est refusé.
   */
  async trustWorktree(repo: string, worktree: string): Promise<void> {
    const admin = path.join(await this.commonDir(repo), "worktrees");
    const target = path.join(fs.realpathSync(worktree), ".git");
    for (const id of fs.existsSync(admin) ? fs.readdirSync(admin) : []) {
      let pointed: string;
      try {
        pointed = path.resolve(path.join(admin, id), fs.readFileSync(path.join(admin, id, "gitdir"), "utf8").trim());
      } catch {
        continue;
      }
      let real = pointed;
      try {
        real = path.join(fs.realpathSync(path.dirname(pointed)), ".git");
      } catch {
        /* worktree disparu : ce n'est pas le nôtre */
      }
      if (real === target) {
        this.#worktrees.set(path.resolve(worktree), path.join(admin, id));
        this.#worktrees.set(fs.realpathSync(worktree), path.join(admin, id));
        return;
      }
    }
    throw new Error(`worktree inconnu du clone ${repo} : ${worktree}`);
  }

  /**
   * Le gitdir du clone n'est inscriptible que par le service : `core.sharedRepository`
   * fixe les droits de ce que git y crée (0640), et l'existant perd l'écriture de groupe.
   */
  async protectRepo(repo: string): Promise<void> {
    await this.run(repo, ["config", "core.sharedRepository", "0640"]);
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        const mode = fs.statSync(full).mode;
        if (mode & 0o020) fs.chmodSync(full, mode & 0o7757);
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(await this.commonDir(repo));
  }

  /** git qui DOIT réussir : la sortie standard, sans le saut de ligne final. */
  async run(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
    const result = await this.raw(cwd, args, env);
    if (result.code !== 0) throw new GitError(args, result);
    return result.stdout.replace(/\n$/, "");
  }

  revParse(cwd: string, ref: string): Promise<string> {
    return this.run(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  }

  /** Le dossier git commun (celui du clone, partagé par tous ses worktrees). */
  async commonDir(cwd: string): Promise<string> {
    const dir = await this.run(cwd, ["rev-parse", "--git-common-dir"]);
    return path.resolve(cwd, dir);
  }

  /** Exclut le dossier des artefacts pour TOUS les worktrees du clone (info/exclude est commun). */
  async excludeArtifacts(repo: string): Promise<void> {
    const file = path.join(await this.commonDir(repo), "info", "exclude");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const line = `/${ARTIFACTS_DIR}/`;
    if (!current.split("\n").includes(line)) fs.appendFileSync(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`);
  }

  /** Crée le worktree du run sur une branche neuve, partant de `base`. Idempotent. */
  async addWorktree(repo: string, worktree: string, branch: string, base: string): Promise<void> {
    if (fs.existsSync(path.join(worktree, ".git"))) {
      await this.trustWorktree(repo, worktree);
      return;
    }
    // Le parent n'est pas inscriptible par le groupe : un runner ne peut ni renommer ni remplacer son worktree.
    fs.mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o2750 });
    fs.chmodSync(path.dirname(worktree), 0o2750);
    const exists = (await this.raw(repo, ["rev-parse", "--verify", `refs/heads/${branch}`])).code === 0;
    const args = exists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, base];
    await this.run(repo, args);
    await this.excludeArtifacts(repo);
    await this.trustWorktree(repo, worktree);
  }

  async removeWorktree(repo: string, worktree: string, branch: string | null): Promise<void> {
    await this.raw(repo, ["worktree", "remove", "--force", worktree]);
    this.#worktrees.delete(path.resolve(worktree));
    if (branch) await this.raw(repo, ["branch", "-D", branch]);
  }

  /**
   * Le tree hash du RÉPERTOIRE DE TRAVAIL (fichiers non commités et non suivis
   * compris, ignorés exclus) — calculé dans un index temporaire, sans toucher
   * l'index du worktree. C'est la clé du cache des résultats heavy.
   */
  async workingTreeHash(worktree: string): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-harness-index-"));
    const index = path.join(dir, "index");
    try {
      const env = { GIT_INDEX_FILE: index };
      await this.run(worktree, ["read-tree", "HEAD"], env);
      await this.run(worktree, ["add", "-A", "--", "."], env);
      return await this.run(worktree, ["write-tree"], env);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Le répertoire de travail diffère-t-il de HEAD ? */
  async isDirty(worktree: string): Promise<boolean> {
    return (await this.run(worktree, ["status", "--porcelain"])) !== "";
  }

  /** Commit WIP de tout le répertoire de travail (vide permis : un checkpoint existe toujours). */
  async commitAll(worktree: string, message: string): Promise<string> {
    await this.run(worktree, ["add", "-A", "--", "."]);
    await this.run(worktree, ["commit", "--allow-empty", "--no-verify", "-q", "-m", message]);
    return this.revParse(worktree, "HEAD");
  }

  /** Retour dur à un checkpoint : fichiers suivis ET non suivis (hors ignorés et artefacts). */
  async resetTo(worktree: string, sha: string): Promise<void> {
    await this.run(worktree, ["reset", "--hard", "-q", sha]);
    await this.run(worktree, ["clean", "-fdq", "-e", `/${ARTIFACTS_DIR}/`]);
  }

  /** Rebase sur `onto` ; un conflit est abandonné et ses fichiers rendus. */
  async rebase(worktree: string, onto: string): Promise<{ ok: true; head: string } | { ok: false; conflicts: string[] }> {
    const result = await this.raw(worktree, ["rebase", "-q", onto]);
    if (result.code === 0) return { ok: true, head: await this.revParse(worktree, "HEAD") };
    const conflicts = (await this.raw(worktree, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
    await this.raw(worktree, ["rebase", "--abort"]);
    return { ok: false, conflicts };
  }

  /** Une fusion est-elle en cours (MERGE_HEAD) ? */
  async mergeInProgress(worktree: string): Promise<boolean> {
    return (await this.raw(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
  }

  /** Les fichiers encore en conflit dans l'index. */
  async unmergedFiles(worktree: string): Promise<string[]> {
    return (await this.run(worktree, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
  }

  /** Fusionne `ref` sans commit : les conflits restent dans les fichiers, à résoudre sans git. */
  async mergeNoCommit(worktree: string, ref: string): Promise<void> {
    await this.raw(worktree, ["merge", "-q", "--no-ff", "--no-commit", ref]);
  }

  /** Les checkpoints de `base..HEAD`, par numéro de décision (remappage après rebase). */
  async checkpoints(worktree: string, base: string, runId: string): Promise<Map<number, string>> {
    const log = await this.run(worktree, ["log", "--format=%H%x00%B%x01", `${base}..HEAD`]);
    const map = new Map<number, string>();
    for (const entry of log.split("\x01")) {
      const [sha, message] = entry.replace(/^\n/, "").split("\x00");
      if (!sha || message === undefined) continue;
      const trailer = parseCheckpointTrailer(message);
      // `git log` va du plus récent au plus ancien : le premier vu est le checkpoint courant.
      if (trailer && trailer.runId === runId && !map.has(trailer.seq)) map.set(trailer.seq, sha);
    }
    return map;
  }

  /** Lignes ajoutées + supprimées de `base` au répertoire de travail (binaires exclus). */
  async diffLines(worktree: string, base: string): Promise<number> {
    const out = await this.run(worktree, ["diff", "--numstat", base]);
    let total = 0;
    for (const line of out.split("\n")) {
      const [added, deleted] = line.split("\t");
      if (added === undefined || deleted === undefined || added === "-") continue;
      total += Number(added) + Number(deleted);
    }
    return total;
  }

  /** Les fichiers touchés depuis `base` (commités ou non, non suivis compris). */
  async touchedFiles(worktree: string, base: string): Promise<string[]> {
    const changed = (await this.run(worktree, ["diff", "--name-only", base])).split("\n");
    const untracked = (await this.run(worktree, ["ls-files", "--others", "--exclude-standard"])).split("\n");
    return [...new Set([...changed, ...untracked].filter(file => file !== "" && !file.startsWith(`${ARTIFACTS_DIR}/`)))].sort();
  }

  /**
   * Merge squash de `branch` sur `main`, sans checkout : un commit de l'arbre de la
   * branche avec `main` pour parent, posé par `update-ref` en compare-and-swap. Un
   * `main` qui a bougé entre-temps fait échouer le geste — jamais un écrasement.
   */
  async squashMerge(repo: string, branch: string, main: string, expectedMain: string, message: string): Promise<string> {
    // L'arbre de la branche REMPLACE celui de main : il doit contenir main, sinon le
    // squash effacerait en silence ce qui a été mergé depuis la base du run.
    if ((await this.raw(repo, ["merge-base", "--is-ancestor", expectedMain, branch])).code !== 0) {
      throw new Error(`${branch} n'est pas rebasée sur ${main} (${expectedMain.slice(0, 12)}) : merge refusé`);
    }
    const tree = await this.run(repo, ["rev-parse", `${branch}^{tree}`]);
    const commit = await this.run(repo, ["commit-tree", tree, "-p", expectedMain, "-m", message]);
    await this.run(repo, ["update-ref", `refs/heads/${main}`, commit, expectedMain]);
    return commit;
  }

  /** Tous les fichiers suivis de `ref` (planificateur : modules connus). */
  async listFiles(repo: string, ref: string): Promise<string[]> {
    return (await this.run(repo, ["ls-tree", "-r", "--name-only", ref])).split("\n").filter(Boolean);
  }
}
