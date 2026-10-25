// Les notifications sortantes : un POST ntfy par événement qui attend l'humain ou
// qui clôt quelque chose (`config.notify.events`), pour être prévenu sans l'app ouverte.
//
// Format ntfy (https://docs.ntfy.sh/publish/) : le corps est le texte, les en-têtes
// `Title`, `Priority` (1-5), `Tags` (emojis) et `Click` (URL ouverte au toucher). Un
// webhook quelconque reçoit la même chose. Fire-and-forget : une erreur n'arrête
// rien et n'est journalisée (log + événement `notify_failed`) qu'une fois par heure.
import type { HarnessConfig } from "./config.ts";
import type { EventRow, RunRow, Store } from "./db.ts";

export type Notification = {
  title: string;
  body: string;
  /** La priorité ntfy : 1 (min) à 5 (urgent). */
  priority: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  click: string | null;
};

/** Une heure : la cadence maximale des erreurs d'envoi journalisées. */
const ERROR_LOG_EVERY_MS = 60 * 60 * 1000;

const SEND_TIMEOUT_MS = 10_000;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function short(value: string, max = 200): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Une valeur d'en-tête HTTP : les en-têtes n'admettent que du Latin-1, et fetch
 * refuse le reste. Un titre accentué ou avec un tiret cadratin part encodé en
 * RFC 2047 (`=?UTF-8?B?…?=`), que ntfy décode.
 */
export function headerValue(value: string): string {
  const flat = value.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

/** Le message d'un événement, ou `null` si cet événement n'a rien à dire à l'humain. */
export function notificationFor(event: EventRow, run: RunRow | null): Notification | null {
  // Le dépôt d'abord : l'humain suit plusieurs projets, une notification doit dire lequel.
  const feature = run ? `${run.repo} · ${run.title}` : (event.runId ?? "");
  const payload = event.payload;
  switch (event.type) {
    case "escalations": {
      const items = Array.isArray(payload.items) ? payload.items : [];
      const first = items[0];
      const question = first !== null && typeof first === "object" && "question" in first ? text(first.question) : "";
      return {
        title: `Question — ${feature}`,
        body: short(
          `${items.length} question(s) à l'étape ${text(payload.step, run?.step ?? "?")}${question ? ` : ${question}` : ""}`,
        ),
        priority: 4,
        tags: ["question"],
        click: null,
      };
    }
    case "specs_ready":
      return {
        title: `Specs à valider — ${feature}`,
        body: short(text(payload.reason, "les specs attendent ton accord")),
        priority: 4,
        tags: ["clipboard"],
        click: null,
      };
    case "verdict": {
      const verdict = payload.verdict;
      const summary =
        verdict !== null && typeof verdict === "object" && "summary" in verdict ? text(verdict.summary) : "";
      return {
        title: `Verdict à valider — ${feature}`,
        body: short([text(payload.reason), summary].filter(Boolean).join(" — ") || "la revue attend ta validation"),
        priority: 4,
        tags: ["eyes"],
        click: null,
      };
    }
    case "run_failed":
      return {
        title: `Run échoué — ${feature}`,
        body: short(text(payload.reason, run?.reason ?? "cause inconnue")),
        priority: 4,
        tags: ["x"],
        click: null,
      };
    case "push_failed":
      return {
        title: `Push refusé — ${feature}`,
        body: short(text(payload.detail, "le distant a refusé main")),
        priority: 4,
        tags: ["warning"],
        click: null,
      };
    case "merged": {
      const prUrl = text(payload.prUrl, run?.prUrl ?? "");
      return {
        title: `Mergé — ${feature}`,
        body: short(`${text(payload.sha).slice(0, 12)}${prUrl ? ` · ${prUrl}` : ""}` || "fusionné dans main"),
        priority: 3,
        tags: ["white_check_mark"],
        click: prUrl || null,
      };
    }
    case "reverted":
      return {
        title: `Revert — ${feature}`,
        body: short(`main revient avant ${text(payload.revertedSha).slice(0, 12)} (${text(payload.sha).slice(0, 12)})`),
        priority: 4,
        tags: ["rewind"],
        click: null,
      };
    case "project_done": {
      const merged = typeof payload.merged === "number" ? payload.merged : 0;
      const other = typeof payload.notMerged === "number" ? payload.notMerged : 0;
      return {
        title: `Projet terminé — ${text(payload.title, text(payload.projectId))}`,
        body: short(`${merged} feature(s) mergée(s)${other > 0 ? `, ${other} échouée(s) ou annulée(s)` : ""}`),
        priority: 3,
        tags: ["tada"],
        click: null,
      };
    }
    case "decision_auto_timeout":
      return {
        title: `Tranché à l'échéance — ${feature}`,
        body: short(`${text(payload.question)} → ${text(payload.answer, text(payload.chosen))} (à relire)`),
        priority: 3,
        tags: ["hourglass"],
        click: null,
      };
    case "stalled":
      return {
        title: `Agent muet — ${feature}`,
        body: short(
          `aucun signe de l'agent depuis ${typeof payload.minutes === "number" ? payload.minutes : "?"} min à l'étape ${text(payload.step, run?.step ?? "?")}${text(payload.tool) ? ` (outil ${text(payload.tool)})` : ""}`,
        ),
        priority: 4,
        tags: ["hourglass_flowing_sand"],
        click: null,
      };
    case "step_slow":
      return {
        title: `Étape lente — ${feature}`,
        body: short(
          `/${text(payload.step, "?")} dure depuis ${typeof payload.minutes === "number" ? payload.minutes : "?"} min (médiane ${typeof payload.medianMin === "number" ? payload.medianMin : "?"} min)`,
        ),
        priority: 3,
        tags: ["snail"],
        click: null,
      };
    case "fix_loop":
      return {
        title: `Boucle de corrections — ${feature}`,
        body: short(`${typeof payload.fixes === "number" ? payload.fixes : "?"} corrections : la revue ne passe pas`),
        priority: 3,
        tags: ["repeat"],
        click: null,
      };
    case "budget_exceeded":
      return {
        title: `Budget dépassé — ${feature}`,
        body: short(
          `${typeof payload.cost === "number" ? payload.cost.toFixed(2) : "?"} $ dépensés (plafond ${typeof payload.budget === "number" ? payload.budget.toFixed(2) : "?"} $)${payload.paused === true ? " — la feature attend ton accord" : ""}`,
        ),
        priority: 4,
        tags: ["moneybag"],
        click: null,
      };
    case "daily_budget_reached":
      return {
        title: "Plafond journalier atteint",
        body: short(
          `${typeof payload.spent === "number" ? payload.spent.toFixed(2) : "?"} $ dépensés aujourd'hui (plafond ${typeof payload.ceiling === "number" ? payload.ceiling.toFixed(2) : "?"} $) — plus aucune étape ne démarre avant minuit UTC ou un plafond relevé`,
        ),
        priority: 4,
        tags: ["moneybag"],
        click: null,
      };
    case "notify_failed":
      return null;
    default:
      return {
        title: `${event.type} — ${feature}`,
        body: short(text(payload.reason, JSON.stringify(payload))),
        priority: 3,
        tags: [],
        click: null,
      };
  }
}

export class Notifier {
  readonly #config: HarnessConfig;
  readonly #store: Store;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  /** L'instant de la dernière erreur journalisée (0 : aucune). */
  #lastErrorAt = 0;
  /** Les envois en vol, pour qu'un arrêt du service les attende. */
  readonly #inFlight = new Set<Promise<void>>();

  constructor(deps: { config: HarnessConfig; store: Store; log?: (line: string) => void; now?: () => number }) {
    this.#config = deps.config;
    this.#store = deps.store;
    this.#log = deps.log ?? (() => {});
    this.#now = deps.now ?? Date.now;
  }

  /** L'abonnement au journal : rendu pour pouvoir le défaire. */
  subscribe(): () => void {
    return this.#store.onEvent((event) => this.handle(event));
  }

  /** Attend les envois en cours (arrêt du service). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
  }

  /** Un événement du journal : envoyé s'il est dans `notify.events` et qu'une URL est posée. */
  handle(event: EventRow): void {
    const { url, events } = this.#config.notify;
    if (url === null || event.ephemeral || event.type === "notify_failed" || !events.includes(event.type)) return;
    const run = event.runId ? this.#store.getRun(event.runId) : null;
    const notification = notificationFor(event, run);
    if (notification === null) return;
    const sending = this.send(url, notification).finally(() => this.#inFlight.delete(sending));
    this.#inFlight.add(sending);
  }

  /** Le POST ntfy ; une erreur est journalisée au plus une fois par heure, jamais levée. */
  async send(url: string, notification: Notification): Promise<void> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
        Title: headerValue(notification.title),
        Priority: String(notification.priority),
      };
      if (notification.tags.length > 0) headers.Tags = notification.tags.join(",");
      if (notification.click !== null) headers.Click = notification.click;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: notification.body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      this.#failed(err instanceof Error ? err.message : String(err), notification.title);
    }
  }

  #failed(detail: string, title: string): void {
    const now = this.#now();
    if (now - this.#lastErrorAt < ERROR_LOG_EVERY_MS) return;
    this.#lastErrorAt = now;
    this.#log(`notification perdue (« ${title} ») : ${detail}`);
    try {
      this.#store.appendEvent("notify_failed", null, { detail: detail.slice(0, 300), title }, null);
    } catch {
      // La base est déjà fermée (arrêt) : le log suffit.
    }
  }
}
