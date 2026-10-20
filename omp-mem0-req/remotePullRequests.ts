// Les routes de PR de l'API distante (S-3) et les FAITS DE PR du flux SSE : portage de
// `RemoteActions` (pullRequests, merge, refreshPullRequestStates, refuseIfGhMissing),
// `ProjectConsoleModel` (suivi des PR de la conduite), `PullRequests.swift`, `PRService.swift`,
// `GhCLI.swift`, `PRStateReader.swift`, `PullRequestStateBook.swift` et `PullRequestFacts.swift`
// (omp-console/Sources/OMPConsole/{Remote,Project,Kanban}/, ConsoleCore/Kanban/).
//
// `gh` s'exécute par `ctx.exec` (jamais par un shell), avec les MÊMES `argv` que `GhCommand` :
//   pr view --json title,headRefOid,body -- <url>      (lecture d'une PR de la conduite)
//   pr checks --json name,bucket,link -- <url>         (ses statuts)
//   pr merge --squash --subject … --body … --match-head-commit <oid> -- <url>
//   pr view --json state,mergedAt,closedAt -- <url>    (le fait de PR de l'ardoise)
//
// Faits de PR : le registre du Mac n'a AUCUNE minuterie — il lit au lancement, à toute URL jamais
// tentée, et au rafraîchissement manuel (les 60 s sont la veille de la conduite, `attachPRWatch`,
// qui ne sert que sa propre fenêtre). Ici ces déclencheurs s'arment quand un flux s'ouvre
// (`onChange`) ou qu'un rafraîchissement est demandé : rien ne tourne quand personne n'écoute.
import fs from "node:fs";
import os from "node:os";
import { realpathOr } from "./git.ts";
import { lotRepoKey } from "./lot.ts";
import { RemoteError, remoteJson } from "./remoteApi.ts";
import type { RemoteRoute, RemoteRouteContext } from "./remoteApi.ts";
import type { ExecFn, Feed, RemoteContext } from "./remoteContext.ts";
import { bodyObject, conduiteModelOf, requiredString } from "./remoteHosted.ts";
import type { ConduiteModel } from "./remoteHosted.ts";
import type { WireProject } from "./remoteWire.ts";

/** `GhBinary.overrideKey`. */
const GH_OVERRIDE_KEY = "OMP_CONSOLE_GH_BINARY";
/** `GhCLI(timeout: 60)` (lecture et fusion de la conduite) et `GhCLI(timeout: 20)` (faits de PR de l'ardoise). */
const GH_TIMEOUT_SECONDS = 60;
const GH_STATE_TIMEOUT_SECONDS = 20;
/** `PullRequestStateBook.concurrency`. */
const STATE_CONCURRENCY = 4;


// --- `gh` : `GhBinary`, `GhCommand`, `GhError` ------------------------------------------------

/** Les erreurs de la couche PR, chacune avec SON texte (`GhError.userMessage`). */
export class GhError extends Error {
  readonly detail: string | null;

  /** `detail` : le motif d'un `commandFailed` (dernière ligne de `stderr`) — sert `failureDetail`. */
  constructor(message: string, detail: string | null = null) {
    super(message);
    this.detail = detail;
  }

  /** Le motif d'un `commandFailed`, ou le message complet pour toute autre forme. */
  get failureDetail(): string {
    return this.detail !== null && this.detail !== "" ? this.detail : this.message;
  }

  static invalidPRURL(url: string): GhError {
    return new GhError(`l'adresse de PR est refusée : ${url} — attendu https://github.com/<propriétaire>/<dépôt>/pull/<numéro>`);
  }

  static commandFailed(command: string, code: number, detail: string): GhError {
    return new GhError(`gh ${command} a échoué (code ${code}) : ${detail}`, detail);
  }

  static commandTimedOut(command: string, seconds: number): GhError {
    return new GhError(`gh ${command} n'a pas rendu la main en ${seconds} s — lecture abandonnée.`);
  }

  static unreadableOutput(command: string, detail: string): GhError {
    return new GhError(`la sortie de gh ${command} est illisible : ${detail}`);
  }

  /** Traduit une erreur quelconque en `GhError`, en nommant la sous-commande. */
  static from(err: unknown, command: string): GhError {
    return err instanceof GhError ? err : GhError.unreadableOutput(command, err instanceof Error ? err.message : String(err));
  }
}

/** `GhBinary.candidates` : l'override seul, sinon chaque entrée de `PATH` puis les emplacements connus. */
function ghCandidates(env: Record<string, string | undefined>): string[] {
  const override = env[GH_OVERRIDE_KEY];
  if (override !== undefined && override !== "") return [override];
  const candidates: string[] = [];
  const pathVariable = env.PATH;
  if (pathVariable !== undefined) {
    for (const entry of pathVariable.split(":")) if (entry !== "") candidates.push(`${entry}/gh`);
  }
  candidates.push("/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh");
  return candidates;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `GhBinary.resolve` : le premier candidat EXÉCUTABLE ; sinon le message `ghNotFound`. */
type GhResolution = { binary: string } | { failure: string };

function resolveGh(env: Record<string, string | undefined>): GhResolution {
  const searched = ghCandidates(env);
  for (const candidate of searched) if (isExecutableFile(candidate)) return { binary: candidate };
  const override = env[GH_OVERRIDE_KEY];
  const detail = override !== undefined && override !== "" ? `chemin imposé par ${GH_OVERRIDE_KEY} : ${override}` : searched.join(", ");
  return { failure: `gh est introuvable (cherché : ${detail}) — les statuts de PR ne peuvent pas être lus.` };
}

/** `RemoteActions.refuseIfGhMissing` : `gh` absent, la route le dit en 503, jamais en 500. */
function refuseIfGhMissing(env: Record<string, string | undefined>): string {
  const resolved = resolveGh(env);
  if ("failure" in resolved) throw new RemoteError("unavailable", resolved.failure);
  return resolved.binary;
}

const prView = (url: string): string[] => ["pr", "view", "--json", "title,headRefOid,body", "--", url];
const prState = (url: string): string[] => ["pr", "view", "--json", "state,mergedAt,closedAt", "--", url];
const prChecks = (url: string): string[] => ["pr", "checks", "--json", "name,bucket,link", "--", url];
const prMerge = (url: string, title: string, body: string, headOid: string): string[] => [
  "pr",
  "merge",
  "--squash",
  "--subject",
  title,
  "--body",
  body,
  "--match-head-commit",
  headOid,
  "--",
  url,
];

type GhOutput = { code: number; stdout: string; stderr: string };

/** `GhCLI.run` : le nom employé dans les erreurs est la sous-commande (`pr view`, …). */
async function runGh(exec: ExecFn, binary: string, args: string[], cwd: string, timeoutSeconds: number): Promise<GhOutput> {
  const command = args.slice(0, 2).join(" ");
  const result = await exec(binary, args, { cwd, timeoutMs: timeoutSeconds * 1000 });
  if (result.timedOut) throw GhError.commandTimedOut(command, timeoutSeconds);
  if (result.missing) throw GhError.commandFailed(command, -1, result.stderr.trim() || "binaire introuvable");
  return { code: result.code ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** `FilesError.lastLine` : la dernière ligne non vide de `stderr`. */
function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map(line => line.replace(/^[ \t]+|[ \t]+$/g, ""))
    .filter(line => line !== "");
  return lines[lines.length - 1] ?? "";
}

function requireSuccess(output: GhOutput, command: string): void {
  if (output.code !== 0) throw GhError.commandFailed(command, output.code, lastLine(output.stderr));
}


// --- la couche PURE du suivi de PR : `PullRequests.swift` --------------------------------------

type RequiredCheck = "check (ubuntu-latest)" | "check (macos-latest)" | "release-simulation";
/** Les trois statuts requis, dans l'ORDRE d'affichage. */
const REQUIRED_CHECKS: RequiredCheck[] = ["check (ubuntu-latest)", "check (macos-latest)", "release-simulation"];

type PRCheckState = "green" | "red" | "pending" | "ignored";
type PRFreshness = "unknown" | "fresh" | "stale";

/** Le rang de SÉVÉRITÉ : sur un doublon, la lecture retenue est la PIRE. */
const SEVERITY: Record<PRCheckState, number> = { red: 3, pending: 2, ignored: 1, green: 0 };

/** La table EXACTE `bucket → state` de gh. */
function checkState(bucket: unknown): PRCheckState {
  switch (bucket) {
    case "pass":
      return "green";
    case "fail":
    case "cancel":
      return "red";
    case "pending":
      return "pending";
    case "skipping":
      return "ignored";
    default:
      return "pending";
  }
}

type PRCheckReading = { name: string; state: PRCheckState; link?: string };
type PRSnapshot = { title: string; headOid: string; body: string; checks: PRCheckReading[] };
type PRKnowledge = { snapshot: PRSnapshot | null; freshness: PRFreshness; url: string };
type FollowedPR = { slug: string; url: string; number?: number };
type PRCheckRow = { required: RequiredCheck; state: PRCheckState; link?: string };
type ProjectPRRow = {
  slug: string;
  number?: number;
  title?: string;
  url: string;
  checks: PRCheckRow[];
  freshness: PRFreshness;
  headOid?: string;
};

const URL_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** `validatedPRURL` : validation TEXTUELLE de la chaîne brute ; rend la chaîne reçue, inchangée. */
function validatedPRURL(raw: string): string | null {
  const chars = Array.from(raw);
  if (chars.length <= 8 || chars.slice(0, 8).join("").toLowerCase() !== "https://") return null;
  const parts = chars.slice(8).join("").split("/");
  if (parts.length !== 5) return null;
  const [host, owner, repository, kind, number] = parts as [string, string, string, string, string];
  if (host.toLowerCase() !== "github.com" || kind !== "pull") return null;
  if (!URL_SEGMENT.test(owner) || !URL_SEGMENT.test(repository)) return null;
  if (!/^[0-9]+$/.test(number) || number.startsWith("0")) return null;
  return raw;
}

/** `pullRequestNumber(in:)` : le dernier composant du chemin d'une URL http(s) quand c'est un nombre. */
function pullRequestNumber(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const last = parsed.pathname.split("/").filter(part => part !== "").pop();
  if (last === undefined || !/^[0-9]+$/.test(last)) return undefined;
  const value = Number(last);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** `followedPRs(of:)` : les PR suivies d'un projet, dans l'ORDRE DU PLAN (statut `pr`, `prUrl` non vide). */
function followedPRs(project: WireProject | null): FollowedPR[] {
  if (project === null) return [];
  const followed: FollowedPR[] = [];
  for (const segment of project.segments) {
    for (const feature of segment.features) {
      if (feature.status !== "pr" || feature.prUrl === undefined || feature.prUrl === "") continue;
      const number = pullRequestNumber(feature.prUrl);
      followed.push({ slug: feature.slug, url: feature.prUrl, ...(number !== undefined ? { number } : {}) });
    }
  }
  return followed;
}

/** `projectPRRows` : `checks` porte TOUJOURS les trois statuts requis ; un nom absent est `pending`, sans lien. */
function projectPRRows(followed: FollowedPR[], knowledge: Map<string, PRKnowledge>): ProjectPRRow[] {
  return followed.map(pr => {
    const known = knowledge.get(pr.slug);
    const checks = REQUIRED_CHECKS.map((required): PRCheckRow => {
      const reading = known?.snapshot?.checks.find(check => check.name === required);
      return { required, state: reading?.state ?? "pending", ...(reading?.link !== undefined ? { link: reading.link } : {}) };
    });
    return {
      slug: pr.slug,
      ...(pr.number !== undefined ? { number: pr.number } : {}),
      ...(known?.snapshot != null ? { title: known.snapshot.title } : {}),
      url: pr.url,
      checks,
      freshness: known?.freshness ?? "unknown",
      ...(known?.snapshot != null ? { headOid: known.snapshot.headOid } : {}),
    };
  });
}

class PRParseError extends Error {}

function parseJSONObject(stdout: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new PRParseError("la sortie n'est pas un objet JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PRParseError("la sortie n'est pas un objet JSON");
  return value as Record<string, unknown>;
}

/** La sortie de `gh pr view --json title,headRefOid,body`, décodée. */
function parsePRView(stdout: string): { title: string; headOid: string; body: string } {
  const object = parseJSONObject(stdout);
  if (typeof object.title !== "string" || typeof object.headRefOid !== "string") {
    throw new PRParseError("les champs title et headRefOid sont absents");
  }
  return { title: object.title, headOid: object.headRefOid, body: typeof object.body === "string" ? object.body : "" };
}

/** La sortie de `gh pr checks --json name,bucket,link`, classée : un doublon est réduit au PIRE. */
function parseChecks(stdout: string): PRCheckReading[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw) || !raw.every(item => typeof item === "object" && item !== null && !Array.isArray(item))) {
    throw new PRParseError("la sortie n'est pas un tableau d'objets JSON");
  }
  const worst = new Map<string, PRCheckReading>();
  for (const item of raw as Array<Record<string, unknown>>) {
    if (typeof item.name !== "string") throw new PRParseError("un statut est sans nom");
    const state = checkState(item.bucket);
    const reading: PRCheckReading = { name: item.name, state, ...(typeof item.link === "string" ? { link: item.link } : {}) };
    const kept = worst.get(item.name);
    if (kept !== undefined && SEVERITY[kept.state] > SEVERITY[state]) continue;
    worst.set(item.name, reading);
  }
  return [...worst.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Ramène une lecture à EXACTEMENT les trois statuts requis : un nom absent devient `pending` sans lien. */
function normalizedRequiredChecks(readings: PRCheckReading[]): PRCheckReading[] {
  return REQUIRED_CHECKS.map(required => readings.find(reading => reading.name === required) ?? { name: required, state: "pending" });
}

/** `GhPRService.read` : `gh pr view` puis `gh pr checks`, dans cet ordre, `cwd` = la racine du projet conduit. */
async function readPR(exec: ExecFn, binary: string, prUrl: string, directory: string): Promise<PRSnapshot> {
  const url = validatedPRURL(prUrl);
  if (url === null) throw GhError.invalidPRURL(prUrl);
  const parse = <T>(body: () => T): T => {
    try {
      return body();
    } catch (err) {
      throw GhError.unreadableOutput("pr view", err instanceof PRParseError ? err.message : err instanceof Error ? err.message : String(err));
    }
  };
  const view = await runGh(exec, binary, prView(url), directory, GH_TIMEOUT_SECONDS);
  requireSuccess(view, "pr view");
  const parsed = parse(() => parsePRView(view.stdout));
  const checks = await runGh(exec, binary, prChecks(url), directory, GH_TIMEOUT_SECONDS);
  requireSuccess(checks, "pr checks");
  const readings = parse(() => parseChecks(checks.stdout));
  return { title: parsed.title, headOid: parsed.headOid, body: parsed.body, checks: normalizedRequiredChecks(readings) };
}

/** `ProjectViewText.prMergeRefused` / `prMergeRejected`. */
function mergeRefusedText(number: number | undefined): string {
  return number === undefined
    ? "Fusion refusée\u00a0: les trois statuts requis ne sont pas verts."
    : `Fusion refusée\u00a0: les trois statuts requis ne sont pas verts (PR #${number}).`;
}

function mergeRejectedText(detail: string, number: number | undefined): string {
  return number === undefined ? `Fusion refusée par GitHub\u00a0: ${detail}.` : `Fusion refusée par GitHub\u00a0: ${detail} (PR #${number}).`;
}

/** `RemoteActions.isSHA` : 40 caractères, chiffres ou minuscules hexadécimales. */
function isSHA(raw: string): boolean {
  return /^[0-9a-f]{40}$/.test(raw);
}


// --- le suivi des PR de la conduite : `ProjectConsoleModel` (BR-2) ------------------------------

type PRMergeProposal = { slug: string; number?: number; title: string; url: string; headOid: string; body: string };

/** Ce que le Mac tient entre deux rafraîchissements : connaissance, lignes, derniers échecs. */
class ConduitePullRequests {
  private readonly ctx: RemoteContext;
  private readonly conduite: ConduiteModel;
  private knowledge = new Map<string, PRKnowledge>();
  private generation = 0;
  private isRefreshing = false;
  /** L'échec de LECTURE du dernier rafraîchissement, jamais celui d'un geste. */
  failure: string | null = null;
  /** L'échec ou le refus du DERNIER geste. */
  actionFailure: string | null = null;
  pendingMerge: PRMergeProposal | null = null;

  constructor(ctx: RemoteContext) {
    this.ctx = ctx;
    this.conduite = conduiteModelOf(ctx.api);
    this.generation = this.conduite.generation;
  }

  /** Le projet de la conduite vive dans le magasin (`applyProject`). */
  private conductedProject(): WireProject | null {
    const identity = this.conduite.identity;
    if (identity === null) return null;
    const key = lotRepoKey(identity.repoRoot);
    return this.ctx.store.snapshot().projects.projects.find(project => project.repoKey === key) ?? null;
  }

  /** Une fermeture de conduite oublie toute la connaissance (`clearPRs`). */
  private resetOnClose(): void {
    if (this.generation === this.conduite.generation) return;
    this.generation = this.conduite.generation;
    this.knowledge = new Map();
    this.failure = null;
    this.actionFailure = null;
    this.pendingMerge = null;
  }

  /** Les slugs encore suivis avec la MÊME `prUrl` sont gardés, les autres oubliés (S-1). */
  private prune(followed: FollowedPR[]): void {
    const urls = new Map(followed.map(pr => [pr.slug, pr.url] as const));
    for (const [slug, known] of [...this.knowledge]) if (urls.get(slug) !== known.url) this.knowledge.delete(slug);
  }

  /** Les lignes affichées, dans l'ordre du plan. */
  rows(): ProjectPRRow[] {
    this.resetOnClose();
    const followed = followedPRs(this.conductedProject());
    this.prune(followed);
    return projectPRRows(followed, this.knowledge);
  }

  private clear(): void {
    this.knowledge = new Map();
    this.failure = null;
  }

  private get directory(): string {
    return this.conduite.identity?.repoRoot ?? this.conductedProject()?.repoRoot ?? "";
  }

  /**
   * Un rafraîchissement : les lectures des PR suivies sont CONCURRENTES, l'ordre d'affichage reste celui du
   * plan. Aucun `gh` n'est lancé si l'état n'est pas vivant, si le projet manque ou si la liste suivie est
   * vide ; un rafraîchissement en cours n'est jamais empilé.
   */
  async refresh(): Promise<void> {
    this.resetOnClose();
    if (this.isRefreshing) return;
    const project = this.conductedProject();
    if (this.conduite.state !== "live" || project === null) {
      this.clear();
      return;
    }
    const followed = followedPRs(project);
    if (followed.length === 0) {
      this.clear();
      return;
    }
    this.isRefreshing = true;
    try {
      this.prune(followed);
      const resolved = resolveGh(this.ctx.env);
      if ("failure" in resolved) {
        this.failure = resolved.failure;
        return;
      }
      const directory = this.directory;
      const results = await Promise.all(
        followed.map(async pr => {
          try {
            return { pr, snapshot: await readPR(this.ctx.exec, resolved.binary, pr.url, directory), error: null };
          } catch (err) {
            return { pr, snapshot: null, error: GhError.from(err, "pr view") };
          }
        }),
      );
      // Une erreur de lecture ne fait jamais disparaître une ligne : elle marque la connaissance périmée
      // et remonte le message du PREMIER échec dans l'ordre du plan.
      let firstFailure: string | null = null;
      for (const { pr, snapshot, error } of results) {
        if (snapshot !== null) {
          this.knowledge.set(pr.slug, { snapshot, freshness: "fresh", url: pr.url });
          continue;
        }
        if (firstFailure === null && error !== null) firstFailure = error.message;
        const existing = this.knowledge.get(pr.slug)?.snapshot ?? null;
        this.knowledge.set(pr.slug, { snapshot: existing, freshness: existing === null ? "unknown" : "stale", url: pr.url });
      }
      this.failure = firstFailure;
    } finally {
      this.isRefreshing = false;
    }
  }

  /** Relit la PR avant toute confirmation : refuse si la relecture échoue ou si un statut frais n'est pas vert. */
  async beginMerge(slug: string, binary: string): Promise<void> {
    this.pendingMerge = null;
    this.actionFailure = null;
    const row = this.rows().find(candidate => candidate.slug === slug);
    if (row === undefined) return;
    try {
      const snapshot = await readPR(this.ctx.exec, binary, row.url, this.directory);
      this.knowledge.set(slug, { snapshot, freshness: "fresh", url: row.url });
      if (snapshot.checks.length !== REQUIRED_CHECKS.length || !snapshot.checks.every(check => check.state === "green")) {
        this.actionFailure = mergeRefusedText(row.number);
        return;
      }
      this.pendingMerge = {
        slug,
        ...(row.number !== undefined ? { number: row.number } : {}),
        title: snapshot.title,
        url: row.url,
        headOid: snapshot.headOid,
        body: snapshot.body,
      };
    } catch (err) {
      this.failure = GhError.from(err, "pr view").message;
      const known = this.knowledge.get(slug);
      if (known !== undefined) {
        this.knowledge.set(slug, { snapshot: known.snapshot, freshness: known.snapshot === null ? "unknown" : "stale", url: known.url });
      }
    }
  }

  /** Fusionne la PR proposée : squash, sujet et corps de la PR, tête bornée. Un rafraîchissement suit. */
  async confirmMerge(binary: string): Promise<void> {
    const proposal = this.pendingMerge;
    if (proposal === null) return;
    this.pendingMerge = null;
    this.actionFailure = null;
    try {
      const url = validatedPRURL(proposal.url);
      if (url === null) throw GhError.invalidPRURL(proposal.url);
      const output = await runGh(
        this.ctx.exec,
        binary,
        prMerge(url, proposal.title, proposal.body, proposal.headOid),
        this.directory,
        GH_TIMEOUT_SECONDS,
      );
      requireSuccess(output, "pr merge");
    } catch (err) {
      this.actionFailure = mergeRejectedText(GhError.from(err, "pr merge").failureDetail, proposal.number);
    }
    await this.refresh();
  }

  cancelMerge(): void {
    this.pendingMerge = null;
  }
}


// --- les faits de PR de l'ardoise : `PullRequestStateBook` + `PullRequestFacts` -----------------

type PullRequestFactState = "OPEN" | "CLOSED" | "MERGED";
type PullRequestFact = { url: string; state: PullRequestFactState; closedAtMs?: number };

type FactsBase = Omit<RemoteContext, "api" | "machine" | "devices" | "streams">;

/** `PullRequestFacts.urls(in:)` : les `prUrl` des features `done` d'un lot et des features `pr`/`merged` d'un projet. */
function factUrls(ctx: Pick<RemoteContext, "store">): string[] {
  const snapshot = ctx.store.snapshot();
  const urls = new Set<string>();
  for (const lot of snapshot.lots.lots) {
    for (const feature of lot.features) if (feature.state === "done" && feature.prUrl !== undefined && feature.prUrl !== "") urls.add(feature.prUrl);
  }
  for (const project of snapshot.projects.projects) {
    for (const segment of project.segments) {
      for (const feature of segment.features) {
        if ((feature.status === "pr" || feature.status === "merged") && feature.prUrl !== undefined && feature.prUrl !== "") urls.add(feature.prUrl);
      }
    }
  }
  return [...urls].sort();
}

/** Une date GitHub en ms epoch ; `undefined` pour `null`, une valeur absente ou illisible. */
function milliseconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** `GhPullRequestStateReader.parse` : un objet JSON dont `state` est l'une des trois valeurs de GitHub. */
function parseFact(stdout: string, url: string): PullRequestFact {
  let object: unknown;
  try {
    object = JSON.parse(stdout);
  } catch {
    throw GhError.unreadableOutput("pr view", "sortie non JSON");
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) throw GhError.unreadableOutput("pr view", "sortie non JSON");
  const o = object as Record<string, unknown>;
  if (o.state !== "OPEN" && o.state !== "CLOSED" && o.state !== "MERGED") throw GhError.unreadableOutput("pr view", "état de PR inconnu");
  let closedAtMs: number | undefined;
  if (o.state === "MERGED") closedAtMs = milliseconds(o.mergedAt) ?? milliseconds(o.closedAt);
  else if (o.state === "CLOSED") closedAtMs = milliseconds(o.closedAt);
  return { url, state: o.state, ...(closedAtMs !== undefined ? { closedAtMs } : {}) };
}

/** Le contexte de `PullRequestStates`, tant que `createRemoteRoutes` n'a pas rattaché le contexte complet. */
const STATES_BY_CONTEXT = new WeakMap<object, PullRequestStates>();

/**
 * Le registre des faits de PR (S-5 de pipelines-livrees-statut-pr-faux-et-doub), publié au flux SSE
 * `pull-request-states`. Trois déclencheurs, aucune minuterie : le premier jeu d'URLs observé est lu en
 * entier, une URL jamais tentée est lue une fois, le rafraîchissement manuel relit tout sauf les PR
 * fusionnées (`MERGED` est terminal). Une relecture à la fois, `STATE_CONCURRENCY` processus `gh` au plus ;
 * ses faits sont publiés en UNE affectation à la fin ; un échec RETIRE le fait de l'URL.
 */
export class PullRequestStates implements Feed<unknown> {
  private readonly base: FactsBase;
  private facts = new Map<string, PullRequestFact>();
  private refreshing = false;
  private latestUrls: string[] = [];
  private attempted = new Set<string>();
  private queued: string[] = [];
  private current: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private stopObserving: (() => void) | null = null;

  constructor(base: FactsBase) {
    this.base = base;
  }

  /** Rattache le contexte complet : les routes y retrouvent CE registre. */
  attach(ctx: RemoteContext): void {
    STATES_BY_CONTEXT.set(ctx, this);
  }

  /** La charge de la trame : la liste ENTIÈRE triée par URL, et l'état de relecture. */
  payload(): { facts: PullRequestFact[]; refreshing: boolean } {
    const facts = [...this.facts.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    return { facts, refreshing: this.refreshing };
  }

  /** Chaque fait publié ET chaque bascule de relecture, jamais la valeur initiale. Le premier auditeur arme les lectures. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.stopObserving = this.base.store.onChange(() => this.observe(factUrls(this.base)));
      this.observe(factUrls(this.base));
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return;
      this.stopObserving?.();
      this.stopObserving = null;
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Aucune lecture, aucun fait quand `gh` est introuvable. */
  private binary(): string | null {
    const resolved = resolveGh(this.base.env);
    return "binary" in resolved ? resolved.binary : null;
  }

  /** Déclencheurs 1 et 2 : toute URL jamais tentée est lue, au plus tard à la fin de la relecture en cours. */
  private observe(urls: string[]): void {
    this.latestUrls = urls;
    if (this.binary() === null) return;
    const fresh = urls.filter(url => !this.attempted.has(url));
    if (fresh.length === 0) return;
    for (const url of fresh) this.attempted.add(url);
    this.queued.push(...fresh);
    if (!this.refreshing) this.startQueued();
  }

  /** Déclencheur 3 : relit toutes les URLs du dernier instantané, sauf celles dont le fait connu est `MERGED`. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.current ?? Promise.resolve();
    // Personne n'a forcément écouté depuis le dernier changement : le dernier jeu d'URLs se relit au magasin.
    this.latestUrls = factUrls(this.base);
    if (this.binary() === null) return Promise.resolve();
    const urls = this.latestUrls.filter(url => this.facts.get(url)?.state !== "MERGED");
    if (urls.length === 0) return Promise.resolve();
    for (const url of urls) this.attempted.add(url);
    this.queued.push(...urls);
    this.startQueued();
    return this.current ?? Promise.resolve();
  }

  private startQueued(): void {
    const binary = this.binary();
    if (binary === null || this.queued.length === 0) return;
    const urls = [...new Set(this.queued)];
    this.queued = [];
    this.refreshing = true;
    this.emit();
    this.current = this.read(urls, binary).then(results => this.publish(urls, results));
  }

  /** Publie une relecture d'un coup, puis enchaîne les URLs nouvelles reçues entre-temps. */
  private publish(urls: string[], results: Map<string, PullRequestFact>): void {
    const next = new Map(this.facts);
    for (const url of urls) {
      const fact = results.get(url);
      if (fact === undefined) next.delete(url);
      else next.set(url, fact);
    }
    this.facts = next;
    this.emit();
    if (this.queued.length === 0) {
      this.refreshing = false;
      this.current = null;
      this.emit();
    } else {
      this.startQueued();
    }
  }

  /** Lit `urls` par au plus `STATE_CONCURRENCY` tâches qui se partagent la file. */
  private async read(urls: string[], binary: string): Promise<Map<string, PullRequestFact>> {
    const results = new Map<string, PullRequestFact>();
    const pending = [...urls];
    const home = this.base.env.HOME ?? os.homedir();
    const worker = async (): Promise<void> => {
      for (let url = pending.shift(); url !== undefined; url = pending.shift()) {
        try {
          const valid = validatedPRURL(url);
          if (valid === null) throw GhError.invalidPRURL(url);
          const output = await runGh(this.base.exec, binary, prState(valid), home, GH_STATE_TIMEOUT_SECONDS);
          requireSuccess(output, "pr view");
          results.set(url, parseFact(output.stdout, url));
        } catch {
          /* `try?` : l'URL n'a pas de fait, l'état redevient « inconnu » */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STATE_CONCURRENCY, urls.length) }, worker));
    return results;
  }

  close(): void {
    this.listeners.clear();
    this.stopObserving?.();
    this.stopObserving = null;
  }
}


// --- les routes -----------------------------------------------------------------------------------

export function pullRequestRoutes(ctx: RemoteContext): RemoteRoute[] {
  const conduite = conduiteModelOf(ctx.api);
  const book = new ConduitePullRequests(ctx);
  const states = (): PullRequestStates => {
    let known = STATES_BY_CONTEXT.get(ctx);
    if (known === undefined) {
      known = new PullRequestStates(ctx);
      known.attach(ctx);
    }
    return known;
  };

  /** `projectRecord` puis `isConduiteLive` : le projet du magasin, qui doit être celui de la conduite vive. */
  const conductedProject = (repoKey: string): WireProject => {
    const project = ctx.store.snapshot().projects.projects.find(candidate => candidate.repoKey === repoKey);
    if (project === undefined) throw new RemoteError("not_found", "projet inconnu");
    const identity = conduite.identity;
    if (identity === null || realpathOr(identity.repoRoot) !== realpathOr(project.repoRoot)) {
      throw new RemoteError("conflict", "aucun projet conduit");
    }
    return project;
  };

  const list = async (route: RemoteRouteContext): Promise<Response> => {
    conductedProject(route.params.repoKey ?? "");
    await book.refresh();
    const rows = book.rows();
    return remoteJson({
      rows,
      ...(book.failure !== null ? { failure: book.failure } : {}),
      stale: rows.some(row => row.freshness === "stale"),
    });
  };

  const merge = async (route: RemoteRouteContext): Promise<Response> => {
    const headOid = requiredString(bodyObject(await route.body()), "headOid");
    conductedProject(route.params.repoKey ?? "");
    if (!isSHA(headOid)) throw new RemoteError("bad_request", "headOid mal formé");
    const slug = route.params.slug ?? "";
    const row = book.rows().find(candidate => candidate.slug === slug);
    if (row === undefined) throw new RemoteError("not_found", "PR inconnue");
    // Une adresse de PR invalide est un refus (404), jamais le 500 qu'une relecture en échec produirait.
    if (validatedPRURL(row.url) === null) throw new RemoteError("not_found", "adresse de PR invalide");
    const binary = refuseIfGhMissing(ctx.env);

    await book.beginMerge(slug, binary);
    const proposal = book.pendingMerge;
    if (proposal === null) {
      if (book.actionFailure !== null) throw new RemoteError("conflict", book.actionFailure);
      if (book.failure !== null) throw new RemoteError("server", book.failure);
      throw new RemoteError("not_found", "PR inconnue");
    }
    if (proposal.headOid !== headOid) {
      book.cancelMerge();
      throw new RemoteError("conflict", "la PR a changé depuis la demande ; relisez-la");
    }
    await book.confirmMerge(binary);
    if (book.actionFailure !== null) throw new RemoteError("server", book.actionFailure);
    const number = proposal.number ?? row.number;
    return remoteJson({ merged: true, ...(number !== undefined ? { number } : {}), url: row.url });
  };

  /** Le rafraîchissement manuel : lancé SANS être attendu, accepté même quand `gh` est absent. */
  const refresh = (): Response => {
    void states().refresh();
    return remoteJson({ accepted: true }, 202);
  };

  return [
    { method: "GET", path: "v1/projects/:repoKey/pull-requests", handle: list },
    { method: "POST", path: "v1/projects/:repoKey/pull-requests/:slug/merge", handle: merge },
    { method: "POST", path: "v1/pull-request-states/refresh", handle: refresh },
  ];
}
