// L'agent 24/24 du poste de travail et ses jobs LLM, menés à chaque tour de
// l'orchestrateur comme les audits (même scheduler, mêmes runners, même plafond
// journalier) :
// - `poste-profil`  : la synthèse du profil de travail, toutes les `profileEveryHours`
//   heures s'il y a du neuf (ou à la demande d'une app), rendue par `workstation_profile_write` ;
// - `poste-digest`  : le digest d'un meeting terminé (résumé, besoins des clients),
//   rendu par `workstation_meeting_digest` ;
// - `poste-service` : un service de l'agent, toutes les `shiftEveryMin` minutes quand
//   l'autonomie appliquée est `propose` ou `act`, l'extension en ligne et le poste hors
//   pause : de petites actions par `workstation_act`, chacune journalisée avec sa raison.
//
// Un seul job de chaque sorte à la fois. La garde d'envoi n'est pas ici : elle est dans la
// file (workstation.ts) et dans l'extension, et aucun outil de l'agent n'approuve.
//
// Ces jobs n'ont pas de dépôt. Ils tournent sur un dépôt SYNTHÉTIQUE (`workstationTarget`) :
// - le « clone » est `<dataDir>/workstation`, un dossier vide créé par le service, hors des
//   worktrees : monté en lecture seule en isolation `container` (le montage du clone y est
//   obligatoire), ignoré par le lanceur `systemd` (hors de REPOS_ROOT, rien à monter) ;
// - le répertoire de travail est `<worktreesDir>/workstation/_poste`, la forme
//   `<dépôt>/<feature>` qu'exige le lanceur root (`_` comme `_audit-<id>` : aucun run n'y
//   prend son worktree), seul dossier inscriptible du runner ;
// - la scope mémoire est `workstation` : l'agent ne lit ni n'écrit la mémoire d'un projet.
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessConfig, RepoConfig, Tier } from "./config.ts";
import { repoDefaults } from "./config.ts";
import type { HarnessContext } from "./context.ts";
import type { Meeting, StoredObservation, WorkstationAction, WorkstationProfile } from "./db.ts";
import { nudgePrompt, workstationDigestPrompt, workstationProfilePrompt, workstationShiftPrompt } from "./prompts.ts";
import type { HostToolResult } from "./rpc.ts";
import type { WorkstationJob } from "./runner.ts";
import { forceStop, hostToolsFor, runnerUnit } from "./runner.ts";
import { RunnerSession } from "./runner-session.ts";
import { workstationOwner } from "./session-feed.ts";
import type { EffectiveAutonomy, ProfileStats, Workstation } from "./workstation.ts";
import { MAX_WAIT_SEC, clip, parseActionInput, parseDigest, parseProfile } from "./workstation.ts";

/** La scope mémoire des jobs du poste. */
export const WORKSTATION_SCOPE = "workstation";

const JOBS: readonly WorkstationJob[] = ["poste-profil", "poste-digest", "poste-service"];

/** Le tier de chaque job : un gros modèle là où l'on juge (le profil, les actions), un moyen pour résumer. */
const JOB_TIERS: Record<WorkstationJob, Tier> = {
  "poste-profil": "heavy",
  "poste-digest": "standard",
  "poste-service": "heavy",
};

const OBSERVATIONS_SAMPLE = 300;
const MEETINGS_SHOWN = 10;
const JOURNAL_SHOWN = 20;
const TRANSCRIPT_HEAD = 20_000;
const TRANSCRIPT_TAIL = 100_000;
const TOOL_TEXT_MAX = 8000;

/** Le dépôt synthétique et le répertoire de travail des jobs du poste (voir l'en-tête). */
export function workstationTarget(config: HarnessConfig): { repo: RepoConfig; cwd: string } {
  return {
    repo: repoDefaults({
      name: "workstation",
      path: path.join(config.dataDir, "workstation"),
      scope: WORKSTATION_SCOPE,
    }),
    cwd: path.join(config.worktreesDir, "workstation", "_poste"),
  };
}

/** L'unité (et l'étiquette de slot) d'un job : fixe, pour être arrêtée après un redémarrage. */
function unitOf(job: WorkstationJob): string {
  return runnerUnit(`workstation-${job}`, 0);
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

/** L'heure LOCALE de l'utilisateur d'une observation (`tz` : getTimezoneOffset du lot). */
function localTime(at: number, tz: number): string {
  return new Date(at - tz * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

function observationLine(entry: StoredObservation): string {
  const when = localTime(entry.at, entry.tz);
  if (entry.kind === "visit") return `${when} visite ${entry.url} « ${entry.title} » ${minutes(entry.durationMs)}`;
  return `${when} ${entry.action} ${entry.target.role} « ${entry.target.label} » sur ${entry.url}`;
}

function statsText(stats: ProfileStats): string {
  const hours = stats.activeHours
    .map((seconds, hour) => (seconds > 0 ? `${String(hour).padStart(2, "0")} h : ${minutes(seconds * 1000)}` : null))
    .filter((line): line is string => line !== null);
  return [
    `Temps actif observé : ${(stats.observedSeconds / 3600).toFixed(1)} h${stats.since ? ` depuis le ${new Date(stats.since).toISOString().slice(0, 10)}` : ""}.`,
    "Sites (temps de visite, part) :",
    ...stats.topSites.map(
      (site) => `- ${site.host} : ${minutes(site.seconds * 1000)} (${Math.round(site.share * 100)} %)`,
    ),
    "Heures actives (heure locale) :",
    ...hours.map((line) => `- ${line}`),
    "Enchaînements récurrents :",
    ...stats.sequences.map((sequence) => `- ${sequence.count} fois : ${sequence.steps.join(" → ")}`),
  ].join("\n");
}

function meetingLines(meetings: readonly Meeting[]): string | null {
  if (meetings.length === 0) return null;
  return meetings
    .map((meeting) =>
      [
        `- ${new Date(meeting.startedAt).toISOString().slice(0, 16).replace("T", " ")} « ${meeting.title} » (${meeting.id}, ${meeting.state}) : ${meeting.summary ?? "pas encore résumé"}`,
        ...meeting.needs.map(
          (need) =>
            `  - besoin : ${need.need}${need.who ? ` — ${need.who}` : ""}${need.due ? ` (échéance : ${need.due})` : ""}`,
        ),
      ].join("\n"),
    )
    .join("\n");
}

function profileText(profile: WorkstationProfile | null): string | null {
  if (!profile) return null;
  const { version: _version, updatedAt: _updatedAt, ...body } = profile;
  return JSON.stringify(body, null, 2);
}

function actionLine(action: WorkstationAction): string {
  return `- #${action.seq} ${action.kind} (${action.state}, ${action.origin}) : ${action.approval?.summary ?? action.rationale}`;
}

const AWAITING = (seq: number): string => `action #${seq} en attente de l'approbation de l'humain : ne réessaie pas.`;

/** Ce que `workstation_act` rend à l'agent : le résultat, l'échec, ou l'attente de l'humain. */
function actResult(action: WorkstationAction, image: boolean): HostToolResult {
  switch (action.state) {
    case "done": {
      const parts = [`action #${action.seq} faite.`];
      if (action.result?.text) parts.push(clip(action.result.text, TOOL_TEXT_MAX));
      if (action.result?.data !== undefined) parts.push(clip(JSON.stringify(action.result.data), TOOL_TEXT_MAX));
      if (image) parts.push("(capture prise ; l'image n'est pas transmise à l'agent du serveur : utilise snapshot.)");
      return { text: parts.join("\n") };
    }
    case "awaiting_approval":
      return { text: AWAITING(action.seq) };
    case "queued":
    case "running":
      return {
        text: `action #${action.seq} toujours ${action.state} après ${MAX_WAIT_SEC} s : l'extension ne l'a pas encore rendue. Ne la redépose pas.`,
      };
    default:
      return { text: `action #${action.seq} ${action.state} : ${action.error ?? "sans détail"}`, isError: true };
  }
}

type LiveJob = {
  abort: AbortController;
  session: RunnerSession | null;
  /** Pourquoi le job a été arrêté avant sa fin (pause, autonomie, arrêt du service). */
  stopReason: string | null;
  done: Promise<void>;
};

export class WorkstationAgent {
  readonly #ctx: HarnessContext;
  readonly #ws: Workstation;
  readonly #live = new Map<WorkstationJob, LiveJob>();
  /** La dernière synthèse du profil tentée : un échec n'est pas relancé avant `profileEveryHours`. */
  #profileAttemptAt = 0;

  constructor(ctx: HarnessContext, workstation: Workstation) {
    this.#ctx = ctx;
    this.#ws = workstation;
  }

  /** Un tour : les échéances de la file, puis les jobs dus. */
  tick(now = Date.now()): void {
    this.#ws.maintain(now);
    if (!this.#ws.enabled) return;
    this.#guardShift();
    this.#digestNext();
    this.#profileIfDue(now);
    this.#shiftIfDue(now);
  }

  /** Le job tourne en ce moment. */
  isLive(job: WorkstationJob): boolean {
    return this.#live.has(job);
  }

  /** Un job lancé s'il n'en tourne pas déjà un de sa sorte, sous le plafond journalier, avec un slot runner. */
  #launch(job: WorkstationJob, drive: (live: LiveJob) => Promise<void>): boolean {
    if (this.#live.has(job)) return false;
    if (this.#ctx.monitor.dailyBudgetDue()) return false;
    const slot = this.#ctx.scheduler.tryAcquire("runner", unitOf(job));
    if ("refused" in slot) return false;
    const live: LiveJob = { abort: new AbortController(), session: null, stopReason: null, done: Promise.resolve() };
    this.#live.set(job, live);
    live.done = drive(live)
      .catch((err: unknown) => this.#ctx.log(`poste ${job} : ${err instanceof Error ? err.message : String(err)}`))
      .finally(async () => {
        await live.session?.stop();
        slot.release();
        this.#live.delete(job);
      });
    return true;
  }

  /** Un runner prêt pour `job`, sur le dépôt synthétique du poste, avec ses outils hôtes. */
  async #open(
    job: WorkstationJob,
    live: LiveJob,
    onHostTool: (name: string, args: Record<string, unknown>) => Promise<HostToolResult>,
  ): Promise<RunnerSession> {
    const target = workstationTarget(this.#ctx.config);
    fs.mkdirSync(target.repo.path, { recursive: true });
    fs.mkdirSync(target.cwd, { recursive: true });
    const session = new RunnerSession(this.#ctx, target, {
      onHostTool: (name, args) =>
        name === "progress" ? Promise.resolve(this.#progress(job, args)) : onHostTool(name, args),
      event: (type, payload) => this.#ctx.event(type, null, { workstation: job, ...payload }, null),
      frame: (frame) => this.#ctx.sessions.frame(workstationOwner(job), job, frame),
    });
    live.session = session;
    await session.open(JOB_TIERS[job], unitOf(job), live.abort.signal);
    await session.setHostTools(hostToolsFor(job));
    return session;
  }

  #progress(job: WorkstationJob, args: Record<string, unknown>): HostToolResult {
    const message = typeof args.message === "string" ? args.message.slice(0, 500) : "";
    this.#ctx.event("progress", null, { workstation: job, message }, null);
    return { text: "noté" };
  }

  // -- digest des meetings ---------------------------------------------------------

  #digestNext(): void {
    if (this.#live.has("poste-digest")) return;
    const meeting = this.#ctx.store.listWorkstationMeetings({ states: ["ended"], limit: 50 }).at(-1);
    if (!meeting) return;
    // Rien de transcrit : rien à résumer, aucun runner.
    if (meeting.segments === 0) {
      this.#ws.finishDigest(meeting.id, { summary: "Aucun échange transcrit.", needs: [] });
      return;
    }
    this.#launch("poste-digest", (live) => this.#digest(meeting, live));
  }

  async #digest(meeting: Meeting, live: LiveJob): Promise<void> {
    const out: { digest: { summary: string; needs: Meeting["needs"] } | null; reason: string | null } = {
      digest: null,
      reason: null,
    };
    try {
      const session = await this.#open("poste-digest", live, async (name, args) => {
        if (name !== "workstation_meeting_digest") return { text: `outil inconnu : ${name}`, isError: true };
        const parsed = parseDigest(args);
        if (!parsed.ok) return { text: `digest refusé : ${parsed.error}`, isError: true };
        out.digest = { summary: parsed.summary, needs: parsed.needs };
        return { text: "digest enregistré. Termine ton tour." };
      });
      const deadlineAt = Date.now() + this.#ctx.config.runner.stepTimeoutSec * 1000;
      let result = await session.prompt(
        workstationDigestPrompt({ title: meeting.title, url: meeting.url, transcript: this.#transcript(meeting) }),
        live.abort.signal,
        deadlineAt,
      );
      if (result.status === "completed" && out.digest === null)
        result = await session.prompt(
          nudgePrompt("poste-digest", "le digest n'a pas été rendu par `workstation_meeting_digest`"),
          live.abort.signal,
          deadlineAt,
        );
      if (result.status !== "completed") out.reason = result.error?.message ?? "erreur du runner";
      else if (out.digest === null) out.reason = "le digest n'a pas été rendu par `workstation_meeting_digest`";
    } catch (err) {
      out.reason = err instanceof Error ? err.message : String(err);
    } finally {
      await live.session?.stop();
      live.session = null;
    }
    // Un arrêt du service : le meeting reste `ended`, son digest repart au démarrage suivant.
    if (live.abort.signal.aborted) return;
    this.#ws.finishDigest(meeting.id, out.digest ?? { reason: out.reason ?? "échec sans détail" });
    if (out.digest === null) this.#ctx.log(`poste : digest du meeting ${meeting.id} en échec : ${out.reason}`);
  }

  /** La transcription, minutes depuis le début ; une très longue garde son début et sa fin. */
  #transcript(meeting: Meeting): string {
    const text = this.#ctx.store
      .listWorkstationSegments(meeting.id)
      .map((segment) => {
        const elapsed = Math.max(0, segment.at - meeting.startedAt);
        const stamp = `${String(Math.floor(elapsed / 60_000)).padStart(2, "0")}:${String(Math.floor((elapsed % 60_000) / 1000)).padStart(2, "0")}`;
        return `[${stamp}] ${segment.speaker} : ${segment.text}`;
      })
      .join("\n");
    if (text.length <= TRANSCRIPT_HEAD + TRANSCRIPT_TAIL) return text;
    return `${text.slice(0, TRANSCRIPT_HEAD)}\n[… transcription coupée …]\n${text.slice(-TRANSCRIPT_TAIL)}`;
  }

  // -- profil -------------------------------------------------------------------------

  /**
   * La synthèse est due à la demande d'une app, ou quand `profileEveryHours` ont passé
   * depuis le dernier profil (le premier : depuis la première observation) ET que de
   * nouvelles observations sont arrivées depuis.
   */
  #profileIfDue(now: number): void {
    if (this.#live.has("poste-profil")) return;
    const { store } = this.#ctx;
    const last = store.latestWorkstationProfile();
    const reference = last?.updatedAt ?? this.#ws.observed().since;
    const every = this.#ctx.config.workstation.profileEveryHours * 3_600_000;
    const due =
      this.#ws.profileRequested ||
      (reference !== null &&
        now - Math.max(reference, this.#profileAttemptAt) >= every &&
        store.countWorkstationObservationsSince(last?.updatedAt ?? 0) > 0);
    if (!due) return;
    if (!this.#launch("poste-profil", (live) => this.#profile(live))) return;
    this.#ws.profileRequested = false;
    this.#profileAttemptAt = now;
  }

  async #profile(live: LiveJob): Promise<void> {
    const { store } = this.#ctx;
    const out: { version: number | null } = { version: null };
    let failure: string | null = null;
    try {
      const session = await this.#open("poste-profil", live, async (name, args) => {
        if (name !== "workstation_profile_write") return { text: `outil inconnu : ${name}`, isError: true };
        if (out.version !== null) return { text: `profil v${out.version} déjà enregistré. Termine ton tour.` };
        const parsed = parseProfile(args);
        if (!parsed.ok) return { text: `profil refusé : ${parsed.error}`, isError: true };
        out.version = this.#ws.writeProfile(parsed.profile).version;
        return { text: `profil v${out.version} enregistré. Termine ton tour.` };
      });
      const deadlineAt = Date.now() + this.#ctx.config.runner.stepTimeoutSec * 1000;
      const observations = store.listWorkstationObservations({ limit: OBSERVATIONS_SAMPLE });
      let result = await session.prompt(
        workstationProfilePrompt({
          stats: statsText(this.#ws.stats()),
          observations: observations.length > 0 ? observations.map(observationLine).join("\n") : null,
          meetings: meetingLines(store.listWorkstationMeetings({ states: ["digested"], limit: MEETINGS_SHOWN })),
          previous: profileText(store.latestWorkstationProfile()),
        }),
        live.abort.signal,
        deadlineAt,
      );
      if (result.status === "completed" && out.version === null)
        result = await session.prompt(
          nudgePrompt("poste-profil", "le profil n'a pas été rendu par `workstation_profile_write`"),
          live.abort.signal,
          deadlineAt,
        );
      if (result.status !== "completed") failure = result.error?.message ?? "erreur du runner";
      else if (out.version === null) failure = "le profil n'a pas été rendu par `workstation_profile_write`";
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (failure !== null && !live.abort.signal.aborted)
      this.#ctx.log(`poste : synthèse du profil en échec : ${failure}`);
  }

  // -- services de l'agent 24/24 ---------------------------------------------------------

  /** Un service en cours s'arrête dès que le poste passe en pause ou que l'autonomie retombe en observation. */
  #guardShift(): void {
    const live = this.#live.get("poste-service");
    if (!live || live.abort.signal.aborted) return;
    const settings = this.#ws.settings();
    const reason = settings.paused
      ? "interrompu : poste mis en pause"
      : this.#ws.effective(settings) === "observe"
        ? "interrompu : autonomie en observation"
        : null;
    if (reason === null) return;
    live.stopReason = reason;
    live.abort.abort();
  }

  #shiftIfDue(now: number): void {
    if (this.#live.has("poste-service")) return;
    const settings = this.#ws.settings();
    const effective = this.#ws.effective(settings);
    if (effective === "observe" || settings.paused || !this.#ws.online(now)) return;
    const next = this.#ws.nextShiftAt(settings, effective, this.#ctx.store.lastWorkstationShift(), now);
    if (next === null || now < next) return;
    this.#launch("poste-service", (live) => this.#shift(live, effective));
  }

  async #shift(live: LiveJob, autonomy: Exclude<EffectiveAutonomy, "observe">): Promise<void> {
    const { config, store } = this.#ctx;
    const startedAt = Date.now();
    const counter = { actions: 0, capped: false };
    let outcome: string;
    try {
      const session = await this.#open("poste-service", live, (name, args) =>
        this.#shiftTool(name, args, counter, live),
      );
      // Un service ne déborde jamais sur le suivant.
      const deadlineAt =
        Date.now() + Math.min(config.runner.stepTimeoutSec * 1000, config.workstation.shiftEveryMin * 60_000);
      const awaiting = store.listWorkstationActions({ states: ["awaiting_approval"], limit: JOURNAL_SHOWN });
      const journal = store.listWorkstationActions({ limit: JOURNAL_SHOWN });
      const recent = store.listWorkstationObservations({ since: Date.now() - 2 * 3_600_000, limit: 100 });
      const result = await session.prompt(
        workstationShiftPrompt({
          autonomy,
          maxActions: config.workstation.shiftMaxActions,
          profile: profileText(store.latestWorkstationProfile()),
          activity: recent.length > 0 ? recent.map(observationLine).join("\n") : null,
          pending: awaiting.length > 0 ? awaiting.map(actionLine).join("\n") : null,
          journal: journal.length > 0 ? journal.map(actionLine).join("\n") : null,
          needs: meetingLines(store.listWorkstationMeetings({ states: ["digested"], limit: MEETINGS_SHOWN })),
        }),
        live.abort.signal,
        deadlineAt,
      );
      outcome =
        result.status === "completed"
          ? counter.capped
            ? "plafond d'actions atteint"
            : "terminé"
          : `échec : ${result.error?.message ?? "erreur du runner"}`;
    } catch (err) {
      outcome = `échec : ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await live.session?.stop();
      live.session = null;
    }
    if (live.abort.signal.aborted) outcome = live.stopReason ?? "interrompu : service arrêté";
    this.#ws.recordShift({ startedAt, outcome: clip(outcome, 300), actions: counter.actions });
  }

  async #shiftTool(
    name: string,
    args: Record<string, unknown>,
    counter: { actions: number; capped: boolean },
    live: LiveJob,
  ): Promise<HostToolResult> {
    const { config, store } = this.#ctx;
    switch (name) {
      case "workstation_act":
      case "workstation_decision": {
        if (counter.actions >= config.workstation.shiftMaxActions) {
          counter.capped = true;
          return { text: "plafond d'actions de ce service atteint : termine ton tour maintenant.", isError: true };
        }
        let action: WorkstationAction;
        try {
          const input =
            name === "workstation_decision"
              ? parseActionInput({ kind: "decision", params: { summary: args.summary }, rationale: args.rationale })
              : parseActionInput({ kind: args.kind, params: args.params ?? {}, rationale: args.rationale });
          if (name === "workstation_act" && input.kind === "decision")
            return { text: "une décision sans geste passe par `workstation_decision`.", isError: true };
          action = this.#ws.createAction(input, "agent", "agent");
        } catch (err) {
          return { text: `action refusée : ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
        counter.actions++;
        if (action.kind === "decision") return { text: `décision #${action.seq} journalisée.` };
        if (action.state === "awaiting_approval") return { text: AWAITING(action.seq) };
        const waited = await this.#ws.waitAction(action.seq, MAX_WAIT_SEC, live.abort.signal);
        return actResult(waited.action, waited.image !== undefined);
      }
      case "workstation_activity": {
        const sinceMin =
          typeof args.sinceMin === "number" && Number.isFinite(args.sinceMin)
            ? Math.min(Math.max(Math.round(args.sinceMin), 1), 10_080)
            : 60;
        const entries = store.listWorkstationObservations({ since: Date.now() - sinceMin * 60_000, limit: 200 });
        return {
          text:
            entries.length > 0 ? entries.map(observationLine).join("\n") : `aucune activité depuis ${sinceMin} min.`,
        };
      }
      case "workstation_meetings":
        return {
          text: meetingLines(store.listWorkstationMeetings({ limit: MEETINGS_SHOWN })) ?? "aucun meeting transcrit.",
        };
      default:
        return { text: `outil inconnu : ${name}`, isError: true };
    }
  }

  // -- cycle de vie -------------------------------------------------------------------

  /** Un job qu'un process mort a laissé tourner : son unité est arrêtée (le meeting reste `ended`, repris). */
  async recover(): Promise<void> {
    const { config, exec } = this.#ctx;
    for (const job of JOBS) await forceStop(config, exec, unitOf(job));
  }

  async stop(): Promise<void> {
    const lives = [...this.#live.values()];
    for (const live of lives) {
      live.stopReason ??= "interrompu : service arrêté";
      live.abort.abort();
      await live.session?.stop();
    }
    await Promise.allSettled(lives.map((live) => live.done));
  }
}
