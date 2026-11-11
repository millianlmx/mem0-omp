// La forge d'un dépôt déclaré : là où vivent ses PR (MR sur GitLab) et ses issues.
//
// Un push git n'a besoin que de la clé SSH du dépôt (git.ts `remoteEnv`) ; tout le reste
// — ouvrir et fusionner une PR (`"merge": "gh"`), lire et lancer les issues (issues.ts,
// MCP), les commenter, les fermer, en créer — passe par la CLI de la forge, sous le
// compte du dépôt :
// - `github` : `gh` (forge-github.ts), compte `gh` du dépôt (policy.ts `ghEnv`) ;
// - `gitlab` : `glab` (forge-gitlab.ts), instance et jeton du dépôt (`gitlab`) ;
// - `none`   : merge local seulement ; tout geste de forge est refusé (409) en le disant.
//
// La forge se lit dans la configuration (`forge`), sinon dans l'URL du distant à chaque
// appel (un rechargement ou un `git remote set-url` compte) : `forgeKindOf`.
import type { ForgeKind, RepoConfig } from "./config.ts";
import { HarnessError } from "./errors.ts";
import type { Git } from "./git.ts";
import type { Exec } from "./proc.ts";
import { GitHubForge } from "./forge-github.ts";
import { GitLabForge } from "./forge-gitlab.ts";

export type Issue = {
  number: number;
  title: string;
  url: string;
  labels: string[];
  author: string | null;
  createdAt: string;
  /** Le texte de l'issue, seulement si la liste l'a demandé (`withBody`). */
  body?: string;
};

/**
 * Une liste d'issues : ouvertes ou toutes, un label les filtre, au plus `limit` (la forge
 * pagine au-delà de 100). `withBody` y joint leur texte (la vigie y cherche son empreinte).
 */
export type IssueQuery = { state: "open" | "all"; label?: string; limit: number; withBody?: boolean };

export type IssueComment = { author: string | null; body: string; createdAt: string };

/** Une issue lue en entier ; `state` vaut `OPEN` ou `CLOSED` quelle que soit la forge. */
export type IssueDetail = Issue & { body: string; state: string; comments: IssueComment[] };

/** L'état d'une PR (MR) : ouverte, fusionnée, fermée sans fusion. */
export type ChangeState = "OPEN" | "MERGED" | "CLOSED";

/** La visibilité d'un projet sur sa forge (`internal` : GitLab, GitHub Enterprise). */
export type ForgeVisibility = "public" | "internal" | "private";

/** `PUBLIC`, `private`, `Internal` → la visibilité en minuscules ; `null` pour toute autre valeur. */
export function visibilityOf(value: unknown): ForgeVisibility | null {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  return text === "public" || text === "internal" || text === "private" ? text : null;
}

/** Une PR (MR) à ouvrir de `head` vers `base`. */
export type ChangeRequest = { head: string; base: string; title: string; body: string };

/** Le message du commit squash d'une fusion : sans lui, la forge le compose à sa façon. */
export type SquashMessage = { subject: string; body: string };

/** La CLI d'une forge, éprouvée par `--check`. */
export type ForgeAuth = { ok: boolean; detail: string; fix: string };

/** Où en est un check de la forge : pas encore démarré, en cours, terminé. */
export type CheckStatus = "pending" | "running" | "completed";

/** L'issue d'un check terminé, dans les mots communs aux forges ; `success`, `neutral` et `skipped` sont verts. */
export type CheckConclusion = "success" | "failure" | "cancelled" | "skipped" | "neutral";

/** Un check de la forge sur un commit (check run GitHub, job du pipeline GitLab) ; `required` : exigé par la branche protégée. */
export type ForgeCheck = {
  name: string;
  status: CheckStatus;
  conclusion: CheckConclusion | null;
  url: string | null;
  required: boolean;
};

/** Un job rouge : son nom, son URL et un extrait borné de ses logs, filtré sur les lignes utiles (jamais fiable). */
export type FailedLog = { name: string; url: string | null; log: string };

/**
 * Le lien de l'auteur d'une PR (MR) au dépôt. `owner`, `member` et `collaborator` ont le droit d'y
 * pousser ; `outsider` : tout autre (contributeur occasionnel, premier venu).
 */
export type AuthorLink = "owner" | "member" | "collaborator" | "outsider";

/** Une PR (MR) ouverte, telle que la liste la rend ; `updatedAt` : sa dernière activité (ISO 8601). */
export type OpenChange = {
  number: number;
  title: string;
  url: string;
  /** La branche de la PR. */
  head: string;
  author: string | null;
  /** Sa branche vit dans un AUTRE dépôt (fork) ; `null` : la forge ne le dit pas. */
  fork: boolean | null;
  /** `null` : la forge ne le dit pas, ou d'un mot inconnu. */
  authorLink: AuthorLink | null;
  draft: boolean;
  updatedAt: string;
};

/** Une exécution terminée de la CI, en échec : `name` son workflow (son pipeline), `title` ce qui l'a lancée, `at` sa fin (ISO 8601). */
export type FailedCi = { id: string; name: string; title: string; url: string | null; sha: string; at: string };

/**
 * Les lignes qui disent POURQUOI un job a échoué (test rouge, erreur TypeScript, lint), à garder d'un log de CI.
 * xcodebuild clôt une suite rouge par `** TEST EXECUTE FAILED **` (ou `** TEST BUILD FAILED **`).
 */
const USEFUL_LOG_LINE = /✗|not ok|error TS\d*|\bError:|\blint|##\[error\]|\*\* [A-Z ]*FAILED \*\*/i;

/**
 * L'en-tête du bilan d'xcodebuild : les tests rouges suivent, un par ligne indentée d'une tabulation
 * (`\tClasse.test_x()`, après l'horodatage `…Z ` dans un log de GitHub). Le log n'a pas d'autre trace
 * de leur nom quand les tests tournent sur un simulateur.
 */
const FAILING_TESTS = /Failing tests:\s*$/;
const LISTED_TEST = /(^|\dZ )\t\S/;

/**
 * Une erreur de compilateur qui situe sa cause : `chemin:ligne[:colonne]: error: …` (Swift, clang, gcc, Go)
 * ou `chemin(ligne,colonne): error TS…`. Elle passe avant toute autre ligne utile.
 */
const LOCATED_DIAGNOSTIC = /[\w.~/-]+:\d+(:\d+)?: (fatal )?error:|\(\d+,\d+\): error TS\d+/;

/**
 * Une ligne de code citée sous un diagnostic (`188 |     var error: NSError?`) : elle porte les mots
 * d'une erreur sans en être une, et un avertissement répété en remplissait l'extrait.
 */
const SOURCE_EXCERPT = /(^|\s)\d+ +\| /;

/**
 * Une annotation d'erreur du job (`::error::` → `##[error]` dans le log) qui n'est pas la sortie finale
 * du processus : un script de CI y met la cause (swimmich : chaque test rouge et son message d'assertion).
 * Elle passe juste après les diagnostics situés.
 */
const ANNOTATION = /##\[error\](?!Process completed with exit code)/;

/** Le préfixe d'une ligne de `gh run view --log-failed` : `job\tétape\t<horodatage>Z `. */
const GH_LOG_PREFIX = /^[^\t]*\t[^\t]*\t\S+Z /;

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Une ligne de log sans séquence ANSI, bornée à 400 caractères (une ligne de bundle minifié ne remplit pas l'extrait). */
function plainLine(line: string): string {
  return line.replace(ANSI_SEQUENCE, "").trimEnd().slice(0, 400);
}

/**
 * L'extrait d'un log de CI, au plus `limit` caractères : d'abord les diagnostics situés
 * (`chemin:ligne:col: error:`), puis les annotations d'erreur, puis les autres lignes utiles (`✗`,
 * `not ok`, `error TS`, `Error:`, lint, le bilan `Failing tests:` d'xcodebuild et ses tests), chacune
 * dans l'ordre du log, une seule fois (xcodebuild liste deux fois un test relancé) et sans les lignes
 * de code citées. Aucune ligne utile : les dernières lignes du log.
 */
export function usefulLogLines(raw: string, limit: number): string {
  const lines = raw
    .split("\n")
    .map(plainLine)
    .filter((line) => line.trim() !== "");
  let listing = false;
  const seen = new Set<string>();
  const useful = lines.filter((line) => {
    const listed = listing && LISTED_TEST.test(line);
    listing = FAILING_TESTS.test(line) || listed;
    if (!listing && !(USEFUL_LOG_LINE.test(line) && !SOURCE_EXCERPT.test(line))) return false;
    const content = line.replace(GH_LOG_PREFIX, "");
    if (seen.has(content)) return false;
    seen.add(content);
    return true;
  });
  const rank = (line: string): number => (LOCATED_DIAGNOSTIC.test(line) ? 0 : ANNOTATION.test(line) ? 1 : 2);
  const picked =
    useful.length > 0 ? [0, 1, 2].flatMap((r) => useful.filter((line) => rank(line) === r)) : lines.slice(-20);
  let text = "";
  for (const line of picked) {
    if (text.length + line.length + 1 > limit) return text === "" ? line.slice(0, limit) : text;
    text += text === "" ? line : `\n${line}`;
  }
  return text;
}

/** Un check terminé qui n'est pas vert (`success`, `neutral`, `skipped`) : échec ou annulation. Un check en cours n'est pas rouge. */
export function isRedCheck(check: ForgeCheck): boolean {
  const green = check.conclusion === "success" || check.conclusion === "neutral" || check.conclusion === "skipped";
  return check.status === "completed" && !green;
}

export type Forge = {
  readonly kind: ForgeKind;
  /** Le nom lisible de la forge (« GitHub », « GitLab ») : les messages et les demandes de run le citent. */
  readonly name: string;
  /** Le projet sur la forge (`owner/name`, `groupe/sous-groupe/projet`), `null` s'il ne se lit pas. */
  readonly project: string | null;
  /** La CLI (`gh`, `glab`) présente et authentifiée sous le compte du dépôt. */
  auth(): Promise<ForgeAuth>;
  /**
   * Ouvre la PR de `head`, ou retrouve celle qui existe : son URL, sinon `known` (l'URL
   * déjà connue du run). Lève si la forge refuse et qu'aucune URL n'est connue. `draft` :
   * en BROUILLON (une PR existante y est remise, ce qui désarme sa fusion automatique).
   */
  openChange(change: ChangeRequest, known: string | null, draft?: boolean): Promise<string | null>;
  /** La fusion squash automatique de la PR de `head` (dès que ses checks passent), sa branche supprimée. Lève si refusée. */
  autoMerge(head: string, message: SquashMessage | null): Promise<void>;
  /** L'état de la PR de `head`, `null` s'il ne se lit pas (la forge ne répond pas). */
  changeState(head: string): Promise<ChangeState | null>;
  /** Sort la PR de `head` du brouillon (sans effet sur une PR qui n'en est pas un). Lève si refusé. */
  markReady(head: string): Promise<void>;
  /**
   * Les checks de la forge sur `head` (le SHA exact d'un commit poussé, ou une branche) : ceux que
   * la protection de la branche principale exige portent `required`, et un check exigé qui n'a pas
   * encore rendu compte figure en `pending`. Lève si la forge ne répond pas.
   */
  checks(head: string): Promise<ForgeCheck[]>;
  /** Pour chaque job rouge de `head` : son nom, son URL et au plus `limit` caractères utiles de ses logs (`usefulLogLines`). */
  failedLogs(head: string, limit: number): Promise<FailedLog[]>;
  issues(query: IssueQuery): Promise<Issue[]>;
  /** Une issue, son texte et ses commentaires. */
  issue(number: number): Promise<IssueDetail>;
  comment(number: number, body: string): Promise<void>;
  /** Ferme l'issue, avec un commentaire s'il est donné. */
  close(number: number, comment?: string): Promise<void>;
  /** Rouvre l'issue, avec un commentaire s'il est donné. */
  reopen(number: number, comment?: string): Promise<void>;
  createIssue(input: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<{ number: number; url: string }>;
  /** Les labels du projet. */
  labels(): Promise<string[]>;
  /** Crée un label ; `color` en hexadécimal sans `#` (`5319e7`). */
  createLabel(name: string, options: { color: string; description: string }): Promise<void>;
  /**
   * La visibilité du projet sur la forge ; `null` si elle ne se lit pas (CLI en échec, réponse
   * illisible, aucune forge) : jamais d'exception. Seul `private` vaut « privé » (issues.corporate: full).
   */
  visibility(): Promise<ForgeVisibility | null>;
  /**
   * Les PR (MR) ouvertes du projet, au plus `limit`, les moins récemment touchées d'abord ; chacune dit si
   * elle vient d'un fork et le lien de son auteur au dépôt (ce que le bac « Propositions » exige avant de
   * proposer sa reprise).
   */
  openChanges(limit: number): Promise<OpenChange[]>;
  /**
   * La dernière exécution TERMINÉE de la CI de `branch`, si elle est en échec ; `null` si elle est verte,
   * annulée, ou si la branche n'en a aucune. Une exécution en cours ne compte pas : la précédente fait foi.
   * Seules comptent les exécutions du dépôt lui-même : celle d'une PR (d'un fork dont la branche porte le
   * même nom) n'est pas la CI de `branch`.
   */
  failedCi(branch: string): Promise<FailedCi | null>;
};

/** Ce dont une forge a besoin : lancer sa CLI, lire le distant du clone, l'environnement du service. */
export type ForgeDeps = { exec: Exec; git: Git; env?: Record<string, string | undefined> };

/** L'hôte et le chemin d'un distant git (SSH `hôte:chemin`, `ssh://`, `https://`, `git://`) ; `null` sinon. */
export type RemoteLocation = { host: string; path: string };

export function remoteLocation(url: string): RemoteLocation | null {
  const text = url.trim();
  let host: string;
  let rest: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    if (!["ssh:", "git+ssh:", "https:", "http:", "git:"].includes(parsed.protocol)) return null;
    host = parsed.hostname;
    rest = decodeURIComponent(parsed.pathname);
  } else {
    // La forme scp de git : `[utilisateur@]hôte:chemin` (un chemin local n'a pas de `:` avant son premier `/`).
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/.exec(text);
    if (!scp) return null;
    host = scp[1] as string;
    rest = scp[2] as string;
  }
  const path = rest
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const segments = path.split("/");
  if (host === "" || segments.length < 2 || segments.some((segment) => !/^[\w.-]+$/.test(segment))) return null;
  return { host: host.toLowerCase(), path };
}

/** `owner/name` d'une URL GitHub (SSH, `ssh://` ou HTTPS) ; `null` pour un autre hôte. */
export function githubSlug(url: string): string | null {
  const at = remoteLocation(url);
  return at?.host === "github.com" && at.path.split("/").length === 2 ? at.path : null;
}

/**
 * La forge d'un dépôt : `forge` s'il la déclare ; sinon github.com → `github` ; un hôte
 * qui contient « gitlab », ou un bloc `gitlab` → `gitlab` ; un compte `gh` ou
 * `"merge": "gh"` → `github` (ce que `gh` servait avant les forges) ; sinon `none`.
 */
export function forgeKindOf(
  repo: Pick<RepoConfig, "forge" | "gitlab" | "gh" | "merge">,
  url: string | null,
): ForgeKind {
  if (repo.forge !== undefined) return repo.forge;
  const at = url === null ? null : remoteLocation(url);
  if (at?.host === "github.com") return "github";
  if (repo.gitlab !== undefined || at?.host.includes("gitlab")) return "gitlab";
  if (repo.gh !== undefined || repo.merge === "gh") return "github";
  return "none";
}

/** La forge d'un dépôt, lue dans sa configuration et l'URL de son distant (`remote`, `origin` sans push). */
export async function openForge(repo: RepoConfig, deps: ForgeDeps): Promise<Forge> {
  const remote = repo.remote ?? "origin";
  const read = await deps.git.raw(repo.path, ["remote", "get-url", remote]).catch(() => null);
  const url = read?.code === 0 && read.stdout.trim() !== "" ? read.stdout.trim() : null;
  const kind = forgeKindOf(repo, url);
  const env = deps.env ?? process.env;
  if (kind === "github")
    return new GitHubForge(repo, { remote, url, explicit: repo.forge === "github" }, deps.exec, env);
  if (kind === "gitlab") return new GitLabForge(repo, { remote, url }, deps.exec, env);
  return new NoForge(repo, url);
}

/** Une URL https dans une sortie de CLI (l'URL d'une PR créée, ou « already exists: … »). */
export function urlIn(output: string): string | null {
  const match = /https?:\/\/\S+/.exec(output);
  return match ? match[0].replace(/[.,)]+$/, "") : null;
}

/** La première ligne utile d'un échec de CLI : le délai, la sortie d'erreur, ou le code. */
export function failure(result: { code: number | null; stderr: string; timedOut: boolean }): string {
  return result.timedOut ? "délai dépassé" : result.stderr.trim().slice(0, 300) || `code ${result.code}`;
}

/** Une valeur d'objet JSON, `{}` sinon. */
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Un texte d'un objet JSON, `fallback` sinon. */
export function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** `forge: "none"` (ou aucune forge reconnue) : merge local seulement, chaque geste de forge refusé en le disant. */
class NoForge implements Forge {
  readonly kind = "none" as const;
  readonly name = "aucune forge";
  readonly project = null;
  readonly #why: string;

  constructor(repo: RepoConfig, url: string | null) {
    const host = url === null ? null : remoteLocation(url)?.host;
    const where =
      repo.forge === "none" ? '`forge: "none"`' : host ? `distant sur ${host}, forge inconnue` : "sans distant";
    this.#why = `le dépôt ${repo.name} n'a pas de forge (${where}) : ni issues ni PR, merge local seulement — déclare \`forge: "github"\` ou \`"gitlab"\` dans sa configuration`;
  }

  #refuse(): never {
    throw new HarnessError(409, this.#why);
  }

  async auth(): Promise<ForgeAuth> {
    return { ok: false, detail: this.#why, fix: 'Déclare `forge: "github"` ou `"gitlab"` dans l\'entrée du dépôt.' };
  }
  async openChange(): Promise<string | null> {
    this.#refuse();
  }
  async autoMerge(): Promise<void> {
    this.#refuse();
  }
  async changeState(): Promise<ChangeState | null> {
    this.#refuse();
  }
  async markReady(): Promise<void> {
    this.#refuse();
  }
  async checks(): Promise<ForgeCheck[]> {
    this.#refuse();
  }
  async failedLogs(): Promise<FailedLog[]> {
    this.#refuse();
  }
  async issues(): Promise<Issue[]> {
    this.#refuse();
  }
  async issue(): Promise<IssueDetail> {
    this.#refuse();
  }
  async comment(): Promise<void> {
    this.#refuse();
  }
  async close(): Promise<void> {
    this.#refuse();
  }
  async reopen(): Promise<void> {
    this.#refuse();
  }
  async createIssue(): Promise<{ number: number; url: string }> {
    this.#refuse();
  }
  async labels(): Promise<string[]> {
    this.#refuse();
  }
  async createLabel(): Promise<void> {
    this.#refuse();
  }
  async visibility(): Promise<ForgeVisibility | null> {
    return null;
  }
  // Les lectures du bac « Propositions » : sans forge, rien à proposer (et rien à refuser).
  async openChanges(): Promise<OpenChange[]> {
    return [];
  }
  async failedCi(): Promise<FailedCi | null> {
    return null;
  }
}
