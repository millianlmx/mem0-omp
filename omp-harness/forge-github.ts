// La forge GitHub : `gh` dans le clone, sous le compte GitHub du dépôt (policy.ts
// `ghEnv`) s'il en déclare un, sinon la connexion (ou `GH_TOKEN`) du service.
//
// Les PR suivent le clone (`gh` lit son distant) ; les issues et les labels visent le
// dépôt `owner/name` du distant (`--repo`).
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
import { failure, githubSlug, record, remoteLocation, textOf, urlIn } from "./forge.ts";
import { ghEnv } from "./policy.ts";
import type { Exec, ProcResult } from "./proc.ts";

/** Les gestes de PR attendent la forge plus longtemps que les lectures d'issues. */
const PR_TIMEOUT_MS = 120_000;
const ISSUE_TIMEOUT_MS = 60_000;
/** `gh` rend du JSON : la FIN seule (ce que garde `exec` au-delà) serait illisible. */
const JSON_MAX_BYTES = 8 * 1024 * 1024;
/** Les champs d'une issue listée, et ceux d'une issue lue en entier. */
const ISSUE_FIELDS = "number,title,url,labels,author,createdAt";

function login(value: unknown): string | null {
  const name = record(value).login;
  return typeof name === "string" ? name : null;
}

function issueOf(raw: unknown): Issue {
  const value = record(raw);
  if (!Number.isInteger(value.number) || typeof value.title !== "string")
    throw new HarnessError(502, "gh : issue illisible");
  return {
    number: value.number as number,
    title: value.title,
    url: textOf(value.url),
    labels: Array.isArray(value.labels)
      ? value.labels.flatMap((label) => {
          const name = record(label).name;
          return typeof name === "string" ? [name] : [];
        })
      : [],
    author: login(value.author),
    createdAt: textOf(value.createdAt),
  };
}

/** L'état d'une PR dans la sortie de `gh pr view --json state,mergedAt` ; `null` si illisible. */
function prState(stdout: string): ChangeState | null {
  try {
    const parsed = record(JSON.parse(stdout));
    if (typeof parsed.mergedAt === "string" && parsed.mergedAt !== "") return "MERGED";
    const state = parsed.state;
    return state === "MERGED" || state === "CLOSED" || state === "OPEN" ? state : null;
  } catch {
    return null;
  }
}

export class GitHubForge implements Forge {
  readonly kind = "github" as const;
  readonly name = "GitHub";
  readonly project: string | null;
  readonly #repo: RepoConfig;
  readonly #remote: string;
  readonly #exec: Exec;
  readonly #env: Record<string, string | undefined>;

  /**
   * `explicit` : `forge: "github"` déclaré — un distant sous un alias SSH (`github-perso:moi/x`)
   * donne alors son `owner/name` ; sans déclaration, seul github.com en est un.
   */
  constructor(
    repo: RepoConfig,
    remote: { remote: string; url: string | null; explicit: boolean },
    exec: Exec,
    env: Record<string, string | undefined>,
  ) {
    this.#repo = repo;
    this.#remote = remote.remote;
    this.#exec = exec;
    this.#env = env;
    const url = remote.url;
    const aliased = url !== null && remote.explicit ? remoteLocation(url) : null;
    this.project =
      (url === null ? null : githubSlug(url)) ?? (aliased?.path.split("/").length === 2 ? aliased.path : null);
  }

  /** `gh` dans le clone, sous le compte du dépôt (ghEnv lève si son jeton manque). */
  #run(args: string[], timeoutMs: number, maxBytes?: number): Promise<ProcResult> {
    const env = ghEnv(this.#repo, this.#env);
    return this.#exec("gh", args, {
      cwd: this.#repo.path,
      timeoutMs,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(env ? { env } : {}),
    });
  }

  /** Un geste d'issue ou de label : sa sortie, ou une erreur 502 qui dit quoi faire. */
  async #issueCall(args: string[]): Promise<string> {
    const result = await this.#run(args, ISSUE_TIMEOUT_MS, JSON_MAX_BYTES);
    if (result.code !== 0)
      throw new HarnessError(
        502,
        `gh ${args.slice(0, 2).join(" ")} : ${failure(result)} (le service est-il connecté à GitHub ? \`gh auth login\`)`,
      );
    return result.stdout;
  }

  async #json(args: string[]): Promise<unknown> {
    const stdout = await this.#issueCall(args);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new HarnessError(502, `gh ${args.slice(0, 2).join(" ")} : réponse illisible`);
    }
  }

  /** `owner/name` du dépôt GitHub : les issues et les labels le visent. */
  #slug(): string {
    if (this.project === null)
      throw new HarnessError(409, `le remote ${this.#remote} du dépôt ${this.#repo.name} n'est pas un dépôt GitHub`);
    return this.project;
  }

  async auth(): Promise<ForgeAuth> {
    const gh = this.#repo.gh;
    const result = await this.#run(["auth", "status"], 30_000).catch(() => null);
    return {
      ok: result !== null && result.code === 0,
      detail:
        result?.code === 0 ? (gh ? "authentifié (compte du dépôt)" : "authentifié") : "gh absent ou non authentifié",
      fix: gh?.configDir
        ? `sudo -u omp-harness -H env GH_CONFIG_DIR=${gh.configDir} gh auth login`
        : "sudo -u omp-harness -H gh auth login",
    };
  }

  async openChange(change: ChangeRequest, known: string | null): Promise<string | null> {
    const created = await this.#run(
      ["pr", "create", "-B", change.base, "-H", change.head, "-t", change.title, "-b", change.body],
      PR_TIMEOUT_MS,
    );
    // Une PR existe déjà pour la branche (merge relancé) : gh le dit, avec son URL.
    const url = urlIn(created.stdout) ?? urlIn(created.stderr) ?? known;
    if (created.code !== 0 && url === null)
      throw new HarnessError(502, `gh pr create : ${created.stderr.trim().slice(0, 300)}`);
    return url;
  }

  async autoMerge(head: string, message: SquashMessage | null): Promise<void> {
    const merge = await this.#run(
      [
        "pr",
        "merge",
        head,
        "--squash",
        "--auto",
        "--delete-branch",
        ...(message ? ["--subject", message.subject, "--body", message.body] : []),
      ],
      PR_TIMEOUT_MS,
    );
    if (merge.code !== 0)
      throw new HarnessError(502, `gh pr merge --auto refusé : ${merge.stderr.trim().slice(0, 300)}`);
  }

  async changeState(head: string): Promise<ChangeState | null> {
    const view = await this.#run(["pr", "view", head, "--json", "state,mergedAt"], PR_TIMEOUT_MS);
    return view.code === 0 ? prState(view.stdout) : null;
  }

  async issues(query: IssueQuery): Promise<Issue[]> {
    const args = ["issue", "list", "--repo", this.#slug(), "--state", query.state, "--limit", String(query.limit)];
    if (query.label) args.push("--label", query.label);
    args.push("--json", query.withBody ? `${ISSUE_FIELDS},body` : ISSUE_FIELDS);
    const raw = await this.#json(args);
    if (!Array.isArray(raw)) throw new HarnessError(502, "gh issue list : une liste est attendue");
    return raw.map((entry) =>
      query.withBody ? { ...issueOf(entry), body: textOf(record(entry).body) } : issueOf(entry),
    );
  }

  async issue(number: number): Promise<IssueDetail> {
    const raw = record(
      await this.#json([
        "issue",
        "view",
        String(number),
        "--repo",
        this.#slug(),
        "--json",
        `${ISSUE_FIELDS},body,state,comments`,
      ]),
    );
    const comments: IssueComment[] = Array.isArray(raw.comments)
      ? raw.comments.map((comment) => {
          const value = record(comment);
          return { author: login(value.author), body: textOf(value.body), createdAt: textOf(value.createdAt) };
        })
      : [];
    return { ...issueOf(raw), body: textOf(raw.body), state: textOf(raw.state), comments };
  }

  async comment(number: number, body: string): Promise<void> {
    await this.#issueCall(["issue", "comment", String(number), "--repo", this.#slug(), "--body", body]);
  }

  async close(number: number, comment?: string): Promise<void> {
    await this.#issueCall([
      "issue",
      "close",
      String(number),
      "--repo",
      this.#slug(),
      ...(comment ? ["--comment", comment] : []),
    ]);
  }

  async reopen(number: number, comment?: string): Promise<void> {
    await this.#issueCall([
      "issue",
      "reopen",
      String(number),
      "--repo",
      this.#slug(),
      ...(comment ? ["--comment", comment] : []),
    ]);
  }

  async createIssue(input: { title: string; body: string; labels: readonly string[] }): Promise<{
    number: number;
    url: string;
  }> {
    const out = await this.#issueCall([
      "issue",
      "create",
      "--repo",
      this.#slug(),
      "--title",
      input.title,
      "--body",
      input.body,
      ...input.labels.flatMap((label) => ["--label", label]),
    ]);
    const url = urlIn(out) ?? "";
    const number = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
    if (!Number.isInteger(number)) throw new HarnessError(502, "gh issue create : URL d'issue illisible");
    return { number, url };
  }

  async labels(): Promise<string[]> {
    const raw = await this.#json(["label", "list", "--repo", this.#slug(), "--limit", "500", "--json", "name"]);
    return Array.isArray(raw)
      ? raw.flatMap((label) => (typeof record(label).name === "string" ? [String(record(label).name)] : []))
      : [];
  }

  async createLabel(name: string, options: { color: string; description: string }): Promise<void> {
    await this.#issueCall([
      "label",
      "create",
      name,
      "--repo",
      this.#slug(),
      "--color",
      options.color,
      "--description",
      options.description,
    ]);
  }
}
