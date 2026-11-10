// La vigie : un process à part (conteneur `vigie`), 24/24, qui regarde le harness « en
// shadow » et orchestre lui-même la correction de ce qu'il trouve, sous les gardes du
// serveur (vigie/desk.ts) — jamais les siennes.
//
// Elle relève : le flux d'événements (repris au dernier `id`), le journal structuré
// (contrat C1, en lecture seule), la santé et l'état du harness (mémoire, écritures
// perdues), la CI de `main` (API GitHub publique) et son propre constat de silence du
// harness. Chaque signal prend une empreinte (vigie/fingerprint.ts) et part en incident ;
// une empreinte nouvelle est triée par une session omp au contexte borné (événements et
// journal ±5 min, le run concerné, l'historique de main, les bugs connus de la mémoire).
// Un bug devient une issue (`issue_create`, caviardée par le serveur) ; en mode `fix`, sa
// correction est lancée (`issue_fix`) et pilotée : quand le run attend, une session tranche
// ce qui est réversible (`run_validate`, `run_retry` avec consigne) ou rend la main.
//
// Son état (curseur du flux, positions dans le journal, signaux en attente d'un harness
// injoignable, gestes passés) vit dans `<workDir>/state.json` : un redémarrage reprend.
import * as fs from "node:fs";
import * as path from "node:path";
import type { EventRow, VigieTriage } from "../db.ts";
import type { HumanWait, StepKind } from "../machine.ts";
import { humanWaitOf } from "../machine.ts";
import type { Oracle } from "../oracle.ts";
import { renderMemories } from "../oracle.ts";
import { HUMAN_ONLY, PILOT_ACTIONS } from "../pilot.ts";
import type { Exec } from "../proc.ts";
import type { HarnessApi } from "./api.ts";
import { HarnessUnreachable } from "./api.ts";
import type { CiRun, LogLine, Observed } from "./collect.ts";
import {
  parseLogLine,
  signalOfEvent,
  signalOfHealth,
  signalOfLogLine,
  signalsOfCi,
  signalsOfStatus,
} from "./collect.ts";
import type { VigieMode, VigieSettings } from "./desk.ts";
import { DEFAULT_VIGIE_SETTINGS, HEARTBEAT_MS, SILENT_MS, VIGIE_MODES } from "./desk.ts";
import { fingerprintOf } from "./fingerprint.ts";
import { record, textOf } from "./json.ts";
import type { OmpSettings, SpawnOmp } from "./triage.ts";
import { ACT_TOOL, VERDICT_TOOL, pilotPrompt, runSession, sessionEnv, triagePrompt } from "./triage.ts";

/** La fenêtre du contexte d'un tri, de part et d'autre du signal. */
export const CONTEXT_WINDOW_MS = 5 * 60_000;
/** Les gestes de la vigie sur un même run de correction avant de rendre la main. */
export const MAX_PILOT_ACTIONS = 3;
const RING_MAX = 3000;
const RING_AGE_MS = 30 * 60_000;
const PENDING_MAX = 500;
const CONTEXT_LINES = 60;
const LOG_READ_MAX = 4 * 1024 * 1024;
const REPOS_TTL_MS = 10 * 60_000;
const CADENCE = { logs: 15_000, health: 60_000, pilot: 30_000, ci: 10 * 60_000, reconnect: 5_000, save: 2_000 };

export type VigieOptions = {
  api: HarnessApi;
  oracle: Oracle | null;
  spawn: SpawnOmp;
  exec: Exec;
  omp: OmpSettings;
  /** Son état et le dossier de travail des sessions. */
  workDir: string;
  /** Le journal structuré du harness (`<dataDir>/logs`, en lecture seule), ou `null`. */
  logsDir: string | null;
  /** Les clones des dépôts (`<racine>/repos`, en lecture seule) : `git log` et lecture du code. */
  reposDir: string | null;
  /** Les derniers runs de workflow de `main` d'un dépôt GitHub. */
  ci: (slug: string) => Promise<CiRun[]>;
  version: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  log?: (line: string) => void;
};

type VigieState = {
  cursor: number | null;
  logs: Record<string, number>;
  /** Les écritures perdues de la mémoire déjà vues (-1 : pas encore lues). */
  lost: number;
  /** Les signaux relevés pendant que le harness ne répondait pas. */
  pending: Observed[];
  /** Les gestes de la vigie par run de correction : la dernière révision traitée et leur nombre. */
  piloted: Record<string, { rev: number; actions: number; history: string[] }>;
};

/**
 * `space` : l'espace (client) auquel appartient le dépôt (`GET /v1/spaces`) ; `null` : hors de tout espace.
 * `localOnly`, `providers` : sa politique de modèles croisée avec celle de son espace (`GET /v1/repos` →
 * `policy`) — « local-only », et sa liste blanche de fournisseurs (`null` : aucune).
 */
type RepoInfo = {
  name: string;
  scope: string;
  mainBranch: string;
  github: string | null;
  space: string | null;
  localOnly: boolean;
  providers: string[] | null;
};

/** Ce que dit un incident gardé sans tri parce que les espaces du serveur sont illisibles. */
const UNTRIAGED_BLIND =
  "non trié : politique de l'espace — les espaces du serveur sont illisibles, rien n'est envoyé au modèle";

/** L'espace du dépôt `name` ; `null` : hors de tout espace, ou dépôt inconnu. */
function spaceOfRepo(repos: readonly RepoInfo[], name: string): string | null {
  return repos.find((repo) => repo.name === name)?.space ?? null;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Le tri rendu par `vigie_verdict`, et le dépôt que la session désigne (`null` : celui du prompt). */
export type VigieVerdict = VigieTriage & { repo: string | null };

/** Le tri tel que `vigie_verdict` le rend, ou `null` s'il n'est pas lisible. */
export function verdictOf(args: Record<string, unknown>): VigieVerdict | null {
  if (args.verdict !== "noise" && args.verdict !== "bug") return null;
  return {
    verdict: args.verdict,
    title: textOf(args.title),
    symptom: textOf(args.symptom),
    evidence: strings(args.evidence),
    hypothesis: textOf(args.hypothesis),
    files: strings(args.files),
    criteria: strings(args.criteria).slice(0, 12),
    repo: textOf(args.repo) || null,
  };
}

/** Le corps de l'issue d'un bug : de quoi le comprendre, et ses critères `AC-n` (la voie directe du harness). */
export function issueBody(
  triage: VigieTriage,
  signal: { source: string; location: string; count: number; firstAt: number },
): string {
  const list = (items: string[], code = false) =>
    items.length === 0 ? "(aucun)" : items.map((item) => `- ${code ? `\`${item}\`` : item}`).join("\n");
  return [
    "## Symptôme",
    triage.symptom || triage.title,
    "## Preuves",
    list(triage.evidence),
    "## Hypothèse de cause",
    triage.hypothesis || "(non établie)",
    "## Fichiers probables",
    list(triage.files, true),
    "## Critères d'acceptation",
    triage.criteria.length > 0
      ? triage.criteria.map((criterion, index) => `- AC-${index + 1} : ${criterion}`).join("\n")
      : `- AC-1 : le symptôme « ${triage.title} » ne se reproduit plus, prouvé par un test`,
    "---",
    `Relevé par la vigie d'omp-harness : source \`${signal.source}\`, emplacement \`${signal.location}\`, ${signal.count} occurrence(s) depuis le ${new Date(signal.firstAt).toISOString()}.`,
  ].join("\n\n");
}

export class Vigie {
  readonly #api: HarnessApi;
  readonly #options: VigieOptions;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #stateFile: string;
  #state: VigieState;
  #fresh = false;
  #settings: VigieSettings | null = null;
  readonly #events: EventRow[] = [];
  readonly #logLines: LogLine[] = [];
  #downSince: number | null = null;
  #triaging: Promise<void> = Promise.resolve();
  readonly #inflight = new Set<string>();
  #repos: { at: number; list: RepoInfo[] } | null = null;
  /** Les espaces (ou les dépôts d'un serveur qui a des espaces) n'ont pas pu être lus : aucun tri (`#reposInfo`). */
  #blind = false;
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #abort = new AbortController();
  #saveTimer: NodeJS.Timeout | null = null;
  #stream: Promise<void> = Promise.resolve();

  constructor(options: VigieOptions) {
    this.#options = options;
    this.#api = options.api;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.error(`[omp-vigie] ${line}`));
    fs.mkdirSync(options.workDir, { recursive: true });
    this.#stateFile = path.join(options.workDir, "state.json");
    this.#state = this.#load();
  }

  #load(): VigieState {
    const empty: VigieState = { cursor: null, logs: {}, lost: -1, pending: [], piloted: {} };
    try {
      const raw = record(JSON.parse(fs.readFileSync(this.#stateFile, "utf8")));
      return {
        cursor: typeof raw.cursor === "number" ? raw.cursor : null,
        logs: Object.fromEntries(
          Object.entries(record(raw.logs)).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
        ),
        lost: typeof raw.lost === "number" ? raw.lost : -1,
        pending: (Array.isArray(raw.pending) ? raw.pending : [])
          .map(record)
          .filter(
            (entry) =>
              typeof entry.source === "string" && typeof entry.message === "string" && typeof entry.at === "number",
          )
          .map((entry) => ({
            source: textOf(entry.source),
            location: textOf(entry.location),
            message: textOf(entry.message),
            at: entry.at as number,
            repo: textOf(entry.repo) || null,
            runId: textOf(entry.runId) || null,
            context: textOf(entry.context),
          }))
          .slice(-PENDING_MAX),
        piloted: Object.fromEntries(
          Object.entries(record(raw.piloted)).map(([runId, value]) => {
            const entry = record(value);
            return [
              runId,
              { rev: Number(entry.rev), actions: Number(entry.actions) || 0, history: strings(entry.history) },
            ];
          }),
        ),
      };
    } catch {
      this.#fresh = true;
      return empty;
    }
  }

  /** L'état écrit (fichier temporaire puis renommage : jamais à moitié). */
  save(): void {
    clearTimeout(this.#saveTimer ?? undefined);
    this.#saveTimer = null;
    const temp = `${this.#stateFile}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.#state)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.#stateFile);
  }

  #saveSoon(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => this.save(), CADENCE.save);
    this.#saveTimer.unref?.();
  }

  get settings(): VigieSettings | null {
    return this.#settings;
  }

  get mode(): VigieMode {
    return this.#settings?.mode ?? "off";
  }

  /** Les signaux gardés pendant que le harness ne répondait pas. */
  get pending(): readonly Observed[] {
    return this.#state.pending;
  }

  // -- cycle de vie ---------------------------------------------------------------

  /** Le premier battement, le point de départ (sans rejouer l'histoire), puis les boucles. */
  async start(): Promise<void> {
    await this.beat();
    if (this.#state.cursor === null) await this.#startCursor();
    if (this.#fresh) this.#skipExistingLogs();
    this.save();
    this.#every(HEARTBEAT_MS, () => this.beat());
    this.#every(CADENCE.logs, () => this.pollLogs());
    this.#every(CADENCE.health, () => this.pollHealth());
    this.#every(CADENCE.pilot, () => this.pilot());
    this.#every(CADENCE.ci, () => this.pollCi());
    void this.pollCi();
    this.#stream = this.#follow();
    this.#log(`vigie ${this.#options.version} démarrée (mode ${this.mode})`);
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    for (const timer of this.#timers) clearInterval(timer);
    await this.#stream.catch(() => {});
    await this.idle();
    this.save();
  }

  /** Attend les tris en cours. */
  idle(): Promise<void> {
    return this.#triaging;
  }

  #every(ms: number, fn: () => Promise<unknown>): void {
    let running = false;
    const timer = setInterval(() => {
      if (running || this.#abort.signal.aborted) return;
      running = true;
      void fn()
        .catch((err) => this.#log(err instanceof Error ? err.message : String(err)))
        .finally(() => {
          running = false;
        });
    }, ms);
    timer.unref?.();
    this.#timers.push(timer);
  }

  /** Le curseur du journal à l'instant : une vigie neuve ne rejoue pas l'histoire du harness. */
  async #startCursor(): Promise<void> {
    try {
      const inbox = await this.#api.json("GET", "/v1/inbox");
      if (typeof inbox.cursor === "number") this.#state.cursor = inbox.cursor;
    } catch (err) {
      this.#log(
        `curseur de départ illisible (${err instanceof Error ? err.message : String(err)}) : le flux part du début`,
      );
    }
  }

  #skipExistingLogs(): void {
    const dir = this.#options.logsDir;
    if (!dir || !fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")))
      this.#state.logs[file] = fs.statSync(path.join(dir, file)).size;
  }

  async #follow(): Promise<void> {
    const signal = this.#abort.signal;
    while (!signal.aborted) {
      try {
        for await (const event of this.#api.events(this.#state.cursor ?? 0, signal)) await this.ingest(event);
      } catch (err) {
        if (signal.aborted) return;
        if (!(err instanceof HarnessUnreachable))
          this.#log(`flux : ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CADENCE.reconnect);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  // -- battement et santé -----------------------------------------------------------

  /** Le battement de cœur : la vigie est vivante, elle reçoit ses réglages. `false` : harness injoignable. */
  async beat(): Promise<boolean> {
    try {
      const reply = await this.#api.json("POST", "/v1/vigie/heartbeat", { version: this.#options.version });
      const settings = record(reply.settings);
      const count = (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback);
      // Un mode illisible : la vigie se tait (échec fermé), elle ne publie ni ne corrige.
      this.#settings = {
        mode: VIGIE_MODES.find((mode) => mode === settings.mode) ?? "off",
        maxIssuesPerDay: count(settings.maxIssuesPerDay, DEFAULT_VIGIE_SETTINGS.maxIssuesPerDay),
        maxLiveRuns: count(settings.maxLiveRuns, DEFAULT_VIGIE_SETTINGS.maxLiveRuns),
        dailyBudgetUsd: count(settings.dailyBudgetUsd, DEFAULT_VIGIE_SETTINGS.dailyBudgetUsd),
        repos: strings(settings.repos),
      };
      await this.#back();
      return true;
    } catch (err) {
      if (err instanceof HarnessUnreachable) this.#downSince ??= this.#now();
      else this.#log(`battement refusé : ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Le harness répond de nouveau : son silence devient un signal s'il a duré, les signaux gardés partent. */
  async #back(): Promise<void> {
    if (this.#downSince === null) return;
    const since = this.#downSince;
    this.#downSince = null;
    const now = this.#now();
    if (now - since >= SILENT_MS)
      await this.observe({
        source: "harness",
        location: "API du harness",
        message: "le harness ne répondait plus à la vigie",
        at: since,
        repo: null,
        runId: null,
        context: `injoignable de ${new Date(since).toISOString()} à ${new Date(now).toISOString()} (${Math.round((now - since) / 60_000)} min)`,
      });
    const pending = this.#state.pending;
    this.#state.pending = [];
    for (const observed of pending) await this.observe(observed);
    this.#saveSoon();
  }

  /** `GET /v1/health` et `GET /v1/status` : vérifications en échec, mémoire injoignable, écritures perdues. */
  async pollHealth(): Promise<void> {
    const now = this.#now();
    let health: { status: number; body: Record<string, unknown> };
    try {
      health = await this.#api.health();
    } catch (err) {
      if (err instanceof HarnessUnreachable) this.#downSince ??= now;
      return;
    }
    await this.#back();
    const unhealthy = signalOfHealth(health.status === 200 ? health.body : { ...health.body, ok: false }, now);
    if (unhealthy) await this.observe(unhealthy);
    const status = await this.#api.json("GET", "/v1/status");
    const count = record(record(status.oracle).lostWrites).count;
    if (this.#state.lost < 0 && typeof count === "number") this.#state.lost = count;
    const { signals, lost } = signalsOfStatus(status, this.#state.lost, now);
    this.#state.lost = lost;
    for (const signal of signals) await this.observe(signal);
    this.#saveSoon();
  }

  // -- collecte -----------------------------------------------------------------------

  /** Un événement du flux : gardé pour le contexte, relevé s'il dit un dysfonctionnement. */
  async ingest(event: EventRow): Promise<void> {
    if (event.ephemeral) return;
    this.#events.push(event);
    this.#trim(this.#events, event.at);
    if (this.#state.cursor === null || event.id > this.#state.cursor) this.#state.cursor = event.id;
    this.#saveSoon();
    const signal = signalOfEvent(event);
    if (signal) await this.observe(signal);
  }

  #trim(ring: { at: number }[], now: number): void {
    while (ring.length > RING_MAX || (ring.length > 0 && now - (ring[0] as { at: number }).at > RING_AGE_MS))
      ring.shift();
  }

  /** Les lignes ajoutées au journal structuré depuis la dernière lecture (lignes complètes seulement). */
  async pollLogs(): Promise<void> {
    const dir = this.#options.logsDir;
    if (!dir || !fs.existsSync(dir)) return;
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    for (const known of Object.keys(this.#state.logs)) if (!files.includes(known)) delete this.#state.logs[known];
    for (const file of files) {
      const full = path.join(dir, file);
      const size = fs.statSync(full).size;
      let offset = this.#state.logs[file] ?? 0;
      if (size < offset) offset = 0;
      if (size === offset) continue;
      const length = Math.min(size - offset, LOG_READ_MAX);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(full, "r");
      try {
        fs.readSync(fd, buffer, 0, length, offset);
      } finally {
        fs.closeSync(fd);
      }
      const end = buffer.lastIndexOf(0x0a);
      if (end < 0) continue;
      this.#state.logs[file] = offset + end + 1;
      for (const raw of buffer.subarray(0, end).toString("utf8").split("\n")) {
        const line = parseLogLine(raw);
        if (!line) continue;
        this.#logLines.push(line);
        this.#trim(this.#logLines, line.at);
        const signal = signalOfLogLine(line);
        if (signal) await this.observe(signal);
      }
    }
    this.#saveSoon();
  }

  /** La CI de `main` de chaque dépôt de la vigie : un workflow rouge est un signal. */
  async pollCi(): Promise<void> {
    const settings = this.#settings;
    if (!settings || settings.mode === "off") return;
    const repos = await this.#reposInfo();
    for (const name of settings.repos) {
      const github = repos.find((repo) => repo.name === name)?.github;
      if (!github) continue;
      let runs: CiRun[];
      try {
        runs = await this.#options.ci(github);
      } catch (err) {
        this.#log(`CI de ${github} illisible : ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const signal of signalsOfCi(github, runs, this.#now())) await this.observe({ ...signal, repo: name });
    }
  }

  /**
   * Les dépôts du harness, chacun avec son espace et sa politique de modèles. Les espaces d'abord : s'ils
   * sont illisibles alors que le serveur en sert (`#servesSpaces`), ou si les dépôts le sont alors qu'un
   * espace existe, la vigie est AVEUGLE (`#blind`) — elle ne sait plus à qui est un dépôt : aucun tri,
   * rien en cache, la lecture suivante réessaie. Un serveur sans la capacité, ou sans espace : comme avant.
   */
  async #reposInfo(): Promise<RepoInfo[]> {
    if (this.#repos && this.#now() - this.#repos.at < REPOS_TTL_MS) return this.#repos.list;
    // L'espace de chaque dépôt : un incident n'est publié que dans l'espace du dépôt observé.
    const spaces = new Map<string, string>();
    this.#blind = false;
    try {
      const answer = await this.#api.json("GET", "/v1/spaces");
      for (const raw of Array.isArray(answer.spaces) ? answer.spaces : []) {
        const space = record(raw);
        for (const repo of strings(space.repos)) spaces.set(repo, textOf(space.id));
      }
    } catch (err) {
      this.#blind = await this.#servesSpaces();
      this.#log(`espaces illisibles : ${err instanceof Error ? err.message : String(err)}`);
    }
    let listed: Record<string, unknown>;
    try {
      listed = await this.#api.json("GET", "/v1/repos");
    } catch (err) {
      this.#blind = this.#blind || spaces.size > 0;
      throw err;
    }
    const github = new Map<string, string | null>();
    try {
      const mcp = await this.#api.tool("repos_list", {});
      for (const raw of Array.isArray(mcp.repos) ? mcp.repos : []) {
        const repo = record(raw);
        github.set(textOf(repo.name), textOf(repo.github) || null);
      }
    } catch (err) {
      this.#log(`dépôts GitHub illisibles : ${err instanceof Error ? err.message : String(err)}`);
    }
    const list = (Array.isArray(listed.repos) ? listed.repos : []).map((raw) => {
      const repo = record(raw);
      const name = textOf(repo.name);
      const policy = record(repo.policy);
      return {
        name,
        scope: textOf(repo.scope),
        mainBranch: textOf(repo.mainBranch) || "main",
        github: github.get(name) ?? null,
        space: spaces.get(name) ?? null,
        localOnly: policy.privacy === "local-only",
        providers: Array.isArray(policy.providers) ? strings(policy.providers) : null,
      };
    });
    if (!this.#blind) this.#repos = { at: this.#now(), list };
    return list;
  }

  /** Le serveur sert-il les espaces (`GET /v1/health` → `features`) ? Sans réponse : oui (échec fermé). */
  async #servesSpaces(): Promise<boolean> {
    try {
      return strings((await this.#api.health()).body.features).includes("spaces");
    } catch {
      return true;
    }
  }

  // -- incidents et tri -----------------------------------------------------------

  /**
   * Un signal devient une occurrence d'incident. Harness injoignable : gardé pour plus tard.
   * Une empreinte nouvelle (le serveur dit `triage: needed`) part au tri, un à la fois.
   */
  async observe(observed: Observed): Promise<void> {
    if (this.mode === "off") return;
    const fingerprint = fingerprintOf(observed);
    let outcome: Record<string, unknown>;
    try {
      outcome = await this.#api.json("POST", "/v1/vigie/incidents", {
        fingerprint,
        source: observed.source,
        location: observed.location,
        message: observed.message,
        at: observed.at,
        repo: observed.repo,
        runId: observed.runId,
        context: observed.context,
      });
    } catch (err) {
      if (err instanceof HarnessUnreachable) {
        this.#downSince ??= this.#now();
        this.#state.pending = [...this.#state.pending, observed].slice(-PENDING_MAX);
        this.#saveSoon();
      } else this.#log(`incident ${fingerprint} refusé : ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (outcome.triage !== "needed" || this.#inflight.has(fingerprint)) return;
    this.#inflight.add(fingerprint);
    const incident = record(outcome.incident);
    this.#triaging = this.#triaging
      .then(() => this.#triage(fingerprint, observed, incident))
      .catch((err) => this.#log(`tri de ${fingerprint} : ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.#inflight.delete(fingerprint));
  }

  /**
   * Le dépôt d'un incident : le sien s'il est à la vigie, celui du tri, sinon le premier de la vigie —
   * toujours dans l'ESPACE du dépôt observé (`candidates[0]`) quand il est connu : jamais le repli sur le
   * dépôt d'un autre espace. Sans dépôt de la vigie dans l'espace : le dépôt observé lui-même (le serveur
   * retient alors l'issue, hors de ses dépôts permis : l'incident reste non publié), sinon `null`.
   */
  #targetRepo(candidates: (string | null)[], settings: VigieSettings, repos: RepoInfo[]): string | null {
    const observed = candidates[0] ?? null;
    const same = (name: string): boolean =>
      observed === null || spaceOfRepo(repos, name) === spaceOfRepo(repos, observed);
    for (const candidate of candidates)
      if (candidate && settings.repos.includes(candidate) && same(candidate)) return candidate;
    return (
      settings.repos.find(same) ??
      candidates.find((candidate): candidate is string => candidate !== null && same(candidate)) ??
      repos.find((repo) => same(repo.name))?.name ??
      null
    );
  }

  /**
   * Pourquoi rien de ce dépôt ne part au modèle de la vigie, ou `null` : sa politique de modèles croisée
   * avec celle de son espace (`GET /v1/repos` → `policy`) est « local-only », ou sa liste blanche de
   * fournisseurs n'a pas celui du modèle de la vigie (`VIGIE_MODEL` ; sans lui, le fournisseur est
   * inconnu : refusé). Un dépôt sans politique, ou inconnu : `null`.
   */
  #barred(repos: readonly RepoInfo[], name: string | null): string | null {
    const repo = name === null ? undefined : repos.find((candidate) => candidate.name === name);
    if (repo === undefined || (!repo.localOnly && repo.providers === null)) return null;
    const model = this.#options.omp.model;
    const provider = model?.includes("/") ? model.slice(0, model.indexOf("/")) : null;
    if (!repo.localOnly && provider !== null && repo.providers?.includes(provider)) return null;
    const whose = repo.space === null ? "politique de modèles du dépôt" : "politique de l'espace";
    const why = repo.localOnly
      ? "« local-only », rien ne part chez un fournisseur"
      : `fournisseurs permis : ${repo.providers?.join(", ") || "aucun"} — le modèle de la vigie (${model ?? "celui d'omp"}) n'en est pas`;
    return `non trié : ${whose} — ${repo.name} est ${why}`;
  }

  async #triage(fingerprint: string, observed: Observed, incident: Record<string, unknown>): Promise<void> {
    const settings = this.#settings ?? DEFAULT_VIGIE_SETTINGS;
    const repos = await this.#reposInfo().catch(() => [] as RepoInfo[]);
    const target = this.#targetRepo([observed.repo], settings, repos);
    // Le dépôt de l'incident : celui du signal, sinon celui que le serveur lui a trouvé (son run).
    const source = observed.repo ?? (textOf(incident.repo) || null);
    // Aucun envoi au modèle quand la politique de modèles du dépôt observé (ou du dépôt à corriger, dont
    // le code serait lu) ne permet pas celui de la vigie, ni quand les espaces sont illisibles : l'incident
    // est gardé, non trié, et le dit.
    const untriaged = this.#blind ? UNTRIAGED_BLIND : (this.#barred(repos, source) ?? this.#barred(repos, target));
    if (untriaged !== null) {
      if (textOf(incident.note) !== untriaged)
        await this.#api.json("POST", "/v1/vigie/incidents", { fingerprint, untriaged });
      this.#log(`incident ${fingerprint} ${untriaged}`);
      return;
    }
    const info = repos.find((repo) => repo.name === target) ?? null;
    const clone = info && this.#options.reposDir ? path.join(this.#options.reposDir, info.name) : null;
    let verdict: VigieVerdict | null = null;
    const count = typeof incident.count === "number" ? incident.count : 1;
    const firstAt = typeof incident.firstAt === "number" ? incident.firstAt : observed.at;
    // Ce qui entoure le signal : jamais le journal d'un dépôt d'un AUTRE espace que celui du dépôt observé,
    // ni celui d'un dépôt dont la politique de modèles ne permet pas le modèle de la vigie.
    const around = (repo: string | null | undefined): boolean => {
      if (repo === null || repo === undefined) return true;
      if (this.#barred(repos, repo) !== null) return false;
      const space = spaceOfRepo(repos, repo);
      return source === null || space === null || space === spaceOfRepo(repos, source);
    };
    const prompt = triagePrompt({
      repo: target,
      repos: settings.repos.filter(
        (name) => source === null || spaceOfRepo(repos, name) === spaceOfRepo(repos, source),
      ),
      clone: clone && fs.existsSync(clone) ? clone : null,
      signal: { ...observed, count, firstAt },
      events: this.#around(this.#events, observed.at)
        .filter((event) => around(event.repo))
        .map(
          (event) =>
            `${new Date(event.at).toISOString()} ${event.type}${event.runId ? ` run ${event.runId}` : ""} ${clip(JSON.stringify(event.payload), 240)}`,
        ),
      logs: this.#around(this.#logLines, observed.at)
        .filter((line) => around(line.repo))
        .map(
          (line) =>
            `${line.ts} [${line.level}] ${line.src} ${clip(line.msg, 300)}${line.err ? ` — ${clip(line.err.message, 300)}` : ""}`,
        ),
      run: observed.runId ? await this.#runSummary(observed.runId) : null,
      gitLog: clone && info ? await this.#gitLog(clone, info.mainBranch) : "",
      memories: info ? await this.#recall(info.scope, `${observed.message}\n${observed.location}`) : "",
    });
    const session = await runSession({
      spawn: this.#options.spawn,
      omp: this.#options.omp,
      cwd: this.#scratch(),
      env: sessionEnv(this.#options.env ?? process.env),
      tools: [VERDICT_TOOL],
      prompt,
      nudge: "Ton verdict n'a pas été rendu : appelle `vigie_verdict`, une fois, puis termine.",
      decided: () => verdict !== null,
      onTool: async (name, args) => {
        if (name !== VERDICT_TOOL.name) return { text: `outil inconnu : ${name}`, isError: true };
        if (verdict !== null) return { text: "ton verdict est déjà rendu : termine ton tour.", isError: true };
        const parsed = verdictOf(args);
        if (!parsed) return { text: "verdict : `noise` ou `bug`", isError: true };
        if (parsed.verdict === "bug" && (parsed.title === "" || parsed.symptom === "" || parsed.criteria.length === 0))
          return { text: "un bug porte un titre, un symptôme et au moins un critère d'acceptation", isError: true };
        verdict = parsed;
        return { text: "verdict noté. Termine ton tour." };
      },
    });
    const decided = verdict as VigieVerdict | null;
    if (decided === null) {
      this.#log(`tri de ${fingerprint} sans verdict (${session.error ?? "aucun appel de vigie_verdict"})`);
      return;
    }
    const { repo: chosen, ...triage } = decided;
    const posted = await this.#api.json("POST", "/v1/vigie/incidents", {
      fingerprint,
      triage: { ...triage, costUsd: session.costUsd },
    });
    if (triage.verdict !== "bug") return;
    const repo = this.#targetRepo([observed.repo, chosen], this.#settings ?? settings, repos);
    if (repo === null) return;
    const current = record(posted.incident);
    const published = await this.#api.tool("issue_create", {
      repo,
      title: `[vigie] ${triage.title}`,
      body: issueBody(triage, {
        source: observed.source,
        location: observed.location,
        count: typeof current.count === "number" ? current.count : count,
        firstAt,
      }),
      fingerprint,
    });
    const issue = record(published.issue);
    this.#log(
      `bug ${fingerprint} : issue ${published.status}${issue.url ? ` ${issue.url}` : ""}${published.reason ? ` (${published.reason})` : ""}`,
    );
    if (this.mode !== "fix" || typeof issue.number !== "number") return;
    try {
      const fixed = await this.#api.tool("issue_fix", { repo, number: issue.number });
      this.#log(`bug ${fingerprint} : correction ${textOf(record(fixed.run).id)} lancée`);
    } catch (err) {
      this.#log(`bug ${fingerprint} : correction refusée — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #around<T extends { at: number }>(ring: readonly T[], at: number): T[] {
    return ring.filter((item) => Math.abs(item.at - at) <= CONTEXT_WINDOW_MS).slice(-CONTEXT_LINES);
  }

  #scratch(): string {
    const dir = path.join(this.#options.workDir, "session");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async #runSummary(runId: string): Promise<string | null> {
    try {
      const view = await this.#api.json("GET", `/v1/runs/${encodeURIComponent(runId)}`);
      const run = record(view.run);
      const steps = (Array.isArray(view.steps) ? view.steps : []).slice(-8).map((raw) => {
        const step = record(raw);
        return `- /${textOf(step.kind)} tentative ${String(step.attempt ?? "?")} : ${textOf(step.status)}${textOf(step.summary) ? ` — ${clip(textOf(step.summary), 200)}` : ""}`;
      });
      const session = await this.#api
        .json("GET", `/v1/runs/${encodeURIComponent(runId)}/session?limit=30`)
        .catch(() => ({}));
      const entries = (Array.isArray(record(session).entries) ? (record(session).entries as unknown[]) : []).map(
        (raw) => {
          const entry = record(raw);
          return `  ${textOf(entry.kind)}${textOf(entry.tool) ? ` ${textOf(entry.tool)}` : ""} ${clip(textOf(entry.text) || textOf(entry.headline), 200)}`;
        },
      );
      return [
        `« ${textOf(run.title)} » (${textOf(run.repo)}, ${textOf(run.slug)}) : ${textOf(run.state)} à l'étape ${textOf(run.step) || "?"}`,
        `raison : ${textOf(run.reason) || "(aucune)"}`,
        ...steps,
        ...(entries.length > 0 ? ["Dernières entrées de sa session :", ...entries] : []),
      ].join("\n");
    } catch (err) {
      return `(run ${runId} illisible : ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  async #gitLog(clone: string, branch: string): Promise<string> {
    if (!fs.existsSync(clone)) return "";
    const result = await this.#options.exec(
      "git",
      ["-c", "safe.directory=*", "-C", clone, "log", "--oneline", "--no-decorate", "-n", "20", branch],
      { timeoutMs: 15_000 },
    );
    return result.code === 0 ? result.stdout.trim() : `(git log illisible : ${clip(result.stderr.trim(), 200)})`;
  }

  async #recall(scope: string, query: string): Promise<string> {
    if (!this.#options.oracle || scope === "") return "";
    try {
      return renderMemories(await this.#options.oracle.recall(scope, query, 5));
    } catch {
      return "(la mémoire n'a pas répondu)";
    }
  }

  // -- pilotage des corrections -----------------------------------------------------

  /** Les runs de correction de la vigie qui attendent : tranchés s'ils sont réversibles, sinon rendus à l'humain. */
  async pilot(): Promise<void> {
    if (this.mode !== "fix") return;
    const listed = await this.#api.json("GET", "/v1/vigie/incidents?status=fixing");
    for (const raw of Array.isArray(listed.incidents) ? listed.incidents : []) {
      const incident = record(raw);
      const fingerprint = textOf(incident.fingerprint);
      const runId = textOf(incident.fixRunId);
      if (fingerprint === "" || runId === "") continue;
      let view: Record<string, unknown>;
      try {
        view = await this.#api.tool("run_get", { id: runId });
      } catch (err) {
        this.#log(`run ${runId} illisible : ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const run = record(view.run);
      const rev = typeof run.rev === "number" ? run.rev : -1;
      const past = this.#state.piloted[runId] ?? { rev: -1, actions: 0, history: [] };
      if (past.rev === rev) continue;
      const state = textOf(run.state);
      if (state === "escalated") {
        await this.#defer(
          fingerprint,
          "une escalade (schema, public_api, deletion) attend l'humain : la vigie n'y répond pas",
        );
        continue;
      }
      if (state !== "awaiting_human") continue;
      const wait = humanWaitOf({
        state: "awaiting_human",
        step: (textOf(run.step) || null) as StepKind | null,
        reason: textOf(run.reason) || null,
      });
      if (wait === null) continue;
      const humanOnly = HUMAN_ONLY[wait];
      if (humanOnly !== undefined) {
        await this.#defer(fingerprint, humanOnly);
        continue;
      }
      if (past.actions >= MAX_PILOT_ACTIONS) {
        await this.#defer(fingerprint, `la vigie a déjà agi ${MAX_PILOT_ACTIONS} fois sur ce run : à toi de trancher`);
        continue;
      }
      // La politique de modèles du dépôt (ou des espaces illisibles) : rien ne part au modèle, l'humain tranche.
      const repos = await this.#reposInfo().catch(() => [] as RepoInfo[]);
      const bar = this.#blind ? UNTRIAGED_BLIND : this.#barred(repos, textOf(run.repo) || null);
      if (bar !== null) {
        await this.#defer(fingerprint, bar.replace("non trié", "non piloté"));
        continue;
      }
      await this.#pilotRun(fingerprint, incident, view, wait, rev, past);
    }
  }

  async #defer(fingerprint: string, reason: string): Promise<void> {
    await this.#api.json("POST", "/v1/vigie/incidents", { fingerprint, defer: reason });
  }

  async #pilotRun(
    fingerprint: string,
    incident: Record<string, unknown>,
    view: Record<string, unknown>,
    wait: HumanWait,
    rev: number,
    past: { rev: number; actions: number; history: string[] },
  ): Promise<void> {
    const run = record(view.run);
    const runId = textOf(run.id);
    const allowed = PILOT_ACTIONS[wait].filter((action) => action !== "cancel");
    let act: { action: string; reason: string; instructions: string } | null = null;
    const verdict = record(run.verdict);
    const triage =
      incident.triage === null || incident.triage === undefined ? null : (verdictOf(record(incident.triage)) ?? null);
    const session = await runSession({
      spawn: this.#options.spawn,
      omp: this.#options.omp,
      cwd: this.#scratch(),
      env: sessionEnv(this.#options.env ?? process.env),
      tools: [ACT_TOOL],
      prompt: pilotPrompt({
        title: textOf(run.title),
        wait,
        reason: textOf(run.reason),
        allowed,
        run: [
          `état ${textOf(run.state)} à l'étape ${textOf(run.step) || "?"}, révision ${rev}`,
          ...(textOf(verdict.summary) ? [`verdict de la revue : ${clip(textOf(verdict.summary), 1500)}`] : []),
          ...strings(verdict.blockers).map((blocker) => `- bloquant : ${clip(blocker, 300)}`),
        ].join("\n"),
        triage,
        history: past.history,
      }),
      nudge: "Ta décision n'a pas été rendue : appelle `vigie_act`, une fois, puis termine.",
      decided: () => act !== null,
      onTool: async (name, args) => {
        if (name !== ACT_TOOL.name) return { text: `outil inconnu : ${name}`, isError: true };
        if (act !== null) return { text: "ta décision est déjà rendue : termine ton tour.", isError: true };
        const action = textOf(args.action);
        const reason = textOf(args.reason);
        if (!allowed.some((allowedAction) => allowedAction === action))
          return { text: `geste non permis ici : ${action} (permis : ${allowed.join(", ")})`, isError: true };
        if (reason === "") return { text: "`reason` est obligatoire", isError: true };
        act = { action, reason, instructions: textOf(args.instructions) };
        return { text: `${action} noté. Termine ton tour.` };
      },
    });
    const decided = act as { action: string; reason: string; instructions: string } | null;
    const remember = (line: string) => {
      this.#state.piloted[runId] = { rev, actions: past.actions + 1, history: [...past.history, line].slice(-10) };
      this.#saveSoon();
    };
    if (decided === null) {
      remember(`aucune décision (${session.error ?? "vigie_act non appelé"})`);
      await this.#defer(fingerprint, `la vigie n'a pas pu trancher (${session.error ?? "aucune décision"}) : à toi`);
      return;
    }
    try {
      if (decided.action === "approve" || decided.action === "refuse")
        await this.#api.tool("run_validate", {
          id: runId,
          approve: decided.action === "approve",
          reason: decided.reason,
          rev,
        });
      else if (decided.action === "retry")
        await this.#api.tool("run_retry", { id: runId, instructions: decided.instructions || decided.reason, rev });
      else await this.#defer(fingerprint, decided.reason);
      remember(`${decided.action} — ${decided.reason}`);
    } catch (err) {
      remember(`${decided.action} refusé — ${err instanceof Error ? err.message : String(err)}`);
      this.#log(`run ${runId} : ${decided.action} refusé — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
