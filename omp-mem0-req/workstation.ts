// Les outils du POSTE DE TRAVAIL exposés au modèle : lire l'état du poste, le profil
// établi par l'observation, l'activité récente, les meetings transcrits et le journal
// des décisions ; et agir dans le navigateur du Mac (`workstation_act`).
//
// Le poste, c'est Chrome sur le Mac, piloté par l'extension omp-chrome à travers le
// harness, qui tient la file des actions. Le computer use s'arrête au navigateur.
//
// Aucun outil n'approuve ni ne refuse une action : un message à quelqu'un d'autre que
// l'utilisateur est retenu par l'extension et attend un geste HUMAIN dans OMP Console.
// Ce module n'appelle jamais les routes `/approve` ni `/refuse`.
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { HarnessCallError, harnessCall, resolveTarget } from "./harness.ts";
import type { HarnessTarget } from "./harness.ts";
import { text } from "./tools.ts";
import type { ToolDeps } from "./tools.ts";

export const ACTION_KINDS = [
  "tabs",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "key",
  "scroll",
  "screenshot",
  "wait",
  "close",
  "decision",
] as const;

/** Les actions qui ne changent rien au poste : lire les onglets, une page, une capture ; attendre ; journaliser. */
export const READ_KINDS: Partial<Record<string, true>> = {
  tabs: true,
  snapshot: true,
  screenshot: true,
  wait: true,
  decision: true,
};

const ACTION_STATES = ["queued", "running", "awaiting_approval", "done", "failed", "refused", "expired"] as const;
type ActionState = (typeof ACTION_STATES)[number];

/** Les états d'une action, en clair. */
export const STATE_LABELS: Record<ActionState, string> = {
  queued: "en file",
  running: "en cours",
  awaiting_approval: "en attente d'approbation",
  done: "faite",
  failed: "échouée",
  refused: "refusée",
  expired: "expirée (vaut refus)",
};

/** L'attente par défaut de `workstation_act`, et son plafond, en secondes. */
export const ACT_WAIT_DEFAULT = 30;
export const ACT_WAIT_MAX = 120;
/**
 * Une attente du serveur (`?wait=`), au plus : le serveur accepte 30 s, mais
 * `harnessCall` abandonne un appel à 30 s ; la marge évite que les deux se croisent.
 */
const POLL_SLICE = 25;

/** Ce que rend `workstation_act` quand l'action attend l'humain : la règle que le modèle doit suivre. */
export const APPROVAL_RULE =
  "Ne réessaie pas cette action et ne contourne jamais la garde (autre bouton, autre site, raccourci clavier, copier-coller) : dis à l'utilisateur d'approuver ou de refuser dans l'app OMP Console (section « Poste »). Sans réponse, l'action expire et vaut refus. Suis son issue avec workstation_journal.";

const OUTPUT_LIMIT = 24_000;

type Approval = {
  summary: string;
  recipients: string[];
  preview: string;
  decidedBy: string | null;
  decidedAt: number | null;
  reason: string | null;
};

type WorkstationAction = {
  seq: number;
  createdAt: number;
  updatedAt: number;
  origin: "session" | "agent";
  by: string | null;
  kind: string;
  params: Record<string, unknown>;
  rationale: string;
  state: ActionState;
  approved: boolean;
  approval: Approval | null;
  result: { text?: string; data?: unknown } | null;
  error: string | null;
};

type WorkstationStatus = {
  online: boolean;
  lastSeenAt: number | null;
  extensionVersion: string | null;
  observedSeconds: number;
  thresholdHours: number;
  autonomy: { setting: string; effective: string };
  paused: boolean;
  selfIdentities: string[];
  pending: number;
  profileUpdatedAt: number | null;
  lastShift: { at: number; outcome: string; actions: number } | null;
  nextShiftAt: number | null;
};

type ProfileStats = {
  observedSeconds: number;
  since: number | null;
  topSites: { host: string; seconds: number; share: number }[];
  activeHours: number[];
  sequences: { steps: string[]; count: number }[];
};

type WorkstationProfile = {
  version: number;
  updatedAt: number;
  summary: string;
  habits: string[];
  tools: { name: string; usage: string }[];
  schedule: string;
  repetitiveTasks: { title: string; frequency: string; steps: string[]; automatable: boolean }[];
  clientNeeds: { need: string; who: string | null; meetingId: string | null; at: number | null }[];
  preferences: string[];
};

type Observation = { id?: number; at: number; url: string; title: string } & (
  | { kind: "visit"; durationMs: number }
  | { kind: "interaction"; action: string; target: { role: string; label: string } }
);

type Meeting = {
  id: string;
  title: string;
  url: string;
  startedAt: number;
  endedAt: number | null;
  state: string;
  summary: string | null;
  needs: { need: string; who: string | null; due: string | null; quote: string }[];
  segments: number;
};
type Segment = { at: number; speaker: "moi" | "autres"; text: string };

type ActivityParams = { sinceMin?: number; limit?: number };
type MeetingsParams = { id?: string };
type JournalParams = { state?: string; limit?: number };
type ActParams = { kind: string; params?: Record<string, unknown>; rationale: string; waitSec?: number };

/**
 * L'accord que l'hôte demande pour `workstation_act`, selon le kind : lecture pour ce
 * qui ne change rien au poste, écriture pour le reste (et pour un appel illisible).
 * L'envoi d'un message n'en dépend pas : il attend toujours l'humain dans l'app.
 */
export function actApproval(args: unknown): { tier: "read" | "write"; reason: string } {
  const kind =
    args !== null && typeof args === "object" && "kind" in args && typeof args.kind === "string" ? args.kind : "";
  return READ_KINDS[kind] === true
    ? { tier: "read", reason: "lit le navigateur du poste sans rien y changer" }
    : { tier: "write", reason: "agit dans le navigateur du poste (Chrome du Mac)" };
}

/** L'attente de `workstation_act`, bornée : 30 s par défaut, entre 0 et 120 s. */
export function actWait(waitSec: number | undefined): number {
  if (waitSec === undefined || !Number.isFinite(waitSec)) return ACT_WAIT_DEFAULT;
  return Math.min(ACT_WAIT_MAX, Math.max(0, Math.floor(waitSec)));
}

function bound(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function truncate(content: string, limit: number): string {
  return content.length <= limit ? content : `${content.slice(0, limit)}\n… (tronqué à ${limit} caractères)`;
}

function iso(at: number | null | undefined): string {
  return typeof at === "number" ? new Date(at).toISOString() : "—";
}

/** `11 520` → « 3 h 12 min ». */
export function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest > 0 ? ` ${String(rest).padStart(2, "0")} min` : ""}`;
}

function list(items: string[], empty = "(aucun)"): string[] {
  return items.length === 0 ? [empty] : items.map((item) => `- ${item}`);
}

/**
 * Le harness du poste : le poste ne dépend d'aucun dépôt (ses routes ignorent
 * `repo`), il se joint donc aussi depuis un dossier qui n'est pas un dépôt git.
 */
function targetOf(ctx: ExtensionContext | undefined): HarnessTarget | { refusal: string } {
  return resolveTarget(ctx?.cwd ?? process.cwd(), {
    ...process.env,
    HARNESS_REPO: process.env.HARNESS_REPO ?? "poste",
  });
}

/** Une erreur du harness, expliquée pour le modèle (et l'utilisateur à qui il la rapporte). */
export function failure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (!(err instanceof HarnessCallError)) return msg;
  if (err.status === 403)
    return `${msg} : le poste est réservé au propriétaire du harness. Ce jeton ne voit pas tous les dépôts (ou n'a pas le rôle requis) ; l'utilisateur doit appairer ce Mac avec un jeton sans filtre de dépôts (harness.sh pair).`;
  if (err.status === 409 && /pause/i.test(msg))
    return `${msg} : aucune action ne part tant que l'utilisateur n'a pas levé la pause dans OMP Console (section « Poste »). Ne réessaie pas.`;
  if (err.status === 409 && /hors ligne/i.test(msg))
    return `${msg} : Chrome doit tourner sur le Mac avec l'extension omp-chrome appairée. Dis-le à l'utilisateur ; ne réessaie pas en boucle.`;
  return msg;
}

/** L'état du poste en Markdown. */
export function renderStatus(status: WorkstationStatus): string {
  const extension = status.online
    ? `en ligne${status.extensionVersion ? ` (version ${status.extensionVersion})` : ""}, dernier contact ${iso(status.lastSeenAt)}`
    : `HORS LIGNE (dernier contact : ${status.lastSeenAt === null ? "jamais" : iso(status.lastSeenAt)}) : aucune action ne peut partir`;
  return [
    "# Poste de travail",
    `- extension Chrome : ${extension}`,
    `- en pause : ${status.paused ? "OUI (aucune action ne part, l'observation est refusée)" : "non"}`,
    `- temps observé : ${duration(status.observedSeconds)} (seuil d'autonomie : ${status.thresholdHours} h)`,
    `- autonomie : réglage ${status.autonomy.setting}, appliquée ${status.autonomy.effective}`,
    `- identités de l'utilisateur : ${status.selfIdentities.length > 0 ? status.selfIdentities.join(", ") : "(aucune)"}`,
    `- actions en attente d'approbation : ${status.pending}${status.pending > 0 ? " (à trancher par l'utilisateur dans OMP Console)" : ""}`,
    `- profil mis à jour : ${status.profileUpdatedAt === null ? "jamais" : iso(status.profileUpdatedAt)}`,
    `- dernier service de l'agent : ${status.lastShift === null ? "aucun" : `${iso(status.lastShift.at)} — ${status.lastShift.outcome} (${status.lastShift.actions} action(s))`}`,
    `- prochain service : ${iso(status.nextShiftAt)}`,
  ].join("\n");
}

/** Le profil établi et les statistiques d'observation, en Markdown. */
export function renderProfile(profile: WorkstationProfile | null, stats: ProfileStats): string {
  const lines =
    profile === null
      ? ["# Profil du poste", "(pas encore établi : l'observation continue)"]
      : [
          `# Profil du poste (version ${profile.version}, mis à jour ${iso(profile.updatedAt)})`,
          profile.summary,
          "",
          "## Habitudes",
          ...list(profile.habits),
          "",
          "## Outils",
          ...list(profile.tools.map((item) => `${item.name} : ${item.usage}`)),
          "",
          "## Horaires",
          profile.schedule || "—",
          "",
          "## Tâches répétitives",
          ...list(
            profile.repetitiveTasks.map(
              (item) =>
                `${item.title} (${item.frequency}${item.automatable ? ", automatisable" : ""}) : ${item.steps.join(" → ")}`,
            ),
            "(aucune)",
          ),
          "",
          "## Besoins des clients",
          ...list(
            profile.clientNeeds.map(
              (item) =>
                `${item.need}${item.who ? ` — ${item.who}` : ""}${item.meetingId ? ` (meeting ${item.meetingId}${item.at !== null ? `, ${iso(item.at)}` : ""})` : ""}`,
            ),
          ),
          "",
          "## Préférences",
          ...list(profile.preferences, "(aucune)"),
        ];
  const hours = stats.activeHours
    .map((seconds, hour) => ({ hour, seconds }))
    .filter((item) => item.seconds > 0)
    .map((item) => `${item.hour} h : ${duration(item.seconds)}`);
  lines.push(
    "",
    "## Ce qui a été observé",
    `- temps actif : ${duration(stats.observedSeconds)}${stats.since !== null ? `, depuis ${iso(stats.since)}` : ""}`,
    `- sites : ${stats.topSites.map((item) => `${item.host} ${Math.round(item.share * 100)} % (${duration(item.seconds)})`).join(", ") || "(aucun)"}`,
    `- heures actives (heure locale) : ${hours.join(", ") || "(aucune)"}`,
    "- enchaînements récurrents :",
    ...(stats.sequences.length === 0
      ? ["  (aucun)"]
      : stats.sequences.map((item) => `  - ${item.steps.join(" → ")} (×${item.count})`)),
  );
  return lines.join("\n");
}

/** L'activité observée, une ligne par observation. */
export function renderActivity(observations: Observation[]): string {
  if (observations.length === 0) return "(aucune activité observée sur la période)";
  return observations
    .map((item) =>
      item.kind === "visit"
        ? `${iso(item.at)} visite « ${item.title} » ${item.url} (${duration(item.durationMs / 1000)})`
        : `${iso(item.at)} ${item.action} sur ${item.target.role} « ${item.target.label} » — « ${item.title} » ${item.url}`,
    )
    .join("\n");
}

function renderNeeds(needs: Meeting["needs"]): string[] {
  return needs.map(
    (item) =>
      `  - ${item.need}${item.who ? ` — ${item.who}` : ""}${item.due ? ` (échéance : ${item.due})` : ""}${item.quote ? ` « ${item.quote} »` : ""}`,
  );
}

function meetingHeader(meeting: Meeting): string {
  return `[${meeting.id}] ${meeting.title} — ${meeting.state}, ${iso(meeting.startedAt)} → ${meeting.endedAt === null ? "en cours" : iso(meeting.endedAt)}, ${meeting.segments} segment(s) transcrit(s)`;
}

/** Les meetings, du plus récent au plus ancien. */
export function renderMeetings(meetings: Meeting[]): string {
  if (meetings.length === 0) return "(aucun meeting transcrit)";
  return meetings
    .flatMap((meeting) => [
      `- ${meetingHeader(meeting)}`,
      ...(meeting.summary ? [`  résumé : ${meeting.summary}`] : []),
      ...renderNeeds(meeting.needs),
    ])
    .join("\n");
}

/** Un meeting et son transcript, chaque segment marqué par qui parle. */
export function renderMeeting(meeting: Meeting, transcript: Segment[]): string {
  return truncate(
    [
      `# ${meetingHeader(meeting)}`,
      meeting.url,
      `résumé : ${meeting.summary ?? "(pas encore de digest)"}`,
      ...(meeting.needs.length > 0 ? ["besoins exprimés :", ...renderNeeds(meeting.needs)] : []),
      "",
      "## Transcript (« moi » = l'utilisateur, « autres » = les autres participants)",
      ...(transcript.length === 0
        ? ["(aucun segment)"]
        : transcript.map((segment) => `${iso(segment.at)} ${segment.speaker} : ${segment.text}`)),
    ].join("\n"),
    OUTPUT_LIMIT,
  );
}

/** Une action du journal : la décision (le pourquoi), son état et son issue. */
export function renderAction(action: WorkstationAction): string {
  const lines = [
    `#${action.seq} ${iso(action.createdAt)} [${STATE_LABELS[action.state] ?? action.state}] ${action.kind} ${JSON.stringify(action.params)} — par ${action.origin === "agent" ? "l'agent 24/24" : `une session (${action.by ?? "?"})`}`,
    `  pourquoi : ${action.rationale}`,
  ];
  if (action.approval) {
    const { approval } = action;
    lines.push(
      `  approbation : ${approval.summary}${approval.recipients.length > 0 ? ` → ${approval.recipients.join(", ")}` : ""}${
        approval.decidedBy ? ` ; tranchée par ${approval.decidedBy} le ${iso(approval.decidedAt)}` : ""
      }${approval.reason ? ` ; raison : ${approval.reason}` : ""}`,
    );
  }
  if (action.result?.text) lines.push(`  résultat : ${truncate(action.result.text, 300)}`);
  if (action.error) lines.push(`  erreur : ${action.error}`);
  return lines.join("\n");
}

/** Le journal des décisions du poste, le plus récent d'abord. */
export function renderJournal(actions: WorkstationAction[]): string {
  return actions.length === 0 ? "(journal vide)" : actions.map(renderAction).join("\n");
}

type SnapshotData = {
  title?: string;
  url?: string;
  text?: string;
  elements?: { ref: string; role: string; label: string; value?: string }[];
};

function renderResult(action: WorkstationAction): string {
  const { result } = action;
  if (result === null) return "";
  const data = result.data;
  if (action.kind === "open" && data !== null && typeof data === "object" && "tabId" in data)
    return `Onglet ouvert dans la fenêtre de l'agent : tabId ${String(data.tabId)}. Lis-le avec snapshot { tabId: ${String(data.tabId)} }.`;
  if (action.kind === "snapshot" && data !== null && typeof data === "object") {
    const page = data as SnapshotData;
    const elements = page.elements ?? [];
    return [
      `« ${page.title ?? ""} » ${page.url ?? ""}`,
      "## Texte",
      page.text ?? "",
      `## Éléments (${elements.length}) — agis par ref (click { tabId, ref }, type { tabId, ref, text })`,
      ...elements.map(
        (item) =>
          `- [${item.ref}] ${item.role} « ${item.label} »${item.value !== undefined ? ` = « ${item.value} »` : ""}`,
      ),
    ].join("\n");
  }
  return [result.text ?? "", data !== undefined && data !== null ? JSON.stringify(data, null, 2) : ""]
    .filter(Boolean)
    .join("\n");
}

/** Ce que rend `workstation_act` pour l'état où l'action s'est arrêtée. */
export function renderActOutcome(action: WorkstationAction, waited: number): { text: string; isError: boolean } {
  const head = `Action #${action.seq} (${action.kind})`;
  switch (action.state) {
    case "done": {
      if (action.kind === "decision") return { text: `${head} : décision journalisée.`, isError: false };
      const body = renderResult(action);
      return { text: truncate(`${head} faite.${body ? `\n${body}` : ""}`, OUTPUT_LIMIT), isError: false };
    }
    case "awaiting_approval": {
      const approval = action.approval;
      return {
        text: [
          `${head} EN ATTENTE DE L'APPROBATION DE L'HUMAIN${approval ? ` : ${approval.summary}` : ""}.`,
          ...(approval
            ? [
                `Destinataires : ${approval.recipients.length > 0 ? approval.recipients.join(", ") : "(inconnus)"}`,
                `Aperçu : ${approval.preview}`,
              ]
            : []),
          APPROVAL_RULE,
        ].join("\n"),
        isError: false,
      };
    }
    case "refused":
    case "expired":
      return {
        text: `${head} ${action.state === "expired" ? "expirée sans réponse de l'humain, ce qui vaut refus" : `refusée par l'humain${action.approval?.reason ? ` : ${action.approval.reason}` : ""}`}. Ne la refais pas ; demande à l'utilisateur comment poursuivre.`,
        isError: true,
      };
    case "failed":
      return { text: `${head} échouée : ${action.error ?? "raison inconnue"}`, isError: true };
    default:
      return {
        text: `${head} toujours ${STATE_LABELS[action.state] ?? action.state} après ${waited} s d'attente. Ne la redépose pas : suis-la avec workstation_journal.`,
        isError: false,
      };
  }
}

/** Enregistre les outils du poste de travail sur `pi`. */
export function registerWorkstationTools(pi: ExtensionAPI, deps: Pick<ToolDeps, "fetcher"> = {}): void {
  const { z } = pi.zod;
  const { fetcher } = deps;

  pi.registerTool({
    name: "workstation_status",
    label: "Poste — état",
    loadMode: "essential",
    description:
      "Lit l'état du poste de travail (Chrome sur le Mac de l'utilisateur, piloté par l'extension omp-chrome) : extension en ligne ou non, pause, temps observé, autonomie, actions en attente d'approbation, services de l'agent 24/24. Lecture seule ; à lire avant d'agir avec workstation_act.",
    parameters: z.object({}),
    async execute(
      _id: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      try {
        return text(
          renderStatus(await harnessCall<WorkstationStatus>(target, "GET", "/v1/workstation", undefined, { fetcher })),
        );
      } catch (err) {
        return text(failure(err), true);
      }
    },
  });

  pi.registerTool({
    name: "workstation_profile",
    label: "Poste — profil",
    loadMode: "essential",
    description:
      "Lit le profil de travail de l'utilisateur établi en l'observant dans Chrome : habitudes, outils, horaires, tâches répétitives, besoins de ses clients (tirés des meetings), préférences, et les statistiques brutes d'observation. Lecture seule.",
    parameters: z.object({}),
    async execute(
      _id: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      try {
        const { profile, stats } = await harnessCall<{ profile: WorkstationProfile | null; stats: ProfileStats }>(
          target,
          "GET",
          "/v1/workstation/profile",
          undefined,
          { fetcher },
        );
        return text(renderProfile(profile, stats));
      } catch (err) {
        return text(failure(err), true);
      }
    },
  });

  pi.registerTool({
    name: "workstation_activity",
    label: "Poste — activité récente",
    loadMode: "essential",
    description:
      "Lit l'activité observée dans Chrome : pages visitées (titre, adresse, durée) et interactions (clic, saisie, envoi — jamais les valeurs saisies), du plus ancien au plus récent. Lecture seule.",
    parameters: z.object({
      sinceMin: z.number().int().optional().describe("Fenêtre en minutes jusqu'à maintenant ; absent : 60"),
      limit: z.number().int().optional().describe("Nombre d'observations, au plus 500 ; absent : 100"),
    }),
    async execute(
      _id: string,
      params: ActivityParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      const since = Date.now() - bound(params.sinceMin, 60, Number.MAX_SAFE_INTEGER) * 60_000;
      const limit = bound(params.limit, 100, 500);
      try {
        const { observations } = await harnessCall<{ observations: Observation[] }>(
          target,
          "GET",
          `/v1/workstation/observations?since=${since}&limit=${limit}`,
          undefined,
          { fetcher },
        );
        return text(truncate(renderActivity(observations), OUTPUT_LIMIT));
      } catch (err) {
        return text(failure(err), true);
      }
    },
  });

  pi.registerTool({
    name: "workstation_meetings",
    label: "Poste — meetings",
    loadMode: "essential",
    description:
      "Lit les meetings transcrits sur le poste (micro de l'utilisateur et audio de l'onglet, transcrits sur le Mac) : sans `id`, la liste avec résumés et besoins exprimés ; avec `id`, un meeting et son transcript, chaque segment marqué « moi » (l'utilisateur) ou « autres ». Lecture seule.",
    parameters: z.object({
      id: z.string().optional().describe("L'id d'un meeting (lu dans la liste) ; absent : la liste"),
    }),
    async execute(
      _id: string,
      params: MeetingsParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      try {
        if (params.id) {
          const { meeting, transcript } = await harnessCall<{ meeting: Meeting; transcript: Segment[] }>(
            target,
            "GET",
            `/v1/workstation/meetings/${encodeURIComponent(params.id)}`,
            undefined,
            { fetcher },
          );
          return text(renderMeeting(meeting, transcript));
        }
        const { meetings } = await harnessCall<{ meetings: Meeting[] }>(
          target,
          "GET",
          "/v1/workstation/meetings?limit=20",
          undefined,
          { fetcher },
        );
        return text(truncate(renderMeetings(meetings), OUTPUT_LIMIT));
      } catch (err) {
        return text(failure(err), true);
      }
    },
  });

  pi.registerTool({
    name: "workstation_journal",
    label: "Poste — journal des décisions",
    loadMode: "essential",
    description:
      "Lit le journal des actions du poste, le plus récent d'abord : chaque action porte sa raison (la décision journalisée), son état, son origine (une session ou l'agent 24/24), l'approbation humaine et son issue. Lecture seule ; c'est ici qu'on suit une action en attente d'approbation.",
    parameters: z.object({
      state: z
        .string()
        .optional()
        .describe(`Filtre d'états séparés par des virgules, parmi ${ACTION_STATES.join(", ")} ; absent : tous`),
      limit: z.number().int().optional().describe("Nombre d'actions, au plus 200 ; absent : 30"),
    }),
    async execute(
      _id: string,
      params: JournalParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      const states = (params.state ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const unknown = states.filter((item) => !(ACTION_STATES as readonly string[]).includes(item));
      if (unknown.length > 0)
        return text(
          `workstation_journal : état inconnu ${unknown.join(", ")} (attendus : ${ACTION_STATES.join(", ")}).`,
          true,
        );
      const query = [
        ...(states.length > 0 ? [`state=${states.join(",")}`] : []),
        `limit=${bound(params.limit, 30, 200)}`,
      ].join("&");
      try {
        const { actions } = await harnessCall<{ actions: WorkstationAction[] }>(
          target,
          "GET",
          `/v1/workstation/actions?${query}`,
          undefined,
          { fetcher },
        );
        return text(truncate(renderJournal(actions), OUTPUT_LIMIT));
      } catch (err) {
        return text(failure(err), true);
      }
    },
  });

  pi.registerTool({
    name: "workstation_act",
    label: "Poste — agir dans le navigateur",
    loadMode: "essential",
    approval: actApproval,
    description: [
      "Agit dans Chrome sur le Mac de l'utilisateur (le navigateur SEULEMENT : aucun accès au reste du bureau), à travers l'extension omp-chrome. Chaque action est une décision journalisée.",
      "Méthode : `open` { url } ouvre un onglet dans la fenêtre de l'agent (non focalisée, ne dérange pas l'utilisateur) et rend son tabId ; `snapshot` { tabId } rend le texte de la page et ses éléments avec un `ref` ; puis `click` { tabId, ref }, `type` { tabId, ref, text, submit? }, `key` { tabId, ref?, key } (Enter, Escape, Tab, flèches, Backspace) avec un ref du DERNIER snapshot de l'onglet. Refais un snapshot après chaque changement de page.",
      "Autres kinds : `tabs` {} (onglets ouverts), `navigate` { tabId, url }, `scroll` { tabId, dy }, `screenshot` { tabId } (rend l'image), `wait` { ms ≤ 10000 }, `close` { tabId }, `decision` {} (journalise une décision sans rien exécuter).",
      "`rationale` est OBLIGATOIRE et doit dire vraiment pourquoi tu fais ce geste : c'est la décision que l'utilisateur relit dans le journal.",
      "Tout message à quelqu'un d'autre que l'utilisateur (mail, chat, commentaire, publication…) est retenu et attend l'approbation de l'humain dans l'app OMP Console : ne cherche jamais à contourner cette garde, ne réessaie pas, dis à l'utilisateur d'approuver dans l'app. Hors ligne ou en pause, le poste refuse toute action.",
    ].join(" "),
    parameters: z.object({
      kind: z.enum(ACTION_KINDS).describe("Le geste"),
      params: z.record(z.string(), z.unknown()).describe("Les paramètres du geste (voir la description), {} si aucun"),
      rationale: z.string().describe("Pourquoi ce geste : la décision journalisée, jamais vide"),
      waitSec: z
        .number()
        .int()
        .optional()
        .describe(`Attente du résultat en secondes, de 0 à ${ACT_WAIT_MAX} ; absent : ${ACT_WAIT_DEFAULT}`),
    }),
    async execute(
      _id: string,
      params: ActParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      if (!(ACTION_KINDS as readonly string[]).includes(params.kind))
        return text(`workstation_act : kind inconnu « ${params.kind} » (attendus : ${ACTION_KINDS.join(", ")}).`, true);
      if (typeof params.rationale !== "string" || params.rationale.trim() === "")
        return text("workstation_act : `rationale` est obligatoire — dis pourquoi tu fais ce geste.", true);
      const actionParams = params.params ?? {};
      if (actionParams === null || typeof actionParams !== "object" || Array.isArray(actionParams))
        return text("workstation_act : `params` doit être un objet ({} si le geste n'en prend pas).", true);
      const budget = actWait(params.waitSec);
      const started = Date.now();
      try {
        let { action } = await harnessCall<{ action: WorkstationAction }>(
          target,
          "POST",
          "/v1/workstation/actions",
          { kind: params.kind, params: actionParams, rationale: params.rationale },
          { fetcher },
        );
        let image: string | undefined;
        while (action.state === "queued" || action.state === "running") {
          const left = budget * 1000 - (Date.now() - started);
          if (left <= 0 || signal?.aborted) break;
          const asked = Date.now();
          const wait = Math.min(POLL_SLICE, Math.ceil(left / 1000));
          ({ action, image } = await harnessCall<{ action: WorkstationAction; image?: string }>(
            target,
            "GET",
            `/v1/workstation/actions/${action.seq}?wait=${wait}`,
            undefined,
            { fetcher },
          ));
          // Un serveur qui rend aussitôt une action encore en cours : pas de boucle serrée.
          if ((action.state === "queued" || action.state === "running") && Date.now() - asked < 1000)
            await sleep(1000, undefined, { signal }).catch(() => undefined);
        }
        const outcome = renderActOutcome(action, Math.round((Date.now() - started) / 1000));
        if (action.state === "done" && action.kind === "screenshot") {
          if (typeof image === "string" && image !== "")
            return {
              content: [
                { type: "text" as const, text: outcome.text },
                { type: "image" as const, data: image, mimeType: "image/jpeg" },
              ],
            };
          return text(
            `${outcome.text}\nL'image n'a pas été transmise (elle n'est gardée que pour l'appel qui attend) : refais un screenshot avec un waitSec suffisant.`,
            true,
          );
        }
        return text(outcome.text, outcome.isError);
      } catch (err) {
        return text(failure(err), true);
      }
    },
  });
}
