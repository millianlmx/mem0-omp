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
//
// Les gestes qui écrivent l'index ou HEAD d'un worktree (commit, reset, rebase, revert,
// merge, worktree add/remove) passent un par un, dans une file par worktree : les
// outils hôtes d'un runner tournent en parallèle (deux `decision` d'un même tour), et
// la fin d'étape, la boucle humaine ou le merge écrivent dans le même worktree. Un
// verrou `*.lock` tenu par un autre git est attendu (`LOCK_WAIT_MS`) ; plus vieux que
// `STALE_LOCK_MS`, c'est le reste d'un git tué (SIGKILL au bout de `GIT_TIMEOUT_MS`,
// arrêt du service) : retiré, journalisé, et le geste repart.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Exec, ProcResult } from "./proc.ts";
import { parseCheckpointTrailer } from "./decisions.ts";

export type GitIdentity = { authorName: string; authorEmail: string };

/** Un fichier changé : `added`/`removed` valent `null` pour un binaire. */
export type FileChange = { path: string; status: string; added: number | null; removed: number | null };

/** Le dossier des artefacts d'étape dans un worktree : exclu de git, ingéré par le service. */
export const ARTIFACTS_DIR = ".harness";

/** Forcé sur chaque appel : aucun programme tiers ne part d'une config ou d'un hook. */
const HARDENING = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "protocol.ext.allow=never",
];

/** Le délai de tout git du service : au-delà, SIGKILL (proc.ts), et son verrou reste derrière lui. */
const GIT_TIMEOUT_MS = 120_000;

/** L'attente d'un verrou tenu par un git vivant, avant d'échouer. */
export const LOCK_WAIT_MS = 10_000;

/** Un verrou plus vieux n'a plus de git vivant derrière lui : bien au-delà de `GIT_TIMEOUT_MS`. */
export const STALE_LOCK_MS = 5 * 60_000;

/** La pause entre deux essais sur un verrou : doublée à chaque essai, plafonnée. */
const LOCK_PAUSE_MS = 50;
const LOCK_PAUSE_MAX_MS = 1000;

/**
 * Le verrou qu'un git a trouvé pris (`Unable to create '/….lock': File exists`), ou
 * `null`. git écrit le chemin absolu ; un message traduit n'a pas « File exists » :
 * le verrou encore là le dit.
 */
function heldLock(stderr: string): string | null {
  const lock = /'(\/[^'\n]+\.lock)'/.exec(stderr)?.[1];
  if (lock === undefined) return null;
  return /File exists/.test(stderr) || fs.existsSync(lock) ? lock : null;
}

/** Ce que les tests remplacent : l'horloge et la pause des essais sur un verrou, le journal. */
export type GitOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

/** Un rebase ou une fusion : la nouvelle HEAD, ou les fichiers en conflit (geste abandonné). */
type Moved = { ok: true; head: string } | { ok: false; conflicts: string[] };

/** Un revert de plage : son commit, ou les fichiers en conflit (geste abandonné). */
type Reverted = { ok: true; sha: string } | { ok: false; conflicts: string[] };

export class GitError extends Error {
  readonly result: ProcResult;
  constructor(args: string[], result: ProcResult, detail: string | null = null) {
    super(
      `git ${args.join(" ")} : ${detail ? `${detail} — ` : ""}${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    );
    this.result = result;
  }
}

/**
 * Les fichiers hors « code » pour le compte du diff en mode `code` : tests, docs,
 * changelog, manifestes et verrous (`test/**`, `**\/*.test.*`, `**\/Tests/**`, `**\/*.md`,
 * `CHANGELOG*`, `package.json`, `*.lock`).
 */
export function isNonCode(file: string): boolean {
  const parts = file.split("/");
  const name = parts[parts.length - 1] ?? file;
  if (parts[0] === "test" && parts.length > 1) return true;
  if (parts.slice(0, -1).includes("Tests")) return true;
  if (/\.test\.[^/]+$/.test(name)) return true;
  if (/\.md$/i.test(name)) return true;
  if (/^CHANGELOG/.test(name)) return true;
  if (name === "package.json") return true;
  if (/\.lock$/.test(name)) return true;
  return false;
}

export class Git {
  readonly #exec: Exec;
  readonly #identity: GitIdentity;
  /** Worktree (chemin résolu) → son gitdir, lu côté clone au moment où on le reconnaît. */
  readonly #worktrees = new Map<string, string>();
  /** Worktree → la fin de sa file de gestes en écriture. */
  readonly #queues = new Map<string, Promise<void>>();
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (line: string) => void;

  constructor(exec: Exec, identity: GitIdentity, options: GitOptions = {}) {
    this.#exec = exec;
    this.#identity = identity;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#log = options.log ?? ((line) => console.error(`[omp-harness] ${line}`));
  }

  #env(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    // GIT_SSH_COMMAND vient de l'environnement du SERVICE (l'image en conteneurs) :
    // jamais d'un dépôt, dont la config reste neutralisée par HARDENING.
    for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "GIT_SSH_COMMAND"]) {
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
      // `status` (isDirty) ne prend pas le verrou de l'index au passage. `diff`, qui l'ignore, ne le
      // prend qu'en le trouvant libre : un geste en écriture qui le croise l'attend (`#rawLocked`).
      GIT_OPTIONAL_LOCKS: "0",
      ...extra,
    };
  }

  /** git brut : l'issue telle quelle, sans lever. */
  raw(cwd: string, args: string[], env: Record<string, string> = {}): Promise<ProcResult> {
    const gitDir = this.#worktrees.get(path.resolve(cwd));
    const located = gitDir ? ["--git-dir", gitDir, "--work-tree", cwd] : [];
    return this.#exec("git", [...HARDENING, ...located, ...args], {
      cwd,
      env: this.#env(env),
      timeoutMs: GIT_TIMEOUT_MS,
    });
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

  /**
   * `act` seul sur `worktree` : ses gestes en écriture passent un par un, dans l'ordre
   * d'appel. La file est prise dès l'appel (avant tout `await`) : deux décisions
   * numérotées dans l'ordre committent dans l'ordre.
   */
  async #exclusive<T>(worktree: string, act: () => Promise<T>): Promise<T> {
    // Le gitdir côté clone une fois le worktree reconnu : deux écritures du même chemin n'ont qu'une file.
    const key = this.#worktrees.get(path.resolve(worktree)) ?? path.resolve(worktree);
    const before = this.#queues.get(key) ?? Promise.resolve();
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => done);
    this.#queues.set(key, tail);
    try {
      await before;
      return await act();
    } finally {
      release();
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    }
  }

  /**
   * Un git en écriture : un verrou tenu par un autre git est attendu (pause croissante,
   * `LOCK_WAIT_MS` au plus) ; un verrou périmé est retiré, une fois par verrou. Rend la
   * dernière issue, sans lever.
   */
  async #rawLocked(cwd: string, args: string[]): Promise<ProcResult> {
    const start = this.#now();
    const cleared = new Set<string>();
    let pause = LOCK_PAUSE_MS;
    for (;;) {
      const result = await this.raw(cwd, args);
      const lock = result.code === 0 ? null : heldLock(result.stderr);
      if (lock === null) return result;
      if (!cleared.has(lock) && this.#clearStale(lock)) {
        cleared.add(lock);
        continue;
      }
      const left = LOCK_WAIT_MS - (this.#now() - start);
      if (left <= 0) return result;
      await this.#sleep(Math.min(pause, left));
      pause = Math.min(pause * 2, LOCK_PAUSE_MAX_MS);
    }
  }

  /** `#rawLocked` qui DOIT réussir ; un verrou encore tenu au bout de l'attente est nommé dans l'erreur. */
  async #runLocked(cwd: string, args: string[]): Promise<string> {
    const result = await this.#rawLocked(cwd, args);
    if (result.code === 0) return result.stdout.replace(/\n$/, "");
    const lock = heldLock(result.stderr);
    throw new GitError(
      args,
      result,
      lock ? `verrou ${lock} tenu par un autre git au-delà de ${LOCK_WAIT_MS / 1000} s` : null,
    );
  }

  /** Retire `lock` s'il est plus vieux que `STALE_LOCK_MS` ; `false` s'il est frais ou déjà parti. */
  #clearStale(lock: string): boolean {
    let age: number;
    try {
      age = this.#now() - fs.statSync(lock).mtimeMs;
    } catch {
      return false;
    }
    if (age <= STALE_LOCK_MS) return false;
    fs.rmSync(lock, { force: true });
    this.#log(
      `verrou git périmé retiré (${Math.round(age / 1000)} s, aucun git du service ne dure plus de ${GIT_TIMEOUT_MS / 1000} s) : ${lock}`,
    );
    return true;
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
    if (!current.split("\n").includes(line))
      fs.appendFileSync(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`);
  }

  /** Crée le worktree du run sur une branche neuve partant de `base` (`null` : HEAD détachée, l'audit). Idempotent. */
  async addWorktree(repo: string, worktree: string, branch: string | null, base: string): Promise<void> {
    if (fs.existsSync(path.join(worktree, ".git"))) {
      await this.trustWorktree(repo, worktree);
      return;
    }
    await this.#exclusive(worktree, async () => {
      // Le parent n'est pas inscriptible par le groupe : un runner ne peut ni renommer ni remplacer son worktree.
      fs.mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o2750 });
      fs.chmodSync(path.dirname(worktree), 0o2750);
      const exists =
        branch !== null && (await this.raw(repo, ["rev-parse", "--verify", `refs/heads/${branch}`])).code === 0;
      const args =
        branch === null
          ? ["worktree", "add", "--detach", worktree, base]
          : exists
            ? ["worktree", "add", worktree, branch]
            : ["worktree", "add", "-b", branch, worktree, base];
      await this.#runLocked(repo, args);
    });
    await this.excludeArtifacts(repo);
    await this.trustWorktree(repo, worktree);
  }

  removeWorktree(repo: string, worktree: string, branch: string | null): Promise<void> {
    return this.#exclusive(worktree, async () => {
      await this.#rawLocked(repo, ["worktree", "remove", "--force", worktree]);
      this.#worktrees.delete(path.resolve(worktree));
      if (branch) await this.#rawLocked(repo, ["branch", "-D", branch]);
    });
  }

  /**
   * Le tree hash du RÉPERTOIRE DE TRAVAIL (fichiers non commités et non suivis
   * compris, ignorés exclus) — calculé dans un index temporaire, sans toucher
   * l'index du worktree. C'est la clé du cache des résultats heavy.
   *
   * L'index du worktree est COPIÉ dans l'index temporaire avant `add -A` : git y
   * retrouve les stat des fichiers inchangés et ne relit pas tout l'arbre.
   */
  async workingTreeHash(worktree: string): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-harness-index-"));
    const index = path.join(dir, "index");
    try {
      const env = { GIT_INDEX_FILE: index };
      const gitDir = this.#worktrees.get(path.resolve(worktree));
      const current = gitDir ? path.join(gitDir, "index") : null;
      if (current && fs.existsSync(current)) fs.copyFileSync(current, index);
      else await this.run(worktree, ["read-tree", "HEAD"], env);
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
  commitAll(worktree: string, message: string): Promise<string> {
    return this.#exclusive(worktree, () => this.#commitAll(worktree, message));
  }

  async #commitAll(worktree: string, message: string): Promise<string> {
    await this.#runLocked(worktree, ["add", "-A", "--", "."]);
    await this.#runLocked(worktree, ["commit", "--allow-empty", "--no-verify", "-q", "-m", message]);
    return this.revParse(worktree, "HEAD");
  }

  /** Retour dur à un checkpoint : fichiers suivis ET non suivis (hors ignorés et artefacts). */
  resetTo(worktree: string, sha: string): Promise<void> {
    return this.#exclusive(worktree, () => this.#resetTo(worktree, sha));
  }

  async #resetTo(worktree: string, sha: string): Promise<void> {
    await this.#runLocked(worktree, ["reset", "--hard", "-q", sha]);
    await this.run(worktree, ["clean", "-fdq", "-e", `/${ARTIFACTS_DIR}/`]);
  }

  /** Rebase sur `onto` ; un conflit est abandonné et ses fichiers rendus. */
  rebase(worktree: string, onto: string): Promise<Moved> {
    return this.#exclusive(worktree, async (): Promise<Moved> => {
      const result = await this.#rawLocked(worktree, ["rebase", "-q", onto]);
      if (result.code === 0) return { ok: true, head: await this.revParse(worktree, "HEAD") };
      const conflicts = (await this.raw(worktree, ["diff", "--name-only", "--diff-filter=U"])).stdout
        .split("\n")
        .filter(Boolean);
      await this.#rawLocked(worktree, ["rebase", "--abort"]);
      return { ok: false, conflicts };
    });
  }

  /**
   * Revert des commits de `fromExclusive..toInclusive` (du plus récent au plus ancien,
   * sans commit intermédiaire ; les commits vides sont sautés), puis UN commit. Un
   * conflit est abandonné, l'arbre rendu propre, et ses fichiers rendus.
   */
  revertRange(worktree: string, fromExclusive: string, toInclusive: string): Promise<Reverted> {
    return this.#exclusive(worktree, async (): Promise<Reverted> => {
      const shas = (await this.run(worktree, ["rev-list", `${fromExclusive}..${toInclusive}`]))
        .split("\n")
        .filter(Boolean);
      const head = await this.revParse(worktree, "HEAD");
      for (const sha of shas) {
        // Un checkpoint vide (commit --allow-empty) n'a rien à défaire : git refuse de le reverter.
        if ((await this.raw(worktree, ["diff-tree", "--quiet", "--root", sha])).code === 0) continue;
        const result = await this.#rawLocked(worktree, ["revert", "--no-commit", "--no-edit", sha]);
        if (result.code === 0) continue;
        const conflicts = await this.unmergedFiles(worktree);
        await this.#rawLocked(worktree, ["revert", "--abort"]);
        await this.#resetTo(worktree, head);
        return { ok: false, conflicts };
      }
      await this.#runLocked(worktree, [
        "commit",
        "--allow-empty",
        "--no-verify",
        "-q",
        "-m",
        `revert: ${fromExclusive.slice(0, 7)}..${(await this.revParse(worktree, toInclusive)).slice(0, 7)}`,
      ]);
      return { ok: true, sha: await this.revParse(worktree, "HEAD") };
    });
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
  mergeNoCommit(worktree: string, ref: string): Promise<void> {
    return this.#exclusive(worktree, () => this.#mergeNoCommit(worktree, ref));
  }

  async #mergeNoCommit(worktree: string, ref: string): Promise<void> {
    await this.#rawLocked(worktree, ["merge", "-q", "--no-ff", "--no-commit", ref]);
  }

  /**
   * Fusionne `ref` dans la branche du worktree et commite la fusion ; un conflit est
   * abandonné, l'arbre rendu tel qu'avant, et ses fichiers rendus. Déjà à jour : rien.
   */
  mergeCommit(worktree: string, ref: string, message: string): Promise<Moved> {
    return this.#exclusive(worktree, async (): Promise<Moved> => {
      await this.#mergeNoCommit(worktree, ref);
      const conflicts = await this.unmergedFiles(worktree);
      if (conflicts.length > 0) {
        await this.#rawLocked(worktree, ["merge", "--abort"]);
        return { ok: false, conflicts };
      }
      if (await this.mergeInProgress(worktree)) await this.#commitAll(worktree, message);
      return { ok: true, head: await this.revParse(worktree, "HEAD") };
    });
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

  /**
   * Lignes ajoutées + supprimées de `base` au répertoire de travail (binaires exclus).
   * Mode `code` : sans tests, docs, changelog ni manifestes — le seuil d'auto-merge
   * mesure ce qui porte du risque.
   */
  async diffLines(worktree: string, base: string, mode: "all" | "code"): Promise<number> {
    const out = await this.run(worktree, ["diff", "--numstat", base]);
    let total = 0;
    for (const line of out.split("\n")) {
      const [added, deleted, file] = line.split("\t");
      if (added === undefined || deleted === undefined || added === "-") continue;
      if (mode === "code" && file !== undefined && isNonCode(file)) continue;
      total += Number(added) + Number(deleted);
    }
    return total;
  }

  /** Les fichiers touchés depuis `base` (commités ou non, non suivis compris). */
  async touchedFiles(worktree: string, base: string): Promise<string[]> {
    const changed = (await this.run(worktree, ["diff", "--name-only", base])).split("\n");
    const untracked = (await this.run(worktree, ["ls-files", "--others", "--exclude-standard"])).split("\n");
    return [
      ...new Set([...changed, ...untracked].filter((file) => file !== "" && !file.startsWith(`${ARTIFACTS_DIR}/`))),
    ].sort();
  }

  /**
   * Les fichiers changés de `from` à `to` (`to` absent : le répertoire de travail, non
   * suivis compris) : lignes ajoutées et retirées (`null` pour un binaire) et état —
   * `A` ajouté, `M` modifié, `D` supprimé, `R` renommé. Les artefacts d'étape n'y sont pas.
   */
  async changes(cwd: string, from: string, to: string | null = null): Promise<FileChange[]> {
    const range = to === null ? [from] : [from, to];
    const status = new Map<string, string>();
    for (const line of (await this.run(cwd, ["diff", "--name-status", "--no-renames", ...range])).split("\n")) {
      const [code, file] = line.split("\t");
      if (code && file) status.set(file, code.charAt(0));
    }
    const changes: FileChange[] = [];
    for (const line of (await this.run(cwd, ["diff", "--numstat", "--no-renames", ...range])).split("\n")) {
      const [added, removed, file] = line.split("\t");
      if (added === undefined || removed === undefined || !file || file.startsWith(`${ARTIFACTS_DIR}/`)) continue;
      changes.push({
        path: file,
        status: status.get(file) ?? "M",
        added: added === "-" ? null : Number(added),
        removed: removed === "-" ? null : Number(removed),
      });
    }
    if (to === null) {
      for (const file of (await this.run(cwd, ["ls-files", "--others", "--exclude-standard"])).split("\n")) {
        if (file === "" || file.startsWith(`${ARTIFACTS_DIR}/`)) continue;
        let lines: number | null = null;
        try {
          const content = fs.readFileSync(path.join(cwd, file));
          // Un binaire (octet nul) n'a pas de lignes ; sinon, les sauts de ligne, plus une dernière ligne sans saut.
          const text = content.toString("utf8");
          lines = content.includes(0) ? null : text.split("\n").length - (text.endsWith("\n") || text === "" ? 1 : 0);
        } catch {
          lines = null;
        }
        changes.push({ path: file, status: "A", added: lines, removed: 0 });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Les différences unifiées d'un fichier de `from` à `to` (`to` absent : le répertoire de travail, un fichier non suivi compris). */
  async fileDiff(cwd: string, from: string, to: string | null, file: string): Promise<string> {
    const range = to === null ? [from] : [from, to];
    const tracked = await this.raw(cwd, ["diff", "--no-color", "--no-ext-diff", ...range, "--", file]);
    if (tracked.code !== 0) throw new GitError(["diff", ...range, "--", file], tracked);
    if (tracked.stdout !== "" || to !== null) return tracked.stdout;
    // Un fichier non suivi : comparé à rien (git sort en 1 quand il y a des différences).
    const untracked = await this.raw(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-index",
      "--",
      "/dev/null",
      file,
    ]);
    return untracked.code === 0 || untracked.code === 1 ? untracked.stdout : "";
  }

  /**
   * Merge squash de `branch` sur `main`, sans checkout : un commit de l'arbre de la
   * branche avec `main` pour parent, posé par `update-ref` en compare-and-swap. Un
   * `main` qui a bougé entre-temps fait échouer le geste — jamais un écrasement.
   */
  async squashMerge(
    repo: string,
    branch: string,
    main: string,
    expectedMain: string,
    message: string,
  ): Promise<string> {
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
