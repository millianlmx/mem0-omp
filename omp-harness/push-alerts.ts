// Les alertes push des appareils (app iOS) : APNs `push-type: alert`, pour ce qui attend
// l'humain ou casse — specs ou verdict à valider, escalade, envoi du poste à approuver,
// run échoué, alerte de veille (agent muet, budget), vigie muette, sauvegarde échouée.
//
// Chaque appareil (`POST /v1/push/devices`) est lié au client qui l'a enregistré, et ses
// droits sont relus à chaque envoi : un appareil ne reçoit que les runs des dépôts que
// voit son client, les alertes du serveur (poste, vigie, sauvegardes, plafond du jour)
// seulement si son client voit tous les dépôts, et un envoi du poste seulement si son
// client est l'approbateur. Un appareil d'un client révoqué est oublié.
//
// La charge est minimale : un titre, le dépôt et le titre du run, et des identifiants
// (`omp.kind`, `runId`, `rev`, `seq`) — jamais le contenu du poste (ni résumé, ni
// destinataires, ni brouillon), jamais une raison d'échec ni la question d'une escalade sans carte.
// Une escalade à carte porte sa `headline` (titre) et son `stake` (corps) seulement : la carte
// est écrite pour être lue d'un coup d'œil, sans chemin ni code. Le nombre de
// preuves d'un verdict n'est pas du contenu de run : il s'ajoute au corps. La
// `category` dit le geste que l'appareil peut faire de la notification : valider ou
// refuser (specs, verdict : opérateur au moins), approuver ou refuser (envoi du poste :
// approbateur), sinon ouvrir. `rev` est l'If-Match du geste : la révision du run, ou
// l'`updatedAt` de l'envoi. Les notifications d'un run se groupent (`thread-id`).
//
// Une même alerte ne part qu'une fois (clé par alerte, mémoire de 12 h, aussi
// `apns-collapse-id`) : un événement rejoué ou répété ne réveille pas l'iPhone deux fois.
// Un jeton refusé par Apple (410, BadDeviceToken, Unregistered) est oublié.
import { createHash } from "node:crypto";
import type { Client } from "./auth.ts";
import { allows, canSeeRepo } from "./auth.ts";
import { batchLead } from "./card.ts";
import type { ApnsConfig } from "./config.ts";
import type { EventRow, RunRow, Store } from "./db.ts";
import type { LogLine } from "./logger.ts";
import type { ApnsClient } from "./push.ts";
import { tokenGone } from "./push.ts";
import { proofCountText } from "./proofs.ts";

/** Les catégories de notification de l'app : les gestes qu'elle offre sur la notification. */
export const ALERT_CATEGORIES = {
  validate: "omp.validate",
  approve: "omp.approve",
  open: "omp.open",
} as const;

export type AlertCategory = (typeof ALERT_CATEGORIES)[keyof typeof ALERT_CATEGORIES];

/** Les sortes d'alerte (`omp.kind`) : l'app les lit pour router un toucher ou un geste. */
export const ALERT_KINDS = [
  "specs",
  "verdict",
  "escalation",
  "approval",
  "run_failed",
  "stalled",
  "budget",
  "daily_budget",
  "vigie_silent",
  "backup_failed",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

/** Une alerte, avant de savoir à qui elle part. */
export type Alert = {
  kind: AlertKind;
  title: string;
  body: string;
  runId: string | null;
  /** Le dépôt du run : seuls les clients qui le voient la reçoivent (`null` : alerte du serveur). */
  repo: string | null;
  /** L'If-Match du geste : la révision du run (specs, verdict), l'`updatedAt` de l'envoi du poste. */
  rev: number | null;
  /** Le numéro de l'action du poste. */
  seq: number | null;
  /** Le regroupement des notifications sur l'appareil. */
  thread: string;
  /** La clé de dédoublonnage. */
  key: string;
  /** `owner` : les clients qui voient tous les dépôts ; `approver` : l'approbateur seul. */
  audience: "repo" | "owner" | "approver";
  /** Le geste que permet la notification, selon les droits du client. */
  gesture: "validate" | "approve" | null;
};

/** Une alerte n'est pas renvoyée avant ce délai. */
export const ALERT_DEDUP_MS = 12 * 60 * 60 * 1000;
/** Au-delà de ce nombre de clés retenues, les expirées sont oubliées. */
const DEDUP_PRUNE_AT = 512;

function runAlert(run: RunRow, kind: AlertKind, title: string, key: string, gesture: Alert["gesture"] = null): Alert {
  return {
    kind,
    title,
    // Le dépôt d'abord : l'humain suit plusieurs projets.
    body: `${run.repo} · ${run.title}`,
    runId: run.id,
    repo: run.repo,
    rev: run.rev,
    seq: null,
    thread: run.id,
    key,
    audience: "repo",
    gesture,
  };
}

function serverAlert(kind: AlertKind, title: string, body: string, key: string): Alert {
  return {
    kind,
    title,
    body,
    runId: null,
    repo: null,
    rev: null,
    seq: null,
    thread: "server",
    key,
    audience: "owner",
    gesture: null,
  };
}

/** L'alerte d'un événement du journal, ou `null` s'il n'en mérite pas (ou que son sujet a déjà bougé). */
export function alertFor(event: EventRow, store: Store): Alert | null {
  const payload = event.payload;
  const run = event.runId !== null ? store.getRun(event.runId) : null;
  switch (event.type) {
    case "specs_ready":
      return run ? runAlert(run, "specs", "Specs à valider", `specs:${run.id}:${run.rev}`, "validate") : null;
    case "verdict": {
      if (!run) return null;
      const alert = runAlert(run, "verdict", "Verdict à valider", `verdict:${run.id}:${run.rev}`, "validate");
      if (typeof payload.proofs === "number") alert.body = `${alert.body} · ${proofCountText(payload.proofs)}`;
      return alert;
    }
    case "escalations": {
      if (!run) return null;
      const ids = (Array.isArray(payload.items) ? payload.items : [])
        .map((item) => (item !== null && typeof item === "object" && "id" in item ? Number(item.id) : Number.NaN))
        .filter(Number.isInteger)
        .sort((a, b) => a - b);
      if (ids.length === 0) return null;
      const alert = runAlert(run, "escalation", "", `escalation:${run.id}:${ids.join(",")}`);
      // Une escalade à carte : la headline et le stake de la première, rien d'autre (jamais option ni contexte).
      const lead = batchLead(Array.isArray(payload.items) ? payload.items : []);
      if (lead) return { ...alert, title: lead.headline, body: lead.body };
      // Les mots de l'app (vouvoiement, « feature » plutôt que « run ») : la notification est la sienne.
      const title =
        ids.length === 1 ? "Une question attend votre réponse" : `${ids.length} questions attendent votre réponse`;
      return { ...alert, title };
    }
    case "workstation_approval": {
      const seq = Number(payload.seq);
      const action = Number.isInteger(seq) ? store.getWorkstationAction(seq) : null;
      if (action?.state !== "awaiting_approval") return null;
      return {
        kind: "approval",
        title: "Poste — envoi à approuver",
        body: "Rien ne part sans votre accord.",
        runId: null,
        repo: null,
        rev: action.updatedAt,
        seq: action.seq,
        thread: "workstation",
        key: `approval:${action.seq}:${action.updatedAt}`,
        audience: "approver",
        gesture: "approve",
      };
    }
    case "run_failed":
      return run ? runAlert(run, "run_failed", "Feature en échec", `run_failed:${run.id}:${run.rev}`) : null;
    case "stalled":
      return run ? runAlert(run, "stalled", "Agent muet", `stalled:${run.id}`) : null;
    case "budget_exceeded":
      return run ? runAlert(run, "budget", "Budget dépassé", `budget:${run.id}:${String(payload.threshold)}`) : null;
    case "daily_budget_reached":
      return serverAlert(
        "daily_budget",
        "Plafond journalier atteint",
        "Plus aucune étape ne démarre avant minuit UTC ou un plafond relevé.",
        `daily_budget:${String(payload.day)}`,
      );
    case "vigie_silent": {
      const minutes = typeof payload.silentSec === "number" ? Math.round(payload.silentSec / 60) : null;
      return serverAlert(
        "vigie_silent",
        "Vigie muette",
        minutes === null ? "La vigie ne donne plus signe de vie." : `Aucun signe de la vigie depuis ${minutes} min.`,
        `vigie_silent:${String(payload.lastAt)}`,
      );
    }
    case "backup_failed": {
      const remote = payload.where === "remote";
      return serverAlert(
        "backup_failed",
        "Sauvegarde échouée",
        remote ? "La copie distante de la base a échoué." : "La sauvegarde locale de la base a échoué.",
        `backup_failed:${remote ? "remote" : "local"}`,
      );
    }
    default:
      return null;
  }
}

/** Ce client reçoit-il cette alerte ? */
export function receives(alert: Alert, client: Client): boolean {
  switch (alert.audience) {
    case "approver":
      return client.approver;
    case "owner":
      return client.repos === "*";
    case "repo":
      return alert.repo !== null && canSeeRepo(client, alert.repo);
  }
}

/** La catégorie de la notification pour ce client : le geste qu'il a le droit de faire, sinon ouvrir. */
export function categoryFor(alert: Alert, client: Client): AlertCategory {
  if (alert.gesture === "approve" && client.approver) return ALERT_CATEGORIES.approve;
  if (alert.gesture === "validate" && allows(client.role, "operator")) return ALERT_CATEGORIES.validate;
  return ALERT_CATEGORIES.open;
}

/** Le corps APNs : le texte, le regroupement, la catégorie, et les seuls identifiants du geste. */
export function alertPayload(alert: Alert, category: AlertCategory): Record<string, unknown> {
  return {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: "default",
      "thread-id": alert.thread,
      category,
    },
    omp: {
      kind: alert.kind,
      ...(alert.runId !== null ? { runId: alert.runId } : {}),
      ...(alert.rev !== null ? { rev: alert.rev } : {}),
      ...(alert.seq !== null ? { seq: alert.seq } : {}),
    },
  };
}

export type AlertDeps = {
  store: Store;
  apns: ApnsClient;
  config: () => ApnsConfig | null;
  log?: LogLine;
  now?: () => number;
};

export class AlertPusher {
  readonly #deps: AlertDeps;
  readonly #now: () => number;
  /** Les clients du serveur (auth.ts) ; sans eux, rien ne part (échec fermé). */
  #clients: { list(): Client[] } | null = null;
  /** Clé d'alerte → instant de son envoi. */
  readonly #sent = new Map<string, number>();
  readonly #inFlight = new Set<Promise<void>>();

  constructor(deps: AlertDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Le registre des clients de l'API : les droits de chaque appareil y sont relus à chaque envoi. */
  useClients(clients: { list(): Client[] }): void {
    this.#clients = clients;
  }

  subscribe(): () => void {
    return this.#deps.store.onEvent((event) => this.handle(event));
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
  }

  handle(event: EventRow): void {
    if (event.ephemeral) return;
    // Un agent qui reparle : son prochain silence est une nouvelle alerte.
    if (event.type === "alert_cleared" && event.payload.kind === "stalled" && event.runId !== null) {
      this.#sent.delete(`stalled:${event.runId}`);
      return;
    }
    if (this.#clients === null || !this.#deps.apns.configured) return;
    const alert = alertFor(event, this.#deps.store);
    if (alert === null || this.#isDuplicate(alert.key)) return;
    const clients = new Map(this.#clients.list().map((client) => [client.name, client]));
    const targets: { token: string; sandbox: boolean; category: AlertCategory }[] = [];
    for (const device of this.#deps.store.listPushDevices()) {
      const client = clients.get(device.client);
      if (!client) {
        this.#deps.store.deletePushDevice(device.token);
        continue;
      }
      if (!receives(alert, client)) continue;
      targets.push({
        token: device.token,
        sandbox: device.environment === "sandbox",
        category: categoryFor(alert, client),
      });
    }
    if (targets.length === 0) return;
    const sending = this.#send(alert, targets).finally(() => this.#inFlight.delete(sending));
    this.#inFlight.add(sending);
  }

  #isDuplicate(key: string): boolean {
    const now = this.#now();
    const last = this.#sent.get(key);
    if (last !== undefined && now - last < ALERT_DEDUP_MS) return true;
    if (this.#sent.size >= DEDUP_PRUNE_AT)
      for (const [known, at] of this.#sent) if (now - at >= ALERT_DEDUP_MS) this.#sent.delete(known);
    this.#sent.set(key, now);
    return false;
  }

  async #send(alert: Alert, targets: { token: string; sandbox: boolean; category: AlertCategory }[]): Promise<void> {
    const config = this.#deps.config();
    const send = this.#deps.apns.sender();
    if (!config || !send) return;
    for (const target of targets) {
      const reply = await send({
        token: target.token,
        sandbox: target.sandbox,
        headers: {
          "apns-topic": config.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          // 64 octets au plus : une clé plus longue part en empreinte.
          "apns-collapse-id":
            Buffer.byteLength(alert.key) <= 64 ? alert.key : createHash("sha256").update(alert.key).digest("hex"),
          "content-type": "application/json",
        },
        body: JSON.stringify(alertPayload(alert, target.category)),
      });
      if (tokenGone(reply)) this.#deps.store.deletePushDevice(target.token);
      else if (reply.status !== 200)
        this.#deps.log?.(`apns (alerte) : ${reply.status} ${reply.reason ?? ""}`.trim(), { level: "warn" });
    }
  }
}
