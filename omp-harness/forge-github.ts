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
  CheckConclusion,
  CheckStatus,
  FailedCi,
  FailedLog,
  Forge,
  ForgeAuth,
  ForgeCheck,
  ForgeVisibility,
  Issue,
  IssueComment,
  IssueDetail,
  IssueQuery,
  OpenChange,
  SquashMessage,
} from "./forge.ts";
import {
  failure,
  githubSlug,
  isRedCheck,
  record,
  remoteLocation,
  textOf,
  urlIn,
  usefulLogLines,
  visibilityOf,
} from "./forge.ts";
import { ghEnv } from "./policy.ts";
import type { Exec, ProcResult } from "./proc.ts";

/** Les gestes de PR attendent la forge plus longtemps que les lectures d'issues. */
const PR_TIMEOUT_MS = 120_000;
const ISSUE_TIMEOUT_MS = 60_000;
/** Les logs d'un run CI (`gh run view --log-failed`) : leur fin seule est gardée au-delà. */
const LOG_MAX_BYTES = 4 * 1024 * 1024;
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

/** Le JSON de la sortie d'une CLI réussie, `null` si elle a échoué ou n'est pas du JSON. */
function jsonOf(result: ProcResult): unknown {
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function checkStatus(status: unknown): CheckStatus {
  return status === "completed" ? "completed" : status === "in_progress" ? "running" : "pending";
}

/** `success`, `skipped`, `neutral`, `cancelled` ; tout autre résultat terminé (échec, délai, action requise…) est un échec. */
function checkConclusion(conclusion: unknown): CheckConclusion | null {
  if (typeof conclusion !== "string") return null;
  if (conclusion === "success" || conclusion === "skipped" || conclusion === "neutral" || conclusion === "cancelled")
    return conclusion;
  return "failure";
}

/** Un état de statut de commit (`success`, `failure`, `error`, `pending`) en check. */
function statusCheck(raw: unknown): ForgeCheck | null {
  const value = record(raw);
  const name = textOf(value.context);
  if (name === "") return null;
  const state = value.state;
  const done = state === "success" || state === "failure" || state === "error";
  return {
    name,
    status: done ? "completed" : "pending",
    conclusion: done ? (state === "success" ? "success" : "failure") : null,
    url: textOf(value.target_url) || null,
    required: false,
  };
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

  async openChange(change: ChangeRequest, known: string | null, draft = false): Promise<string | null> {
    const args = ["pr", "create", "-B", change.base, "-H", change.head, "-t", change.title, "-b", change.body];
    if (draft) args.push("--draft");
    const created = await this.#run(args, PR_TIMEOUT_MS);
    // Une PR existe déjà pour la branche (merge relancé) : gh le dit, avec son URL.
    const url = urlIn(created.stdout) ?? urlIn(created.stderr) ?? known;
    if (created.code !== 0 && url === null)
      throw new HarnessError(502, `gh pr create : ${created.stderr.trim().slice(0, 300)}`);
    // Une PR existante, sortie du brouillon par un merge précédent : remise en brouillon (sa fusion automatique tombe).
    if (created.code !== 0 && draft) await this.#run(["pr", "ready", "--undo", change.head], PR_TIMEOUT_MS);
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

  async markReady(head: string): Promise<void> {
    const ready = await this.#run(["pr", "ready", head], PR_TIMEOUT_MS);
    // Une PR qui n'est pas un brouillon : gh le dit (« already ready for review »), le geste est fait.
    if (ready.code !== 0 && !/already/i.test(`${ready.stdout}${ready.stderr}`))
      throw new HarnessError(502, `gh pr ready refusé : ${failure(ready)}`);
  }

  /** Les contextes que la protection de la branche principale (ou un ruleset) exige, `∅` si elle n'en pose aucun. */
  async #requiredContexts(slug: string): Promise<Set<string>> {
    const base = this.#repo.mainBranch;
    const names = new Set<string>();
    const [protection, rules] = await Promise.all([
      this.#run(["api", `repos/${slug}/branches/${base}/protection/required_status_checks`], ISSUE_TIMEOUT_MS),
      this.#run(["api", `repos/${slug}/rules/branches/${base}`], ISSUE_TIMEOUT_MS),
    ]);
    const status = record(jsonOf(protection));
    for (const context of Array.isArray(status.contexts) ? status.contexts : []) names.add(textOf(context));
    for (const check of Array.isArray(status.checks) ? status.checks : []) names.add(textOf(record(check).context));
    const list = jsonOf(rules);
    for (const rule of Array.isArray(list) ? list : []) {
      const required = record(record(rule).parameters).required_status_checks;
      for (const check of Array.isArray(required) ? required : []) names.add(textOf(record(check).context));
    }
    names.delete("");
    return names;
  }

  async checks(head: string): Promise<ForgeCheck[]> {
    const slug = this.#slug();
    const [runs, statuses, required] = await Promise.all([
      this.#json(["api", `repos/${slug}/commits/${head}/check-runs?per_page=100`]),
      this.#json(["api", `repos/${slug}/commits/${head}/status?per_page=100`]),
      this.#requiredContexts(slug),
    ]);
    const found: ForgeCheck[] = [];
    const checkRuns = record(runs).check_runs;
    for (const raw of Array.isArray(checkRuns) ? checkRuns : []) {
      const value = record(raw);
      const name = textOf(value.name);
      if (name === "") continue;
      found.push({
        name,
        status: checkStatus(value.status),
        conclusion: value.status === "completed" ? checkConclusion(value.conclusion) : null,
        url: textOf(value.html_url) || textOf(value.details_url) || null,
        required: required.has(name),
      });
    }
    const commitStatuses = record(statuses).statuses;
    for (const raw of Array.isArray(commitStatuses) ? commitStatuses : []) {
      const check = statusCheck(raw);
      if (check !== null) found.push({ ...check, required: required.has(check.name) });
    }
    // Un check exigé qui n'a encore rien rendu est en attente, pas absent.
    for (const name of required)
      if (!found.some((check) => check.name === name))
        found.push({ name, status: "pending", conclusion: null, url: null, required: true });
    return found;
  }

  async failedLogs(head: string, limit: number): Promise<FailedLog[]> {
    const logs = new Map<string, Promise<string>>();
    // `gh run view <id> --log-failed` : le log des étapes rouges de TOUS les jobs du run, une ligne `job\tétape\tmessage`.
    const runLog = (id: string): Promise<string> => {
      let log = logs.get(id);
      if (log === undefined) {
        log = this.#run(["run", "view", id, "--log-failed"], PR_TIMEOUT_MS, LOG_MAX_BYTES).then((result) =>
          result.code === 0 ? result.stdout : "",
        );
        logs.set(id, log);
      }
      return log;
    };
    const failed: FailedLog[] = [];
    for (const check of (await this.checks(head)).filter(isRedCheck)) {
      const id = /\/actions\/runs\/(\d+)/.exec(check.url ?? "")?.[1];
      const all = id === undefined ? "" : await runLog(id);
      const own = all.split("\n").filter((line) => line.startsWith(`${check.name}\t`));
      const log = usefulLogLines(own.length > 0 ? own.join("\n") : all, limit);
      failed.push({ name: check.name, url: check.url, log });
    }
    return failed;
  }

  async openChanges(limit: number): Promise<OpenChange[]> {
    const raw = await this.#json([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      "number,title,url,headRefName,author,isDraft,updatedAt",
    ]);
    if (!Array.isArray(raw)) throw new HarnessError(502, "gh pr list : une liste est attendue");
    return raw.flatMap((entry) => {
      const value = record(entry);
      if (!Number.isInteger(value.number)) return [];
      return [
        {
          number: value.number as number,
          title: textOf(value.title),
          url: textOf(value.url),
          head: textOf(value.headRefName),
          author: login(value.author),
          draft: value.isDraft === true,
          updatedAt: textOf(value.updatedAt),
        },
      ];
    });
  }

  /** `gh run list` rend les exécutions les plus récentes d'abord : la première TERMINÉE de chaque workflow fait foi. */
  async failedCi(branch: string): Promise<FailedCi | null> {
    const raw = await this.#json([
      "run",
      "list",
      "--branch",
      branch,
      "--limit",
      "30",
      "--json",
      "databaseId,workflowName,displayTitle,status,conclusion,url,headSha,updatedAt",
    ]);
    if (!Array.isArray(raw)) throw new HarnessError(502, "gh run list : une liste est attendue");
    const seen = new Set<string>();
    let failed: FailedCi | null = null;
    for (const entry of raw) {
      const value = record(entry);
      const name = textOf(value.workflowName);
      if (value.status !== "completed" || seen.has(name)) continue;
      seen.add(name);
      if (checkConclusion(value.conclusion) !== "failure") continue;
      const at = textOf(value.updatedAt);
      // Plusieurs workflows rouges : le plus récent (une date ISO 8601 se compare comme un texte).
      if (failed === null || at > failed.at)
        failed = {
          id: String(value.databaseId ?? ""),
          name,
          title: textOf(value.displayTitle),
          url: textOf(value.url) || null,
          sha: textOf(value.headSha),
          at,
        };
    }
    return failed;
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

  async visibility(): Promise<ForgeVisibility | null> {
    try {
      return visibilityOf(record(await this.#json(["repo", "view", this.#slug(), "--json", "visibility"])).visibility);
    } catch {
      return null;
    }
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
