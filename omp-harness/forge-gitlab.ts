// La forge GitLab : `glab` dans le clone, sur l'instance du dépôt (`gitlab.host`, sinon
// l'hôte de son distant), sous son compte (policy.ts `glabEnv` : `gitlab.tokenEnv` ou
// `gitlab.configDir`), sinon celui du service.
//
// Chaque appel vise le projet par son URL complète (`-R https://hôte/groupe/projet`) :
// un GitLab auto-hébergé n'est jamais confondu avec gitlab.com. Les PR sont des MR
// (`glab mr`), fusionnées en squash par l'auto-merge de GitLab (« quand le pipeline
// réussit »). Les commentaires d'une issue sont ses notes non système, lues par l'API.
import type { RepoConfig } from "./config.ts";
import { HarnessError } from "./errors.ts";
import type {
  ChangeRequest,
  ChangeState,
  Forge,
  ForgeAuth,
  Issue,
  IssueComment,
  IssueDetail,
  IssueQuery,
  SquashMessage,
} from "./forge.ts";
import { failure, record, remoteLocation, textOf } from "./forge.ts";
import { glabEnv } from "./policy.ts";
import type { Exec, ProcResult } from "./proc.ts";

const PR_TIMEOUT_MS = 120_000;
const ISSUE_TIMEOUT_MS = 60_000;
const JSON_MAX_BYTES = 8 * 1024 * 1024;
/** GitLab pagine à 100 au plus. */
const PAGE_MAX = 100;

/**
 * L'URL d'une MR (ou d'une issue) dans une sortie de `glab`, et son numéro. Les issues
 * récentes de GitLab sont des « work items » : leur URL dit `/-/work_items/<n>`.
 */
function gitlabUrl(output: string, kind: "merge_requests" | "issues"): { url: string; number: number } | null {
  const path = kind === "issues" ? "(?:issues|work_items)" : kind;
  const match = new RegExp(`https?://\\S+/-/${path}/(\\d+)`).exec(output);
  return match ? { url: match[0], number: Number(match[1]) } : null;
}

function username(value: unknown): string | null {
  const name = record(value).username;
  return typeof name === "string" ? name : null;
}

function issueOf(raw: unknown): Issue {
  const value = record(raw);
  if (!Number.isInteger(value.iid) || typeof value.title !== "string")
    throw new HarnessError(502, "glab : issue illisible");
  return {
    number: value.iid as number,
    title: value.title,
    url: textOf(value.web_url),
    labels: Array.isArray(value.labels) ? value.labels.filter((label) => typeof label === "string") : [],
    author: username(value.author),
    createdAt: textOf(value.created_at),
  };
}

/** L'état d'une MR (`opened`, `locked`, `merged`, `closed`) dans les mots communs aux forges. */
function mrState(raw: unknown): ChangeState | null {
  const value = record(raw);
  if (typeof value.merged_at === "string" && value.merged_at !== "") return "MERGED";
  if (value.state === "merged") return "MERGED";
  if (value.state === "closed") return "CLOSED";
  return value.state === "opened" || value.state === "locked" ? "OPEN" : null;
}

export class GitLabForge implements Forge {
  readonly kind = "gitlab" as const;
  readonly name = "GitLab";
  readonly project: string | null;
  readonly #repo: RepoConfig;
  readonly #remote: string;
  /** L'instance en URL (`https://gitlab.client.example`), `null` si ni la configuration ni le distant ne la donnent. */
  readonly #hostUrl: string | null;
  readonly #exec: Exec;
  readonly #env: Record<string, string | undefined>;

  constructor(
    repo: RepoConfig,
    remote: { remote: string; url: string | null },
    exec: Exec,
    env: Record<string, string | undefined>,
  ) {
    this.#repo = repo;
    this.#remote = remote.remote;
    this.#exec = exec;
    this.#env = env;
    const at = remote.url === null ? null : remoteLocation(remote.url);
    this.project = at?.path ?? null;
    const host = repo.gitlab?.host ?? at?.host ?? null;
    this.#hostUrl = host === null ? null : /^https?:\/\//.test(host) ? host.replace(/\/+$/, "") : `https://${host}`;
  }

  /** L'hôte de l'instance (`gitlab.client.example[:port]`), pour `--hostname`. */
  #hostname(): string {
    if (this.#hostUrl === null)
      throw new HarnessError(
        409,
        `le dépôt ${this.#repo.name} n'a pas d'instance GitLab : déclare \`gitlab.host\` (le remote ${this.#remote} ne la donne pas)`,
      );
    return new URL(this.#hostUrl).host;
  }

  /** Le projet en URL complète, pour `-R`. */
  #target(): string {
    this.#hostname();
    if (this.project === null)
      throw new HarnessError(409, `le remote ${this.#remote} du dépôt ${this.#repo.name} n'est pas un projet GitLab`);
    return `${this.#hostUrl}/${this.project}`;
  }

  #run(args: string[], timeoutMs: number, maxBytes?: number): Promise<ProcResult> {
    const env = glabEnv(this.#repo, this.#hostUrl ?? "", this.#env);
    return this.#exec("glab", args, {
      cwd: this.#repo.path,
      timeoutMs,
      env,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    });
  }

  /** Ce qui rend `glab` authentifié : le jeton du dépôt, sa connexion propre, ou celle du service. */
  #login(): string {
    const gitlab = this.#repo.gitlab;
    const host = this.#hostUrl === null ? "<hôte>" : new URL(this.#hostUrl).host;
    if (gitlab?.tokenEnv !== undefined) return `un jeton GitLab (scope api) de ${host} dans ${gitlab.tokenEnv}`;
    const dir = gitlab?.configDir !== undefined ? `env GLAB_CONFIG_DIR=${gitlab.configDir} ` : "";
    return `\`${dir}glab auth login --hostname ${host}\``;
  }

  async #call(args: string[], timeoutMs = ISSUE_TIMEOUT_MS): Promise<string> {
    const result = await this.#run(args, timeoutMs, JSON_MAX_BYTES);
    if (result.code !== 0)
      throw new HarnessError(
        502,
        `glab ${args.slice(0, 2).join(" ")} : ${failure(result)} (le service est-il connecté à GitLab ? ${this.#login()})`,
      );
    return result.stdout;
  }

  async #json(args: string[], timeoutMs = ISSUE_TIMEOUT_MS): Promise<unknown> {
    const stdout = await this.#call(args, timeoutMs);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new HarnessError(502, `glab ${args.slice(0, 2).join(" ")} : réponse illisible`);
    }
  }

  /** `glab api` sur `projects/<chemin encodé>/<resource>` de l'instance (ce que `glab issue` ne rend pas en JSON). */
  #api(resource: string): Promise<unknown> {
    this.#target();
    const project = encodeURIComponent(this.project as string);
    return this.#json(["api", "--hostname", this.#hostname(), `projects/${project}/${resource}`]);
  }

  async auth(): Promise<ForgeAuth> {
    if (this.#hostUrl === null)
      return {
        ok: false,
        detail: `aucune instance GitLab : le remote ${this.#remote} ne la donne pas`,
        fix: "Déclare `gitlab.host` dans l'entrée du dépôt.",
      };
    const hostname = this.#hostname();
    const result = await this.#run(["auth", "status", "--hostname", hostname], 30_000).catch(() => null);
    const own = this.#repo.gitlab?.tokenEnv !== undefined || this.#repo.gitlab?.configDir !== undefined;
    return {
      ok: result !== null && result.code === 0,
      detail:
        result?.code === 0
          ? `authentifié sur ${hostname}${own ? " (compte du dépôt)" : ""}`
          : `glab absent ou non authentifié sur ${hostname}`,
      fix:
        this.#repo.gitlab?.tokenEnv !== undefined
          ? `Pose ${this.#login()}.`
          : `sudo -u omp-harness -H ${this.#login().replaceAll("`", "")}`,
    };
  }

  async #openMr(head: string): Promise<{ url: string | null; state: ChangeState | null } | null> {
    const view = await this.#run(["mr", "view", head, "-R", this.#target(), "--output", "json"], PR_TIMEOUT_MS);
    if (view.code !== 0) return null;
    try {
      const raw = record(JSON.parse(view.stdout));
      return { url: typeof raw.web_url === "string" ? raw.web_url : null, state: mrState(raw) };
    } catch {
      return null;
    }
  }

  async openChange(change: ChangeRequest, known: string | null): Promise<string | null> {
    const created = await this.#run(
      [
        "mr",
        "create",
        "-R",
        this.#target(),
        "--source-branch",
        change.head,
        "--target-branch",
        change.base,
        "--title",
        change.title,
        "--description",
        change.body,
        "--yes",
      ],
      PR_TIMEOUT_MS,
    );
    const url =
      (gitlabUrl(created.stdout, "merge_requests") ?? gitlabUrl(created.stderr, "merge_requests"))?.url ?? null;
    if (created.code === 0) return url ?? known;
    // Une MR existe déjà pour la branche (merge relancé) : glab ne rend pas son URL, la vue la donne.
    const existing = url ?? (await this.#openMr(change.head))?.url ?? known;
    if (existing === null) throw new HarnessError(502, `glab mr create : ${failure(created)}`);
    return existing;
  }

  async autoMerge(head: string, message: SquashMessage | null): Promise<void> {
    const squash = message ? (message.body === "" ? message.subject : `${message.subject}\n\n${message.body}`) : null;
    const merge = await this.#run(
      [
        "mr",
        "merge",
        head,
        "-R",
        this.#target(),
        "--squash",
        "--auto-merge",
        "--remove-source-branch",
        "--yes",
        ...(squash === null ? [] : ["--squash-message", squash]),
      ],
      PR_TIMEOUT_MS,
    );
    if (merge.code !== 0) throw new HarnessError(502, `glab mr merge --auto-merge refusé : ${failure(merge)}`);
  }

  async changeState(head: string): Promise<ChangeState | null> {
    return (await this.#openMr(head))?.state ?? null;
  }

  async issues(query: IssueQuery): Promise<Issue[]> {
    const limit = Math.max(query.limit, 1);
    const perPage = Math.min(limit, PAGE_MAX);
    const found: Issue[] = [];
    // GitLab rend au plus 100 issues par page : les suivantes se demandent par `--page`.
    for (let page = 1; found.length < limit; page++) {
      const args = ["issue", "list", "-R", this.#target(), "--per-page", String(perPage)];
      if (page > 1) args.push("--page", String(page));
      if (query.state === "all") args.push("--all");
      if (query.label) args.push("--label", query.label);
      args.push("--output", "json");
      const raw = await this.#json(args);
      if (!Array.isArray(raw)) throw new HarnessError(502, "glab issue list : une liste est attendue");
      for (const entry of raw)
        found.push(query.withBody ? { ...issueOf(entry), body: textOf(record(entry).description) } : issueOf(entry));
      if (raw.length < perPage) break;
    }
    return found.slice(0, limit);
  }

  async issue(number: number): Promise<IssueDetail> {
    const raw = record(await this.#json(["issue", "view", String(number), "-R", this.#target(), "--output", "json"]));
    const notes = await this.#api(`issues/${number}/notes?sort=asc&order_by=created_at&per_page=${PAGE_MAX}`);
    const comments: IssueComment[] = Array.isArray(notes)
      ? notes.flatMap((note) => {
          const value = record(note);
          // Les notes système (« a ajouté le label … ») ne sont pas des commentaires.
          if (value.system === true) return [];
          return [{ author: username(value.author), body: textOf(value.body), createdAt: textOf(value.created_at) }];
        })
      : [];
    const state = raw.state === "opened" ? "OPEN" : raw.state === "closed" ? "CLOSED" : textOf(raw.state);
    return { ...issueOf(raw), body: textOf(raw.description), state, comments };
  }

  async comment(number: number, body: string): Promise<void> {
    await this.#call(["issue", "note", String(number), "-R", this.#target(), "--message", body]);
  }

  async close(number: number, comment?: string): Promise<void> {
    if (comment) await this.comment(number, comment);
    await this.#call(["issue", "close", String(number), "-R", this.#target()]);
  }

  async reopen(number: number, comment?: string): Promise<void> {
    await this.#call(["issue", "reopen", String(number), "-R", this.#target()]);
    if (comment) await this.comment(number, comment);
  }

  async createIssue(input: { title: string; body: string; labels: readonly string[] }): Promise<{
    number: number;
    url: string;
  }> {
    const out = await this.#call([
      "issue",
      "create",
      "-R",
      this.#target(),
      "--title",
      input.title,
      "--description",
      input.body,
      ...input.labels.flatMap((label) => ["--label", label]),
      "--yes",
    ]);
    const created = gitlabUrl(out, "issues");
    if (created === null) throw new HarnessError(502, "glab issue create : URL d'issue illisible");
    return created;
  }

  async labels(): Promise<string[]> {
    const raw = await this.#api(`labels?per_page=${PAGE_MAX}`);
    return Array.isArray(raw)
      ? raw.flatMap((label) => {
          const name = record(label).name;
          return typeof name === "string" ? [name] : [];
        })
      : [];
  }

  async createLabel(name: string, options: { color: string; description: string }): Promise<void> {
    await this.#call([
      "label",
      "create",
      "-R",
      this.#target(),
      "--name",
      name,
      "--color",
      `#${options.color}`,
      "--description",
      options.description,
    ]);
  }
}
