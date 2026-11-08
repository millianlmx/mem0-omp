// La vigie côté serveur : ses réglages, son battement de cœur, ses incidents et TOUTES
// ses gardes. Le conteneur `vigie` (vigie/main.ts) observe et trie ; ce qui touche le
// monde passe par ici, sous les règles du serveur, jamais sous celles d'un prompt :
//
// - le mode (`off` · `shadow` · `report` · `fix`, `shadow` par défaut) : en `shadow`, tout
//   est consigné en incidents (l'issue qu'elle aurait publiée comprise), rien ne sort ;
//   en `report`, les issues sont publiées ; en `fix`, la vigie lance leur correction ;
// - les plafonds : `maxIssuesPerDay` issues publiées et `dailyBudgetUsd` dépensés (tris
//   et runs de correction) par jour UTC, `maxLiveRuns` corrections vivantes ;
// - une seule génération de correction par empreinte, et l'anti-boucle : un bug relevé
//   sur un run que la vigie a lancé (ou sur sa descendance) revient à l'humain ;
// - le caviardage de tout ce qui part sur la forge du dépôt (vigie/redact.ts) ;
// - le silence : plus de battement depuis SILENT_MS, un événement `vigie_silent` ;
// - après le merge d'une correction, l'empreinte est surveillée WATCH_MS : sans
//   récidive, l'issue est fermée et le souvenir écrit ; revenue, l'issue est rouverte
//   et l'incident rendu à l'humain.
import type { Client } from "../auth.ts";
import type { RepoConfig } from "../config.ts";
import { repoByName } from "../config.ts";
import type { Actor, HarnessContext } from "../context.ts";
import type { RepoFilter, Store, VigieIncident, VigieStatus, VigieTriage } from "../db.ts";
import { VIGIE_STATUSES } from "../db.ts";
import { HarnessError } from "../errors.ts";
import type { Forge } from "../forge.ts";
import type { IssueDesk } from "../issues.ts";
import { isTerminal } from "../machine.ts";
import { isFingerprint } from "./fingerprint.ts";
import { record } from "./json.ts";
import { redactForIssue, redactSecrets } from "./redact.ts";

export const VIGIE_MODES = ["off", "shadow", "report", "fix"] as const;
export type VigieMode = (typeof VIGIE_MODES)[number];

export type VigieSettings = {
  mode: VigieMode;
  maxIssuesPerDay: number;
  maxLiveRuns: number;
  dailyBudgetUsd: number;
  /** Les dépôts déclarés où la vigie publie et corrige ; vide : nulle part. */
  repos: string[];
};

export const DEFAULT_VIGIE_SETTINGS: VigieSettings = {
  mode: "shadow",
  maxIssuesPerDay: 5,
  maxLiveRuns: 2,
  dailyBudgetUsd: 10,
  repos: [],
};

/** Le label de toute issue publiée par `issue_create`. */
export const VIGIE_LABEL = "omp:vigie";
/** La cadence du battement de cœur de la vigie. */
export const HEARTBEAT_MS = 60_000;
/** Au-delà, la vigie est muette : `vigie_silent`. */
export const SILENT_MS = 5 * 60_000;
/** La surveillance d'une empreinte après le merge de sa correction. */
export const WATCH_MS = 24 * 60 * 60_000;
/** Un commentaire d'occurrences au plus par issue et par période. */
const COMMENT_EVERY_MS = 6 * 60 * 60_000;
/** La cadence des tours de la vigie dans le scheduling du service. */
const TICK_EVERY_MS = 30_000;
const SETTINGS_KEY = "vigie";
const HEARTBEAT_KEY = "vigie.heartbeat";
const TITLE_MAX = 200;
const BODY_MAX = 60_000;
const MESSAGE_MAX = 4_000;
const CONTEXT_MAX = 16_000;

type Heartbeat = { at: number; version: string | null; client: string; silentSince: number | null };

export type Triage = "needed" | "skip" | "budget";

export type ReportOutcome = { incident: VigieIncident; known: boolean; triage: Triage };

export type PublishOutcome = {
  status: "published" | "already" | "withheld";
  fingerprint: string;
  issue: { number: number; url: string } | null;
  /** Pourquoi rien n'est parti (`withheld`). */
  reason: string | null;
};

/** Le marqueur caché qui porte l'empreinte dans le corps d'une issue (dédoublonnage). */
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- omp-vigie:fingerprint=${fingerprint} -->`;
}

const MARKER = /<!-- omp-vigie:fingerprint=([0-9a-f]{16,64}) -->/;

/** Minuit UTC du jour de `now` : le début du jour des plafonds (comme `monitoring.dailyBudgetUsd`). */
export function dayStart(now: number): number {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

function short(value: string, max = 160): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function bounded(body: Record<string, unknown>, key: string, max: number, required: boolean): string | null {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) throw new HarnessError(400, `${key} : texte attendu`);
    return null;
  }
  if (typeof value !== "string") throw new HarnessError(400, `${key} : texte attendu`);
  const trimmed = value.trim();
  if (required && trimmed === "") throw new HarnessError(400, `${key} : texte non vide attendu`);
  return trimmed.slice(0, max);
}

function strings(value: unknown, key: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new HarnessError(400, `${key} : liste de textes attendue`);
  return (value as string[])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** Le tri rendu par la vigie, vérifié et caviardé (il finit dans une issue publique). */
function triageOf(raw: unknown): { triage: VigieTriage; costUsd: number } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new HarnessError(400, "triage : objet attendu");
  const body = record(raw);
  if (body.verdict !== "noise" && body.verdict !== "bug") throw new HarnessError(400, "triage.verdict : noise | bug");
  const cost = body.costUsd ?? 0;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
    throw new HarnessError(400, "triage.costUsd : nombre ≥ 0");
  const field = (key: string, max: number) => redactSecrets(bounded(body, key, max, false) ?? "");
  const list = (key: string, max: number) => strings(body[key], `triage.${key}`, max).map(redactSecrets);
  return {
    triage: {
      verdict: body.verdict,
      title: field("title", TITLE_MAX),
      symptom: field("symptom", 4000),
      evidence: list("evidence", 20),
      hypothesis: field("hypothesis", 4000),
      files: list("files", 30),
      criteria: list("criteria", 12),
    },
    costUsd: cost,
  };
}

export class VigieDesk {
  readonly #ctx: HarnessContext;
  readonly #issues: IssueDesk;
  /** Les écritures d'une même empreinte passent une par une (deux occurrences, deux publications). */
  readonly #pending = new Map<string, Promise<unknown>>();
  /** Les labels connus du projet de chaque dépôt sur sa forge (créés au besoin, une fois). */
  readonly #labels = new Map<string, Set<string>>();
  /** La dernière erreur journalisée par empreinte : une fermeture qui échoue revient à chaque tour. */
  readonly #errors = new Map<string, number>();
  #tickedAt = 0;
  #ticking: Promise<void> | null = null;

  constructor(ctx: HarnessContext, issues: IssueDesk) {
    this.#ctx = ctx;
    this.#issues = issues;
  }

  get #store(): Store {
    return this.#ctx.store;
  }

  #serial<T>(fingerprint: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#pending.get(fingerprint) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.#pending.set(fingerprint, next);
    void next
      .finally(() => {
        if (this.#pending.get(fingerprint) === next) this.#pending.delete(fingerprint);
      })
      .catch(() => {});
    return next;
  }

  // -- réglages et battement ----------------------------------------------------

  settings(): VigieSettings {
    const stored = this.#store.getSetting<Partial<VigieSettings>>(SETTINGS_KEY) ?? {};
    return { ...DEFAULT_VIGIE_SETTINGS, ...stored };
  }

  /** `PUT /v1/vigie` : les champs donnés remplacent les réglages (un champ inconnu : 400). */
  updateSettings(body: Record<string, unknown>, actor: Actor): VigieSettings {
    const next = this.settings();
    for (const key of Object.keys(body)) {
      if (!(key in DEFAULT_VIGIE_SETTINGS))
        throw new HarnessError(400, `${key} : réglage inconnu (${Object.keys(DEFAULT_VIGIE_SETTINGS).join(", ")})`);
    }
    if (body.mode !== undefined) {
      if (!VIGIE_MODES.some((mode) => mode === body.mode))
        throw new HarnessError(400, `mode : ${VIGIE_MODES.join(" | ")}`);
      next.mode = body.mode as VigieMode;
    }
    for (const key of ["maxIssuesPerDay", "maxLiveRuns"] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1000)
        throw new HarnessError(400, `${key} : entier entre 0 et 1000`);
      next[key] = value as number;
    }
    if (body.dailyBudgetUsd !== undefined) {
      const value = body.dailyBudgetUsd;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        throw new HarnessError(400, "dailyBudgetUsd : nombre ≥ 0 (dollars)");
      next.dailyBudgetUsd = value;
    }
    if (body.repos !== undefined) {
      const repos = strings(body.repos, "repos", 100);
      const unknown = repos.filter((name) => repoByName(this.#ctx.config, name) === null);
      if (unknown.length > 0)
        throw new HarnessError(
          400,
          `repos : dépôt(s) non déclaré(s) : ${unknown.join(", ")} (\`harness.sh add <url>\`)`,
        );
      next.repos = [...new Set(repos)];
    }
    this.#store.setSetting(SETTINGS_KEY, next, actor.by);
    this.#ctx.log(`vigie : réglages ${JSON.stringify(next)}${actor.by ? ` par ${actor.by}` : ""}`);
    return next;
  }

  #heartbeat(): Heartbeat | null {
    return this.#store.getSetting<Heartbeat>(HEARTBEAT_KEY);
  }

  /** `POST /v1/vigie/heartbeat` : la vigie est vivante ; elle reçoit ses réglages et l'état du jour. */
  heartbeat(body: Record<string, unknown>, client: Client, now: number): Record<string, unknown> {
    const before = this.#heartbeat();
    const version = bounded(body, "version", 64, false);
    this.#store.setSetting(HEARTBEAT_KEY, { at: now, version, client: client.name, silentSince: null }, client.name);
    if (before?.silentSince != null)
      this.#ctx.log(`vigie : de retour après ${Math.round((now - before.at) / 60_000)} min de silence`);
    return { settings: this.settings(), today: this.today(now) };
  }

  /** Ce que la vigie a fait et dépensé aujourd'hui (UTC), et ses corrections vivantes. */
  today(now: number): { since: number; issues: number; liveRuns: number; spentUsd: number } {
    const since = dayStart(now);
    const spend = this.#store.vigieSpendSince(since);
    const runs = spend.fixRuns.reduce((sum, runId) => sum + this.#store.runCost(runId), 0);
    return {
      since,
      issues: this.#store.countVigieIssuesSince(since),
      liveRuns: this.#liveRuns(),
      spentUsd: Math.round((spend.triage + runs) * 100) / 100,
    };
  }

  #liveRuns(): number {
    return this.#store.listVigieIncidents({ statuses: ["fixing"] }).filter((incident) => {
      const run = incident.fixRunId ? this.#store.getRun(incident.fixRunId) : null;
      return run !== null && !isTerminal(run.state);
    }).length;
  }

  /** `GET /v1/vigie` : réglages, battement, état du jour et incidents par statut. */
  view(repos: RepoFilter, now: number): Record<string, unknown> {
    const heartbeat = this.#heartbeat();
    const byStatus = Object.fromEntries(VIGIE_STATUSES.map((status) => [status, 0])) as Record<VigieStatus, number>;
    for (const incident of this.#store.listVigieIncidents({ repos })) byStatus[incident.status]++;
    return {
      settings: this.settings(),
      heartbeat:
        heartbeat === null
          ? null
          : {
              at: heartbeat.at,
              version: heartbeat.version,
              client: heartbeat.client,
              silent: now - heartbeat.at > SILENT_MS,
              silentSince: heartbeat.silentSince,
            },
      today: this.today(now),
      incidents: byStatus,
    };
  }

  // -- incidents ----------------------------------------------------------------

  list(filter: { statuses?: VigieStatus[]; limit?: number }, repos: RepoFilter): VigieIncident[] {
    return this.#store.listVigieIncidents({ ...filter, repos });
  }

  /** Le tri est-il permis maintenant : la vigie n'est pas coupée et son budget du jour n'est pas épuisé. */
  #triageGate(now: number): Triage {
    const settings = this.settings();
    if (settings.mode === "off") return "skip";
    return this.today(now).spentUsd >= settings.dailyBudgetUsd ? "budget" : "needed";
  }

  #event(incident: VigieIncident, action: string): void {
    this.#ctx.event(
      "vigie_incident",
      null,
      {
        fingerprint: incident.fingerprint,
        action,
        status: incident.status,
        source: incident.source,
        location: incident.location,
        title: incident.triage?.title || short(incident.message, 120),
        count: incident.count,
        runId: incident.runId,
        fixRunId: incident.fixRunId,
        issueUrl: incident.issueUrl,
        note: incident.note,
      },
      incident.repo,
    );
  }

  /**
   * `POST /v1/vigie/incidents` : une occurrence d'un signal (nouvelle empreinte, ou une de
   * plus), le tri d'un incident (`triage`), ou son renvoi à l'humain (`defer`).
   */
  report(body: Record<string, unknown>, now: number): Promise<ReportOutcome> {
    if (this.settings().mode === "off") throw new HarnessError(409, "la vigie est coupée (mode off)");
    const fingerprint = body.fingerprint;
    if (!isFingerprint(fingerprint)) throw new HarnessError(400, "fingerprint : empreinte hexadécimale (16 à 64)");
    return this.#serial(fingerprint, async () => {
      const existing = this.#store.getVigieIncident(fingerprint);
      if (body.triage !== undefined || body.defer !== undefined) {
        if (!existing) throw new HarnessError(404, `incident inconnu : ${fingerprint}`);
        if (body.triage !== undefined)
          return { incident: this.#applyTriage(existing, body.triage, now), known: true, triage: "skip" };
        const reason = bounded(body, "defer", 1000, true) as string;
        return { incident: this.#defer(existing, redactSecrets(reason)), known: true, triage: "skip" };
      }
      const at = body.at === undefined ? now : body.at;
      if (!Number.isInteger(at) || (at as number) < 0) throw new HarnessError(400, "at : instant en ms (epoch)");
      const seenAt = Math.min(at as number, now);
      if (!existing) return this.#create(body, fingerprint, seenAt, now);
      const counted = this.#store.countVigieOccurrence(fingerprint, seenAt);
      if (counted.status === "watching" || counted.status === "resolved") {
        if (counted.mergedAt === null || seenAt > counted.mergedAt) await this.#recurred(counted);
      } else if (counted.issueNumber !== null && (counted.status === "reported" || counted.status === "fixing"))
        await this.#maybeComment(counted, now);
      const incident = this.#store.getVigieIncident(fingerprint) as VigieIncident;
      return { incident, known: true, triage: incident.status === "new" ? this.#triageGate(now) : "skip" };
    });
  }

  #create(body: Record<string, unknown>, fingerprint: string, at: number, now: number): ReportOutcome {
    const source = bounded(body, "source", 100, true) as string;
    const location = bounded(body, "location", 500, true) as string;
    const message = redactSecrets(bounded(body, "message", MESSAGE_MAX, true) as string);
    const context = bounded(body, "context", CONTEXT_MAX, false);
    const repoName = bounded(body, "repo", 100, false);
    const repo = repoName !== null && repoByName(this.#ctx.config, repoName) !== null ? repoName : null;
    const runIdRaw = bounded(body, "runId", 100, false);
    const run = runIdRaw === null ? null : this.#store.getRun(runIdRaw);
    // Un bug sur un run lancé par la vigie (ou sur sa descendance) revient à l'humain : jamais de boucle.
    const loop = run !== null && this.#launchedByVigie(run.id);
    const incident = this.#store.createVigieIncident({
      fingerprint,
      source,
      location,
      message,
      repo: repo ?? run?.repo ?? null,
      runId: run?.id ?? null,
      status: loop ? "deferred" : "new",
      context: context === null ? null : redactSecrets(context),
      note: loop
        ? `anti-boucle : le run ${run?.slug ?? ""} a été lancé par la vigie — une correction de sa correction revient à l'humain`
        : null,
      at,
    });
    this.#event(incident, loop ? "deferred" : "seen");
    return { incident, known: false, triage: loop ? "skip" : this.#triageGate(now) };
  }

  #applyTriage(incident: VigieIncident, raw: unknown, now: number): VigieIncident {
    const { triage, costUsd } = triageOf(raw);
    const status: VigieStatus =
      incident.status === "new" ? (triage.verdict === "noise" ? "noise" : "bug") : incident.status;
    const updated = this.#store.updateVigieIncident(incident.fingerprint, {
      triage,
      triageCost: incident.triageCost + costUsd,
      triagedAt: now,
      status,
    });
    this.#event(updated, "triaged");
    return updated;
  }

  #defer(incident: VigieIncident, note: string): VigieIncident {
    const updated = this.#store.updateVigieIncident(incident.fingerprint, { status: "deferred", note });
    this.#event(updated, "deferred");
    return updated;
  }

  /** Le run a-t-il été lancé par la vigie : sa correction, la descendance de celle-ci, ou créé par son client. */
  #launchedByVigie(runId: string): boolean {
    const heartbeat = this.#heartbeat();
    const parents = new Map<string, string>();
    for (const event of this.#store.eventsOfType("follow_up"))
      if (event.runId !== null && typeof event.payload.runId === "string")
        parents.set(event.payload.runId, event.runId);
    let current: string | undefined = runId;
    for (let depth = 0; current !== undefined && depth < 50; depth++) {
      if (this.#store.vigieIncidentByFixRun(current)) return true;
      const run = this.#store.getRun(current);
      if (run && heartbeat !== null && run.createdBy === heartbeat.client) return true;
      current = parents.get(current);
    }
    return false;
  }

  // -- La forge du dépôt (forge.ts : GitHub, GitLab ; `none` refuse en 409) ---------------

  /** Les labels manquants du projet, créés sur sa forge (sans toucher à ceux qui existent). */
  async #ensureLabels(repo: RepoConfig, forge: Forge, labels: readonly string[]): Promise<void> {
    let known = this.#labels.get(repo.name);
    if (!known) {
      known = new Set(await forge.labels());
      this.#labels.set(repo.name, known);
    }
    for (const label of labels) {
      if (known.has(label)) continue;
      const vigie = label === VIGIE_LABEL;
      await forge.createLabel(label, {
        color: vigie ? "5319e7" : "ededed",
        description: vigie ? "Issue écrite par la vigie d'omp-harness" : "",
      });
      known.add(label);
    }
  }

  /** L'issue de la vigie qui porte déjà cette empreinte sur la forge (une base perdue ne republie pas). */
  async #existingIssue(forge: Forge, fingerprint: string): Promise<{ number: number; url: string } | null> {
    const issues = await forge.issues({ state: "all", label: VIGIE_LABEL, limit: 500, withBody: true });
    for (const issue of issues) {
      if (MARKER.exec(issue.body ?? "")?.[1] === fingerprint) return { number: issue.number, url: issue.url };
    }
    return null;
  }

  /**
   * L'outil MCP `issue_create` : l'issue caviardée, publiée sur la forge de `repo` (forge.ts)
   * avec le label de la vigie et l'empreinte en marqueur caché. Une empreinte déjà publiée
   * rend son issue (`already`). Un client pilote (la vigie) est tenu par le mode, les dépôts
   * permis et `maxIssuesPerDay` : hors d'eux, rien ne part (`withheld`), le brouillon est gardé.
   */
  publish(
    input: { repo: RepoConfig; title: string; body: string; labels: string[]; fingerprint: string },
    client: Client,
    now: number,
  ): Promise<PublishOutcome> {
    if (!isFingerprint(input.fingerprint))
      throw new HarnessError(400, "fingerprint : empreinte hexadécimale (16 à 64)");
    const title = input.title.trim();
    if (title === "" || input.body.trim() === "") throw new HarnessError(400, "title et body sont requis");
    for (const label of input.labels)
      if (!/^[\w:./ -]{1,50}$/.test(label)) throw new HarnessError(400, `label invalide : ${label}`);
    return this.#serial(input.fingerprint, () => this.#publish({ ...input, title }, client, now));
  }

  async #publish(
    input: { repo: RepoConfig; title: string; body: string; labels: string[]; fingerprint: string },
    client: Client,
    now: number,
  ): Promise<PublishOutcome> {
    const { repo, fingerprint } = input;
    let incident = this.#store.getVigieIncident(fingerprint);
    if (!incident) {
      if (client.pilot)
        throw new HarnessError(404, `incident inconnu : ${fingerprint} — relève-le d'abord (POST /v1/vigie/incidents)`);
      incident = this.#store.createVigieIncident({
        fingerprint,
        source: `client:${client.name}`,
        location: "issue_create",
        message: redactSecrets(input.title),
        repo: repo.name,
        runId: null,
        status: "bug",
        context: null,
        note: null,
        at: now,
      });
    }
    if (incident.issueNumber !== null && incident.issueUrl !== null)
      return {
        status: "already",
        fingerprint,
        issue: { number: incident.issueNumber, url: incident.issueUrl },
        reason: null,
      };
    // Tout ce que le serveur garde du poste (pages, meetings, actions, profil) : jamais dans une issue.
    const poste = this.#store.workstationTexts(0);
    const title = redactForIssue(input.title, poste).slice(0, TITLE_MAX);
    const body = `${redactForIssue(input.body, poste).slice(0, BODY_MAX)}\n\n${fingerprintMarker(fingerprint)}\n`;
    const withheld = client.pilot ? this.#withheldReason(repo, now) : null;
    if (withheld !== null) {
      const updated = this.#store.updateVigieIncident(fingerprint, {
        draft: { title, body },
        note: withheld,
        repo: repo.name,
        ...(incident.status === "new" ? { status: "bug" as const } : {}),
      });
      this.#event(updated, "withheld");
      return { status: "withheld", fingerprint, issue: null, reason: withheld };
    }
    const forge = await this.#issues.forge(repo);
    const existing = await this.#existingIssue(forge, fingerprint);
    if (existing) {
      const linked = this.#store.updateVigieIncident(fingerprint, {
        issueNumber: existing.number,
        issueUrl: existing.url,
        repo: repo.name,
        ...(incident.status === "new" || incident.status === "bug" ? { status: "reported" as const } : {}),
      });
      this.#event(linked, "linked");
      return { status: "already", fingerprint, issue: existing, reason: null };
    }
    const labels = [...new Set([VIGIE_LABEL, ...input.labels])];
    await this.#ensureLabels(repo, forge, labels);
    const { number, url } = await forge.createIssue({ title, body, labels });
    const published = this.#store.updateVigieIncident(fingerprint, {
      issueNumber: number,
      issueUrl: url,
      publishedAt: now,
      commentedCount: incident.count,
      draft: { title, body },
      repo: repo.name,
      note: null,
      ...(incident.status === "new" || incident.status === "bug" ? { status: "reported" as const } : {}),
    });
    this.#event(published, "published");
    this.#ctx.log(
      `vigie : issue ${forge.name} ${forge.project ?? repo.name}#${number} publiée (empreinte ${fingerprint})`,
    );
    return { status: "published", fingerprint, issue: { number, url }, reason: null };
  }

  /** Pourquoi une issue de la vigie ne part pas : le mode, le dépôt, le plafond du jour ; `null` : elle part. */
  #withheldReason(repo: RepoConfig, now: number): string | null {
    const settings = this.settings();
    if (settings.mode !== "report" && settings.mode !== "fix")
      return `mode ${settings.mode} : la vigie consigne, elle ne publie pas`;
    if (!settings.repos.includes(repo.name))
      return `dépôt ${repo.name} hors des dépôts de la vigie (${settings.repos.join(", ") || "aucun"})`;
    const today = this.today(now);
    if (today.issues >= settings.maxIssuesPerDay)
      return `plafond du jour atteint : ${today.issues} issue(s) publiée(s) sur ${settings.maxIssuesPerDay}`;
    return null;
  }

  /** Un commentaire d'occurrences sur l'issue d'un incident connu, au plus un par COMMENT_EVERY_MS. */
  async #maybeComment(incident: VigieIncident, now: number): Promise<void> {
    const last = incident.commentedAt ?? incident.publishedAt ?? 0;
    if (now - last < COMMENT_EVERY_MS || incident.count <= incident.commentedCount) return;
    const repo = incident.repo ? repoByName(this.#ctx.config, incident.repo) : null;
    if (!repo || incident.issueNumber === null) return;
    const more = incident.count - incident.commentedCount;
    try {
      const forge = await this.#issues.forge(repo);
      await forge.comment(
        incident.issueNumber,
        `La vigie a revu ce symptôme : ${more} occurrence(s) de plus (${incident.count} au total), la dernière le ${new Date(incident.lastAt).toISOString()}.`,
      );
      this.#store.updateVigieIncident(incident.fingerprint, { commentedCount: incident.count, commentedAt: now });
    } catch (err) {
      this.#logOnce(incident.fingerprint, now, `commentaire de l'issue #${incident.issueNumber}`, err);
    }
  }

  /** L'empreinte revient après sa correction : l'issue est rouverte (ou commentée) et l'incident rendu à l'humain. */
  async #recurred(incident: VigieIncident): Promise<void> {
    const repo = incident.repo ? repoByName(this.#ctx.config, incident.repo) : null;
    const when = new Date(incident.lastAt).toISOString();
    const text = `La vigie a revu ce symptôme le ${when}, après le merge de sa correction : le bug n'est pas corrigé. Je laisse la main à l'humain.`;
    if (repo && incident.issueNumber !== null) {
      try {
        const forge = await this.#issues.forge(repo);
        if (incident.status === "resolved") await forge.reopen(incident.issueNumber, text);
        else await forge.comment(incident.issueNumber, text);
      } catch (err) {
        this.#logOnce(incident.fingerprint, Date.now(), `réouverture de l'issue #${incident.issueNumber}`, err);
      }
    }
    const updated = this.#store.updateVigieIncident(incident.fingerprint, {
      status: "deferred",
      closedAt: null,
      note: "le symptôme est revenu après le merge de la correction : à toi de trancher",
    });
    this.#event(updated, "recurred");
  }

  #logOnce(fingerprint: string, now: number, what: string, err: unknown): void {
    const last = this.#errors.get(fingerprint);
    if (last !== undefined && now - last < 60 * 60_000) return;
    this.#errors.set(fingerprint, now);
    this.#ctx.log(`vigie : ${what} (${fingerprint}) — ${err instanceof Error ? err.message : String(err)}`);
  }

  // -- corrections --------------------------------------------------------------

  /**
   * Avant `issue_fix` par un client pilote : le mode `fix`, une issue de la vigie, une seule
   * génération de correction par empreinte, l'anti-boucle, `maxLiveRuns` et le budget du jour.
   */
  guardFix(repo: RepoConfig, number: number, now: number): VigieIncident {
    const settings = this.settings();
    if (settings.mode !== "fix")
      throw new HarnessError(403, `mode ${settings.mode} : la vigie ne lance pas de correction (mode fix requis)`);
    if (!settings.repos.includes(repo.name))
      throw new HarnessError(403, `dépôt ${repo.name} hors des dépôts de la vigie`);
    const incident = this.#store.vigieIncidentByIssue(repo.name, number);
    if (!incident)
      throw new HarnessError(403, `l'issue #${number} n'est pas une issue de la vigie : à l'humain de la lancer`);
    if (incident.fixRunId !== null)
      throw new HarnessError(
        409,
        `une seule génération de correction par empreinte : le run ${incident.fixRunId} a déjà été lancé — à l'humain`,
      );
    if (incident.status === "deferred")
      throw new HarnessError(409, `incident rendu à l'humain : ${incident.note ?? "à toi de trancher"}`);
    if (incident.runId !== null && this.#launchedByVigie(incident.runId)) {
      this.#defer(incident, `anti-boucle : le run ${incident.runId} a été lancé par la vigie — à l'humain`);
      throw new HarnessError(409, "anti-boucle : un bug sur un run lancé par la vigie revient à l'humain");
    }
    const today = this.today(now);
    if (today.liveRuns >= settings.maxLiveRuns)
      throw new HarnessError(
        429,
        `plafond atteint : ${today.liveRuns} correction(s) vivante(s) sur ${settings.maxLiveRuns}`,
      );
    if (today.spentUsd >= settings.dailyBudgetUsd)
      throw new HarnessError(
        429,
        `budget du jour épuisé : ${today.spentUsd.toFixed(2)} $ sur ${settings.dailyBudgetUsd.toFixed(2)} $`,
      );
    return incident;
  }

  /** Le run de correction lancé : l'unique génération de l'empreinte. */
  recordFix(incident: VigieIncident, runId: string, now: number): void {
    const updated = this.#store.updateVigieIncident(incident.fingerprint, {
      fixRunId: runId,
      fixedAt: now,
      status: "fixing",
      note: null,
    });
    this.#event(updated, "fixing");
  }

  // -- le tour ------------------------------------------------------------------

  /** Le tour de la vigie dans le scheduling du service, au plus une fois par TICK_EVERY_MS. */
  maybeTick(now: number): void {
    if (now - this.#tickedAt < TICK_EVERY_MS) return;
    this.#tickedAt = now;
    void this.tick(now).catch((err) => this.#ctx.log(`vigie : ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Le silence, les corrections mergées ou en échec, et les fermetures après WATCH_MS sans récidive. */
  tick(now: number): Promise<void> {
    if (this.#ticking) return this.#ticking;
    this.#ticking = this.#tick(now).finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  async #tick(now: number): Promise<void> {
    this.#checkSilence(now);
    for (const incident of this.#store.listVigieIncidents({ statuses: ["fixing"] })) {
      const run = incident.fixRunId ? this.#store.getRun(incident.fixRunId) : null;
      if (!run) continue;
      if (run.state === "merged") {
        this.#event(
          this.#store.updateVigieIncident(incident.fingerprint, { status: "watching", mergedAt: run.updatedAt }),
          "merged",
        );
      } else if (run.state === "failed" || run.state === "cancelled") {
        this.#defer(
          incident,
          `le run de correction ${run.slug} est ${run.state === "failed" ? "en échec" : "annulé"} : une seule génération par empreinte, à toi`,
        );
      }
    }
    for (const incident of this.#store.listVigieIncidents({ statuses: ["watching"] })) {
      if (incident.mergedAt !== null && now - incident.mergedAt >= WATCH_MS)
        await this.#serial(incident.fingerprint, () => this.#close(incident.fingerprint, now));
    }
  }

  #checkSilence(now: number): void {
    const heartbeat = this.#heartbeat();
    if (heartbeat === null || heartbeat.silentSince !== null || this.settings().mode === "off") return;
    if (now - heartbeat.at <= SILENT_MS) return;
    this.#store.setSetting(HEARTBEAT_KEY, { ...heartbeat, silentSince: now }, null);
    this.#ctx.event("vigie_silent", null, {
      lastAt: heartbeat.at,
      silentSec: Math.round((now - heartbeat.at) / 1000),
      client: heartbeat.client,
    });
  }

  /** WATCH_MS sans récidive : l'issue fermée avec un commentaire, le souvenir écrit. */
  async #close(fingerprint: string, now: number): Promise<void> {
    const incident = this.#store.getVigieIncident(fingerprint);
    if (incident?.status !== "watching") return;
    const repo = incident.repo ? repoByName(this.#ctx.config, incident.repo) : null;
    const run = incident.fixRunId ? this.#store.getRun(incident.fixRunId) : null;
    const hours = Math.round(WATCH_MS / 3_600_000);
    if (repo && incident.issueNumber !== null) {
      try {
        const forge = await this.#issues.forge(repo);
        await forge.close(
          incident.issueNumber,
          `Corrigé${run ? ` par le run « ${redactSecrets(run.title)} »${run.mergeSha ? ` (${run.mergeSha.slice(0, 12)})` : ""}` : ""} : la vigie n'a plus vu ce symptôme en ${hours} h depuis le merge. Fermée par la vigie.`,
        );
      } catch (err) {
        this.#logOnce(fingerprint, now, `fermeture de l'issue #${incident.issueNumber}`, err);
        return;
      }
    }
    if (repo) {
      const triage = incident.triage;
      void this.#ctx.oracle.retain(
        repo.scope,
        [
          `Bug corrigé (vigie, empreinte ${fingerprint}) — ${triage?.title || short(incident.message, 120)}`,
          `Symptôme : ${triage?.symptom || short(incident.message, 400)}`,
          `Cause : ${triage?.hypothesis || "non établie"}`,
          `Correctif : ${run ? `run « ${run.title} » (${run.slug}) mergé${run.mergeSha ? ` en ${run.mergeSha.slice(0, 12)}` : ""}` : "inconnu"}${triage && triage.files.length > 0 ? ` ; fichiers : ${triage.files.join(", ")}` : ""}`,
          ...(incident.issueUrl ? [`Issue : ${incident.issueUrl}`] : []),
        ].join("\n"),
        ["harness", "vigie", "bug"],
      );
    }
    this.#event(this.#store.updateVigieIncident(fingerprint, { status: "resolved", closedAt: now }), "resolved");
  }
}

/** La section « Vigie » du rapport du matin : ce qu'elle a fait dans la fenêtre, et son silence. */
export function vigieDigestLines(store: Store, since: number, until: number, repos: RepoFilter): string[] {
  const within = (at: number | null): boolean => at !== null && at >= since && at <= until;
  const incidents = store.listVigieIncidents({ repos });
  const title = (incident: VigieIncident) => short(incident.triage?.title || incident.message, 90);
  const lines: string[] = [];
  const heartbeat = store.getSetting<Heartbeat>(HEARTBEAT_KEY);
  if (heartbeat?.silentSince != null)
    lines.push(`Muette depuis ${new Date(heartbeat.at).toISOString()} : son conteneur est-il arrêté ?`);
  const fresh = incidents.filter((incident) => within(incident.firstAt)).length;
  const noise = incidents.filter((incident) => incident.status === "noise" && within(incident.triagedAt)).length;
  if (fresh > 0 || noise > 0) lines.push(`${fresh} empreinte(s) nouvelle(s), ${noise} classée(s) bruit`);
  for (const incident of incidents) {
    if (incident.status === "deferred" && within(incident.updatedAt))
      lines.push(`À toi — ${title(incident)} : ${short(incident.note ?? "décision réservée à l'humain", 120)}`);
    else if (incident.status === "resolved" && within(incident.closedAt))
      lines.push(`Fermée sans récidive — ${title(incident)}${incident.issueUrl ? ` — ${incident.issueUrl}` : ""}`);
    else if (incident.status === "watching" && within(incident.mergedAt))
      lines.push(`Corrigée, surveillée 24 h — ${title(incident)}`);
    else if (incident.status === "fixing" && within(incident.fixedAt))
      lines.push(`Correction lancée — ${title(incident)} (run ${incident.fixRunId})`);
    else if (incident.status === "reported" && within(incident.publishedAt))
      lines.push(`Issue publiée — ${title(incident)} — ${incident.issueUrl}`);
    else if (incident.status === "bug" && incident.draft !== null && within(incident.updatedAt))
      lines.push(`Repérée, non publiée — ${title(incident)} (${short(incident.note ?? "", 80)})`);
  }
  return lines;
}
