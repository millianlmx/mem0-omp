// Le poste de travail : le serveur est le RELAIS UNIQUE entre l'extension Chrome (qui
// observe le navigateur et y exécute des actions), les sessions OMP et l'agent 24/24 (qui
// déposent des actions), et les apps (qui lisent profil et journal, et approuvent).
//
// La file des actions est aussi le journal des décisions : chaque action porte son
// `rationale`, une décision sans geste (`decision`) y est écrite `done` sans jamais partir.
//
// La garde d'envoi (INVARIANT) : un message à quelqu'un d'autre que l'utilisateur ne part
// jamais sans un geste humain. L'extension classe chaque geste et rend `needs_approval` ;
// ici, l'action ne repart (`queued`, `approved: true`) que sur `approve` d'un client, ou si
// TOUS les destinataires extraits sont l'utilisateur lui-même (`selfIdentities`). Aucune
// échéance n'approuve : une approbation non donnée à temps passe `expired`, qui vaut refus.
// Aucun outil d'agent n'appelle `approve` ni `refuse`.
//
// Les attentes (long-poll de l'extension, attente d'un résultat) sont en mémoire : une
// promesse par appelant, réveillée par le changement attendu, l'échéance, la déconnexion
// du client ou l'arrêt du service. Rien ne bloque les autres requêtes.
//
// Le poste d'un espace (multi-client) : un navigateur peut appartenir à un ESPACE — un client
// (`workstation_browsers.space_id`, `assignBrowser`). Tout ce qui en vient GARDE l'espace que le
// navigateur avait à l'écriture (`space_id` de l'observation, du meeting, de l'action ; la capture
// suit son action) : le réattribuer ne déplace aucune ligne ; les lectures se bornent à
// un espace ; une demande posée dans un espace ne s'exécute que dans un de SES navigateurs, jamais
// le navigateur par défaut d'ailleurs ; la garde d'envoi lit les identités de l'espace du
// navigateur, le dossier d'envoi est celui de l'espace, et le mirroir de session ne copie pas d'un
// espace vers un autre. Un navigateur sans espace — et un serveur sans espace — se comportent
// exactement comme avant.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Client } from "../api/auth.ts";
import type { HarnessConfig } from "../config/config.ts";
import type { Actor, HarnessContext } from "../runs/context.ts";
import type {
  ActionOrigin,
  ActionPatch,
  ActionState,
  Approval,
  Meeting,
  MeetingNeed,
  Observation,
  RequestState,
  Segment,
  ShiftRow,
  WorkstationAction,
  WorkstationAutomation,
  WorkstationCapture,
  WorkstationProfile,
  WorkstationProfileBody,
  WorkstationRequest,
} from "../db/db.ts";
import { HarnessError } from "../api/errors.ts";
import { redact, workstationOwner } from "../sessions/session-feed.ts";
import type { SessionEntry } from "../sessions/session-feed.ts";
import { TAB_KINDS, URL_KINDS, hostListed, hostOf, opaqueQueryParam, parseAgentTabs } from "./workstation-guards.ts";
import { VPS_BROWSER } from "../browser/vps-policy.ts";
import type { AccountDomain, AccountState, AccountView } from "../browser/vps-policy.ts";
import {
  NO_HELLO,
  MAX_PREVIEW,
  MAX_SUMMARY,
  DAY_MS,
  SETTINGS_KEY,
  REQUEST_OUT_OF_SPACE,
  clip,
  clean,
  isSelfOnly,
  parseResult,
  describeGesture,
} from "./workstation-input.ts";
import type {
  EffectiveAutonomy,
  WorkstationSettings,
  BrowserHello,
  BrowserView,
  WorkstationStatus,
  ActionInput,
  Presence,
} from "./workstation-input.ts";
import { ProfileDesk } from "./workstation-profile.ts";
import type { ProfileStats } from "./workstation-profile.ts";
import { PresenceDesk } from "./workstation-presence.ts";
import { ErrandDesk } from "./workstation-errands.ts";

/** L'attente maximale d'un long-poll (s). */
export const MAX_WAIT_SEC = 30;

const PURGE_EVERY_MS = 60 * 60 * 1000;
/**
 * Un meeting `live` sans segment ni mise à jour depuis 30 min passe `ended` (son digest part) :
 * l'extension l'a perdu (onglet fermé, navigateur quitté) sans jamais appeler `…/end`.
 */
export const ORPHAN_MEETING_MS = 30 * 60 * 1000;

/** Les jobs du poste dont la session se lit (`GET /v1/workstation/session?job=`). */
export const SESSION_JOBS = {
  profil: "poste-profil",
  digest: "poste-digest",
  service: "poste-service",
  plan: "poste-plan",
  savoir: "poste-savoir",
} as const;
export type SessionJob = keyof typeof SESSION_JOBS;

/**
 * Le répertoire de travail des jobs du poste : `_poste` hors espace, `_poste-<espace>` pour un espace —
 * le job d'un client n'y trouve jamais ce que celui d'un autre y a écrit.
 */
export function posteDir(config: Pick<HarnessConfig, "worktreesDir">, space: string | null = null): string {
  return path.join(config.worktreesDir, "workstation", space === null ? "_poste" : `_poste-${space}`);
}

/** Le dossier d'envoi : les seuls fichiers qu'`upload` joint, dans le répertoire de travail des jobs du poste (celui de l'espace du navigateur). */
export function uploadDir(config: Pick<HarnessConfig, "worktreesDir">, space: string | null = null): string {
  return path.join(posteDir(config, space), "envois");
}
/** Un fichier joint par `upload` pèse au plus 10 Mio. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Le type MIME d'un fichier du dossier d'envoi, d'après son extension. */
const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};

/** Le refus d'un geste d'approbateur (approuver, refuser, régler le poste) à tout autre client. */
export const APPROVER_ONLY =
  "seul l'appareil approbateur (OMP Console appairée avec le code de `harness.sh approver`) peut approuver, refuser ou régler le poste";

/** Le poste de travail est au propriétaire : un client restreint à des dépôts n'y a pas accès. */
export function workstationFor(workstation: Workstation, client: Client): Workstation {
  if (client.repos !== "*") throw new HarnessError(403, "le poste est réservé au propriétaire");
  if (!workstation.enabled) throw new HarnessError(404, "le poste de travail est désactivé (workstation.enabled)");
  return workstation;
}

/**
 * Approuver, refuser ou régler le poste : l'appareil approbateur seulement. Le jeton du
 * code ordinaire vit dans `~/.omp/harness.json` et l'extension : une session omp qui le
 * lit ne doit pas pouvoir trancher ses propres envois.
 */
export function approverFor(workstation: Workstation, client: Client): Workstation {
  const owned = workstationFor(workstation, client);
  if (!client.approver) throw new HarnessError(403, APPROVER_ONLY);
  return owned;
}

const LEASE_LOST = "l'extension n'a pas rendu le résultat";
const APPROVAL_EXPIRED = "approbation non donnée à temps : vaut refus";
const QUEUE_EXPIRED = "l'action n'est pas partie à temps";

type Waiter = () => void;

export class Workstation {
  readonly #ctx: HarnessContext;
  /** La présence de chaque navigateur (`browserId`) vu depuis le démarrage. */
  readonly #presence = new Map<string, Presence>();
  readonly #queueWaiters = new Set<Waiter>();
  readonly #actionWaiters = new Map<number, Set<Waiter>>();
  #purgedAt = 0;
  /** Une synthèse du profil (hors espace) demandée depuis une app (`POST …/profile/rebuild`) : l'agent la lance au prochain tour, puis l'efface. */
  profileRequested = false;
  /** Les espaces dont une app a demandé la synthèse du profil (`POST …/profile/rebuild?space=`) : chacun effacé quand la sienne part. */
  readonly spaceProfilesRequested = new Set<string>();
  #closed = false;
  /** Ceux que l'annulation d'une action en cours (arrêt d'urgence, `cancel`) prévient : l'exécuteur du VPS. */
  readonly #halted = new Set<(seqs: number[] | null) => void>();
  /** Le dernier envoi du mirroir de Chrome accepté par le navigateur `vps` (mémoire du process). */
  #mirroredAt: number | null = null;

  /** Les navigateurs, la présence et les espaces : la présence, les écouteurs d'arrêt et le mirroir restent ici. */
  readonly #browserDesk: PresenceDesk;
  /** Le profil de travail : ce que l'agent a observé, et la synthèse qu'il en tire. */
  readonly #profileDesk: ProfileDesk;
  /** Les meetings, les demandes et les automatisations. */
  readonly #errandDesk: ErrandDesk;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
    this.#browserDesk = new PresenceDesk(ctx, this, {
      presence: this.#presence,
      halted: this.#halted,
      mirroredAt: () => this.#mirroredAt,
      setMirroredAt: (at) => {
        this.#mirroredAt = at;
      },
      transition: (seq, expected, patch) => this.#transition(seq, expected, patch),
      wakeQueue: () => this.#wakeQueue(),
    });
    this.#profileDesk = new ProfileDesk(ctx, this);
    this.#errandDesk = new ErrandDesk(ctx, this, {
      known: (browserId) => this.#browserDesk.known(browserId),
      spaceRef: (value) => this.#browserDesk.spaceRef(value),
      transition: (seq, expected, patch) => this.#transition(seq, expected, patch),
    });
  }

  get enabled(): boolean {
    return this.#ctx.config.workstation.enabled;
  }

  // -- réglages, présence, statut ---------------------------------------------------

  settings(): WorkstationSettings {
    return this.#browserDesk.settings();
  }

  /** Les réglages posés depuis une app (seuls les champs donnés changent ; `thresholdHours: null` revient à la configuration). */
  updateSettings(body: Record<string, unknown>, actor: Actor): WorkstationStatus {
    return this.#browserDesk.updateSettings(body, actor);
  }

  /**
   * Le temps observé cumulé et la première observation : de tout le poste (sans portée — c'est lui qui
   * fait passer l'autonomie `auto` à `act`), des navigateurs d'un espace, ou (`null`) de ceux hors
   * espace — le total moins ce que les espaces ont compté (ceux retirés depuis compris).
   */
  observed(space?: string | null): { ms: number; since: number | null } {
    return this.#browserDesk.observed(space);
  }

  effective(settings: WorkstationSettings = this.settings()): EffectiveAutonomy {
    return this.#browserDesk.effective(settings);
  }

  // -- navigateurs ------------------------------------------------------------------

  /**
   * Le navigateur par défaut : celui des réglages s'il est connu, sinon le premier vu ;
   * `null` tant qu'aucune extension ne s'est présentée.
   */
  defaultBrowserId(): string | null {
    return this.#browserDesk.defaultBrowserId();
  }

  /** L'espace (son id) d'un navigateur AUJOURD'HUI : ce qu'il écrit désormais le garde ; `null` hors espace, ou sans navigateur. */
  spaceOfBrowser(browserId: string | null): string | null {
    return this.#browserDesk.spaceOfBrowser(browserId);
  }

  /** Le navigateur d'un espace où agir : un des siens en ligne, sinon le premier vu ; `null` s'il n'en a aucun. */
  browserOfSpace(space: string, now = Date.now()): string | null {
    return this.#browserDesk.browserOfSpace(space, now);
  }

  /**
   * Le navigateur qui agit DANS un espace : celui qu'on désigne s'il lui appartient, sinon l'un des
   * siens ; 409 si le navigateur désigné est ailleurs ou si l'espace n'en a aucun — jamais le
   * navigateur par défaut, jamais celui d'un autre espace.
   */
  browserIn(space: string, browserId: string | null): string {
    return this.#browserDesk.browserIn(space, browserId);
  }

  /**
   * Sans espace désigné (ni `?space=`), on n'agit que dans un navigateur HORS de tout espace : celui
   * qu'on nomme, sinon le navigateur par défaut. 409 s'il appartient à un espace — sans dire pour quel
   * client on agit, on n'agit dans le navigateur d'aucun.
   */
  outsideSpaces(browserId: string | null): void {
    this.#browserDesk.outsideSpaces(browserId);
  }

  /**
   * Rattache un navigateur à un espace (`space` : son id), ou le détache (`null`). Rien de ce qu'il a
   * déjà écrit ne le suit : ses observations, meetings et actions gardent l'espace où ils ont été
   * écrits — l'ancien espace les lit toujours, le nouveau jamais. Une demande posée pour lui dans son
   * ancien espace échoue au lieu de partir ailleurs (`WorkstationAgent`), et TOUTES ses actions pas
   * encore parties — en file ou en attente d'approbation ; d'une demande, du service, d'un plan, d'une
   * session — sont closes ici : rien de ce qu'un client a demandé ne s'exécute dans le navigateur
   * devenu celui d'un autre. Le navigateur `vps` ne loue plus rien tant que sa session n'est pas
   * purgée (`vpsPurgeDue`). 404 si le navigateur ou l'espace est inconnu.
   */
  assignBrowser(browserId: string, space: unknown, actor: Actor): BrowserView {
    return this.#browserDesk.assignBrowser(browserId, space, actor);
  }

  /**
   * La source du mirroir de session vers le navigateur `vps`, si la copie est permise : le navigateur
   * réglé (`mirrorBrowser`) ET le navigateur `vps` sont dans le même espace (ou tous deux hors espace).
   * Sinon `null` : la copie est suspendue, la session d'un client ne passe pas chez un autre.
   */
  mirrorSource(): string | null {
    return this.#browserDesk.mirrorSource();
  }

  /**
   * La session du navigateur `vps` vient d'une AUTRE portée que celle d'aujourd'hui : son espace, ou
   * celui de la source du mirroir, a changé depuis qu'elle a été remplie (navigateur réattribué, espace
   * retiré). Tant que c'est vrai — et la marque est en base, elle survit à un redémarrage — il ne loue
   * aucune action et n'accepte aucun cookie : l'exécuteur la purge d'abord (`VpsBrowser`), puis le dit
   * par `vpsPurged`. Sans espace, jamais.
   */
  vpsPurgeDue(): boolean {
    return this.#browserDesk.vpsPurgeDue();
  }

  /** La session du navigateur `vps` vient d'être purgée : elle repart vide dans la portée d'aujourd'hui, ses comptes déconnectés. */
  vpsPurged(): void {
    this.#browserDesk.vpsPurged();
  }

  /**
   * Les identités de l'utilisateur dans une portée : celles de l'espace (`spaces.identities`, même
   * vides : rien n'y est alors « à soi ») ; hors espace (`null`), la liste du poste. La garde d'envoi
   * d'un navigateur lit celles de SON espace.
   */
  identitiesIn(space: string | null): string[] {
    return this.#browserDesk.identitiesIn(space);
  }

  /** Un contact d'une extension (long-poll, observation, résultat, transcript) : rend son navigateur. */
  touch(hello: BrowserHello = NO_HELLO): string {
    return this.#browserDesk.touch(hello);
  }

  /** Le navigateur `browserId` est en ligne ; sans navigateur désigné : l'un d'eux au moins. */
  online(now = Date.now(), browserId: string | null = null): boolean {
    return this.#browserDesk.online(now, browserId);
  }

  /** Le navigateur n'est plus joignable : hors ligne tout de suite (sans attendre `ONLINE_MS`). Il reste connu. */
  forget(browserId: string): void {
    this.#browserDesk.forget(browserId);
  }

  onHalt(listener: (seqs: number[] | null) => void): void {
    this.#browserDesk.onHalt(listener);
  }

  /** L'état de chaque compte du navigateur `vps` : non connecté tant que rien ne dit le contraire. */
  vpsAccounts(): AccountView[] {
    return this.#browserDesk.vpsAccounts();
  }

  /** Pose l'état d'un compte ; un changement émet `workstation_account` (la notification ne part que pour `expired`). */
  setVpsAccount(domain: AccountDomain, state: AccountState): boolean {
    return this.#browserDesk.setVpsAccount(domain, state);
  }

  /** Un envoi du mirroir de Chrome vient d'être posé dans le navigateur `vps` (ni cookie ni compte retenu). */
  markMirrored(at = Date.now()): void {
    this.#browserDesk.markMirrored(at);
  }

  /** Les navigateurs connus, du premier vu au dernier. */
  browsers(now = Date.now()): BrowserView[] {
    return this.#browserDesk.browsers(now);
  }

  /** Le prochain service de l'agent 24/24 : après le repos qui suit le dernier, si l'autonomie le permet. */
  nextShiftAt(
    settings: WorkstationSettings,
    effective: EffectiveAutonomy,
    last: ShiftRow | null,
    now: number,
  ): number | null {
    return this.#browserDesk.nextShiftAt(settings, effective, last, now);
  }

  /**
   * Le statut du poste ; avec `space` (`?space=`), ce qui se compte par navigateur — navigateurs,
   * présence, temps observé, identités, approbations en attente, profil — est celui de l'espace ;
   * l'autonomie, la pause, les services et la navigation gardée restent ceux du poste.
   */
  status(now = Date.now(), space?: string): WorkstationStatus {
    return this.#browserDesk.status(now, space);
  }

  // -- observation ------------------------------------------------------------------

  /** Un lot d'observations d'un navigateur ; refusé (409) en pause. Rend le nombre écrit. */
  recordObservations(body: Record<string, unknown>, hello: BrowserHello = NO_HELLO): number {
    return this.#profileDesk.recordObservations(body, hello);
  }

  /** Les observations récentes ; `space` : celles écrites dans cet espace seulement. */
  listObservations(filter: {
    since?: number;
    limit?: number;
    space?: string;
  }): (Observation & { id: number; browserId: string | null })[] {
    return this.#profileDesk.listObservations(filter);
  }

  /** Les statistiques du profil d'une portée : un espace (ses navigateurs), ou `null` — les navigateurs hors espace. */
  stats(space: string | null = null): ProfileStats {
    return this.#profileDesk.stats(space);
  }

  // -- la file des actions --------------------------------------------------------------

  #event(action: WorkstationAction): void {
    this.#ctx.event(
      "workstation_action",
      null,
      {
        seq: action.seq,
        state: action.state,
        kind: action.kind,
        origin: action.origin,
        ...(action.requestId === null ? {} : { requestId: action.requestId }),
      },
      null,
    );
    if (action.state === "awaiting_approval") {
      this.#ctx.event(
        "workstation_approval",
        null,
        {
          seq: action.seq,
          summary: action.approval?.summary ?? action.rationale,
          recipients: action.approval?.recipients ?? [],
        },
        null,
      );
    }
  }

  /** Une transition d'action par compare-and-swap (état, et révision si `updatedAt`), son événement dans la même transaction. */
  #transition(
    seq: number,
    expected: readonly ActionState[],
    patch: ActionPatch,
    updatedAt?: number,
  ): WorkstationAction | null {
    const { store } = this.#ctx;
    const updated = store.transaction(() => {
      const next = store.updateWorkstationActionIf(seq, expected, patch, updatedAt);
      if (next) this.#event(next);
      return next;
    });
    if (updated) {
      if (updated.state === "queued") this.#wakeQueue();
      this.#changed(seq);
    }
    return updated;
  }

  /**
   * Dépose une action pour un navigateur (`input.browserId`, sinon celui de la demande, sinon
   * le défaut). `decision` est écrite `done` (journal seul, jamais louée). Les autres exigent
   * ce navigateur en ligne et le poste hors pause ; déposées par l'agent en autonomie
   * `propose`, elles attendent l'approbation humaine, comme toute action que retient une
   * garde (`#guards`) : un onglet de l'utilisateur, une navigation hors liste ou suspecte.
   * Déposée par le job d'une demande (`requestId`), l'action est rattachée à la demande,
   * qui doit être en cours ; l'autonomie ne s'y applique pas (l'humain l'a demandée), les
   * gardes si.
   */
  createAction(
    input: ActionInput,
    origin: ActionOrigin,
    by: string | null,
    requestId: string | null = null,
  ): WorkstationAction {
    const { store } = this.#ctx;
    const settings = this.settings();
    const request = requestId === null ? null : store.getWorkstationRequest(requestId);
    const browserId =
      input.browserId !== undefined
        ? this.#browserDesk.known(input.browserId)
        : (request?.browserId ?? this.defaultBrowserId());
    // L'action d'une demande ne part que dans un navigateur de l'espace de la demande (hors espace : un navigateur hors espace).
    const space = this.spaceOfBrowser(browserId);
    if (request && (request.space ?? null) !== space) throw new HarnessError(409, REQUEST_OUT_OF_SPACE);
    let state: ActionState = "done";
    let approval: Approval | null = null;
    if (input.kind !== "decision") {
      if (!this.online(Date.now(), browserId)) throw new HarnessError(409, "l'extension du poste est hors ligne");
      if (settings.paused) throw new HarnessError(409, "le poste est en pause");
      const effective = this.effective(settings);
      if (requestId === null && origin === "agent" && effective === "observe")
        throw new HarnessError(409, "l'autonomie du poste est en observation : l'agent n'agit pas");
      // Le fichier d'un `upload` existe dans le dossier d'envoi, sous la borne : sinon rien n'est déposé.
      if (input.kind === "upload") this.#uploadPath(String(input.params.file), space);
      const reasons = this.#guards(input, origin, browserId);
      const proposes = requestId === null && origin === "agent" && effective === "propose";
      state = proposes || reasons.length > 0 ? "awaiting_approval" : "queued";
      if (state === "awaiting_approval") {
        const gesture = describeGesture(input.kind, input.params);
        approval = {
          summary: clean(
            reasons.length > 0 ? `${gesture} — approbation requise : ${reasons.join(" ; ")}` : gesture,
            MAX_SUMMARY,
          ),
          recipients: [],
          preview:
            input.kind === "type" && typeof input.params.text === "string"
              ? clip(redact(input.params.text), MAX_PREVIEW)
              : "",
          fingerprint: null,
          decidedBy: null,
          decidedAt: null,
          reason: null,
        };
      }
    }
    const action = store.transaction(() => {
      if (requestId !== null && store.getWorkstationRequest(requestId)?.state !== "running")
        throw new HarnessError(409, "la demande n'est plus en cours");
      const created = store.createWorkstationAction({
        origin,
        by,
        kind: input.kind,
        params: input.params,
        rationale: input.rationale,
        state,
        approval,
        requestId,
        browserId,
      });
      this.#event(created);
      return created;
    });
    if (action.state === "queued") this.#wakeQueue();
    return action;
  }

  /**
   * Le `needs_approval` de l'extension pour une action en cours : la garde d'envoi. Seul un message
   * à SOI (destinataires connus, tous à l'utilisateur) repart sans geste humain ; tout autre envoi
   * attend l'humain.
   */
  #retain(
    seq: number,
    held: Pick<Approval, "summary" | "recipients" | "preview" | "fingerprint">,
    space: string | null,
  ): WorkstationAction | null {
    const self = isSelfOnly(held.recipients, this.identitiesIn(space));
    const approval: Approval = {
      ...held,
      decidedBy: self ? "soi" : null,
      decidedAt: self ? Date.now() : null,
      reason: null,
    };
    return this.#transition(seq, ["running"], {
      state: self ? "queued" : "awaiting_approval",
      approved: self,
      approval,
      leasedAt: null,
    });
  }

  /**
   * Pourquoi une action doit attendre l'humain, tranché ICI et non par le prompt (vide : elle
   * part). Le cantonnement : un geste dans un onglet que l'extension n'a pas rapporté comme
   * de la fenêtre de l'agent (son effet, `TAB_KINDS`, est dit à l'humain). L'adresse chargée
   * (`open`, `navigate`, `download` par `url`) : un hôte hors de `allowedHosts` (s'il y en a) ;
   * pour l'agent 24/24, un hôte jamais observé ni listé, ou une query longue ou opaque.
   */
  #guards(input: ActionInput, origin: ActionOrigin, browserId: string | null): string[] {
    const reasons: string[] = [];
    const effect = TAB_KINDS[input.kind];
    const agentTabs = browserId === null ? null : (this.#presence.get(browserId)?.agentTabs ?? null);
    if (effect !== undefined && !agentTabs?.has(input.params.tabId as number))
      reasons.push(`onglet de l'utilisateur, hors de la fenêtre de l'agent (${effect})`);
    if (!URL_KINDS[input.kind] || typeof input.params.url !== "string") return reasons;
    const url = input.params.url;
    const host = hostOf(url) ?? "";
    const { allowedHosts, exfiltrationGuard } = this.settings();
    const listed = hostListed(host, allowedHosts);
    if (allowedHosts.length > 0 && !listed) reasons.push(`${host} hors de la liste des hôtes permis`);
    if (origin !== "agent" || !exfiltrationGuard) return reasons;
    // « Déjà vu » se juge dans l'espace du navigateur : ce qu'un client a visité n'ouvre rien chez un autre.
    if (!listed && !this.#ctx.store.workstationHostSeen(host, this.spaceOfBrowser(browserId)))
      reasons.push(`${host} jamais vu dans l'observation`);
    const param = opaqueQueryParam(url);
    if (param !== null) reasons.push(`l'adresse porte une valeur longue ou opaque (${param})`);
    return reasons;
  }

  /**
   * Le chemin d'un fichier du dossier d'envoi (`uploadDir`) de l'espace `space` (celui du navigateur
   * de l'action ; `null` : hors espace) : un fichier ordinaire (ni lien symbolique, ni dossier), de
   * `MAX_UPLOAD_BYTES` au plus ; 400 sinon. Le nom a déjà été validé (`isUploadName`) : il ne sort
   * jamais du dossier.
   */
  #uploadPath(name: string, space: string | null): string {
    const file = path.join(uploadDir(this.#ctx.config, space), name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw new HarnessError(400, `params.file : « ${name} » absent du dossier d'envoi du poste (envois/)`);
    }
    if (!stat.isFile()) throw new HarnessError(400, `params.file : « ${name} » n'est pas un fichier ordinaire`);
    if (stat.size > MAX_UPLOAD_BYTES)
      throw new HarnessError(400, `params.file : « ${name} » dépasse ${MAX_UPLOAD_BYTES} octets`);
    return file;
  }

  /**
   * Le fichier d'une action `upload` EN COURS, pour l'extension qui l'exécute : nom, type,
   * taille et contenu en base64. 409 pour une autre action ou un autre état, 400 si le
   * fichier a disparu ou grossi depuis le dépôt.
   */
  uploadFile(seq: number): { name: string; mime: string; size: number; data: string } {
    const action = this.getAction(seq);
    if (action.kind !== "upload") throw new HarnessError(409, `l'action #${seq} n'est pas un upload`);
    if (action.state !== "running")
      throw new HarnessError(409, `l'action #${seq} n'est pas en cours (état ${action.state})`);
    const name = String(action.params.file);
    const bytes = fs.readFileSync(this.#uploadPath(name, action.space ?? null));
    if (bytes.length > MAX_UPLOAD_BYTES)
      throw new HarnessError(400, `params.file : « ${name} » dépasse ${MAX_UPLOAD_BYTES} octets`);
    const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
    const mime = MIME_TYPES[extension] ?? "application/octet-stream";
    return { name, mime, size: bytes.length, data: bytes.toString("base64") };
  }

  /**
   * Les onglets de la fenêtre de l'agent rapportés par l'extension du navigateur `browserId`
   * (`X-OMP-Agent-Tabs`, `agentTabs` d'un résultat) ; absent (`undefined`) : la connaissance
   * précédente reste. Les numéros d'onglets n'ont de sens que dans leur navigateur.
   */
  #reportAgentTabs(browserId: string, raw: unknown): void {
    const presence = this.#presence.get(browserId);
    if (raw !== undefined && presence) presence.agentTabs = parseAgentTabs(raw);
  }

  /** Une action ; avec `space` (`?space=`), celle d'un autre espace — ou d'aucun — est inconnue (404). */
  getAction(seq: number, space?: string): WorkstationAction {
    const action = this.#ctx.store.getWorkstationAction(seq);
    if (!action || (space !== undefined && action.space !== space))
      throw new HarnessError(404, `action inconnue : ${seq}`);
    return action;
  }

  /** Le journal ; `space` : les actions déposées dans cet espace seulement. */
  listActions(filter: {
    states?: readonly ActionState[];
    limit?: number;
    before?: number;
    space?: string;
  }): WorkstationAction[] {
    return this.#ctx.store.listWorkstationActions(filter);
  }

  /**
   * La plus ancienne action en file POUR CE NAVIGATEUR passe `running` (bail posé) : les
   * siennes, et celles sans navigateur s'il est le navigateur par défaut. Aucune ne part en pause.
   */
  #lease(browserId: string): WorkstationAction | null {
    if (this.settings().paused) return null;
    // La session du `vps` vient d'une autre portée : rien ne part avant sa purge.
    if (browserId === VPS_BROWSER && this.vpsPurgeDue()) return null;
    const isDefault = browserId === this.defaultBrowserId();
    const space = this.spaceOfBrowser(browserId);
    for (;;) {
      const oldest = this.#ctx.store.oldestQueuedWorkstationAction(browserId, isDefault);
      if (!oldest) return null;
      // Déposée dans un autre espace que celui du navigateur aujourd'hui : close, jamais louée.
      const stray = this.#browserDesk.strayError(oldest, space);
      if (stray !== null) {
        this.#transition(oldest.seq, ["queued"], { state: "failed", approved: false, error: stray });
        continue;
      }
      const leased = this.#transition(oldest.seq, ["queued"], { state: "running", leasedAt: Date.now() });
      if (leased) return leased;
    }
  }

  /**
   * Le long-poll d'une extension : la prochaine action de son navigateur (passée `running`),
   * ou `null` après `waitSec` secondes sans rien en file. Un dépôt réveille l'attente tout de
   * suite ; la déconnexion du client (`signal`) y met fin sans louer d'action. Deux profils
   * Chrome ne se disputent jamais une action : chacun ne loue que celles qui le ciblent.
   */
  async next(
    waitSec: number,
    signal: AbortSignal,
    hello: BrowserHello = NO_HELLO,
    agentTabs?: string,
  ): Promise<WorkstationAction | null> {
    const browserId = this.touch(hello);
    this.#reportAgentTabs(browserId, agentTabs);
    const presence = this.#presence.get(browserId) as Presence;
    presence.polls++;
    try {
      const deadline = Date.now() + Math.max(0, Math.min(waitSec, MAX_WAIT_SEC)) * 1000;
      for (;;) {
        if (signal.aborted || this.#closed) return null;
        // La session du `vps` est à purger : son exécuteur reprend la main tout de suite.
        if (browserId === VPS_BROWSER && this.vpsPurgeDue()) return null;
        const leased = this.#lease(browserId);
        if (leased) return leased;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await this.#park(this.#queueWaiters, remaining, signal);
      }
    } finally {
      presence.polls--;
      presence.lastSeenAt = Date.now();
    }
  }

  /** Une action, et l'image de son résultat si elle est encore en mémoire ; `waitSec` : attend un état ≠ queued/running. */
  async waitAction(
    seq: number,
    waitSec: number,
    signal: AbortSignal,
    space?: string,
  ): Promise<{ action: WorkstationAction; image?: string }> {
    let action = this.getAction(seq, space);
    const deadline = Date.now() + Math.max(0, Math.min(waitSec, MAX_WAIT_SEC)) * 1000;
    while ((action.state === "queued" || action.state === "running") && !signal.aborted && !this.#closed) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let waiters = this.#actionWaiters.get(seq);
      if (!waiters) {
        waiters = new Set();
        this.#actionWaiters.set(seq, waiters);
      }
      await this.#park(waiters, remaining, signal);
      if (waiters.size === 0) this.#actionWaiters.delete(seq);
      action = this.getAction(seq);
    }
    const capture = this.#ctx.store.getWorkstationCapture(seq);
    return capture === null ? { action } : { action, image: capture.image };
  }

  /**
   * Le résultat de l'extension pour une action en cours (et les onglets de sa fenêtre qu'elle
   * rapporte). Un envoi à approuver d'une demande déjà annulée ou échouée est clos (`failed`)
   * au lieu d'attendre l'humain : personne n'attend plus son issue.
   */
  submitResult(seq: number, body: Record<string, unknown>, hello: BrowserHello = NO_HELLO): WorkstationAction {
    const input = parseResult(body);
    const browserId = this.touch(hello);
    this.#reportAgentTabs(browserId, body.agentTabs);
    const action = this.getAction(seq);
    if (action.state !== "running")
      throw new HarnessError(409, `l'action #${seq} n'est pas en cours (état ${action.state})`);
    let updated: WorkstationAction | null;
    if (input.outcome === "done") {
      const { store } = this.#ctx;
      updated = store.transaction(() => {
        const done = this.#transition(seq, ["running"], {
          state: "done",
          result: input.result,
          error: null,
          leasedAt: null,
        });
        // La capture est gardée avec l'action, pour sa rétention (`captureRetentionHours`).
        if (done && input.image !== null) store.putWorkstationCapture(seq, input.image);
        return done;
      });
    } else if (input.outcome === "failed") {
      updated = this.#transition(seq, ["running"], { state: "failed", error: input.error, leasedAt: null });
    } else {
      // Personne n'attend plus l'issue (demande close), ou le navigateur a quitté l'espace de l'action
      // pendant qu'elle tournait : close, jamais approuvable.
      const closed = this.#errandDesk.closedRequestError(action) ?? this.#browserDesk.strayError(action);
      updated =
        closed === null
          ? this.#retain(seq, input.approval, action.space ?? null)
          : this.#transition(seq, ["running"], {
              state: "failed",
              error: closed,
              approved: false,
              approval: { ...input.approval, decidedBy: null, decidedAt: null, reason: null },
              leasedAt: null,
            });
    }
    if (!updated) throw new HarnessError(409, `l'action #${seq} a changé d'état`);
    return updated;
  }

  /**
   * La révision (`updatedAt`) que le client a affichée doit être celle de l'action : l'humain
   * n'approuve que ce qu'il a vu. `required` : l'en-tête If-Match est obligatoire (approve).
   */
  #awaiting(seq: number, actor: Actor, required: boolean): WorkstationAction {
    const action = this.getAction(seq);
    if (action.state !== "awaiting_approval")
      throw new HarnessError(409, `l'action #${seq} n'attend pas d'approbation (état ${action.state})`);
    if (actor.rev === undefined) {
      if (required) throw new HarnessError(428, "If-Match requis : l'updatedAt de l'envoi affiché");
    } else if (actor.rev !== action.updatedAt) {
      throw new HarnessError(412, "l'envoi a changé depuis son affichage : relisez-le");
    }
    return action;
  }

  /** Le CAS d'un geste humain : même état ET même révision ; sinon 412 (changé) ou 409 (plus en attente). */
  #decide(action: WorkstationAction, patch: ActionPatch): WorkstationAction {
    const updated = this.#transition(action.seq, ["awaiting_approval"], patch, action.updatedAt);
    if (updated) return updated;
    const now = this.getAction(action.seq);
    if (now.state === "awaiting_approval")
      throw new HarnessError(412, "l'envoi a changé depuis son affichage : relisez-le");
    throw new HarnessError(409, `l'action #${action.seq} a changé d'état`);
  }

  /** Le geste humain : l'action en attente repart en file, approuvée — exactement la révision affichée. */
  approve(seq: number, actor: Actor): WorkstationAction {
    const action = this.#awaiting(seq, actor, true);
    const approval: Approval = {
      ...(action.approval ?? { summary: action.rationale, recipients: [], preview: "", fingerprint: null }),
      decidedBy: actor.by ?? "humain",
      decidedAt: Date.now(),
      reason: null,
    };
    return this.#decide(action, { state: "queued", approved: true, approval });
  }

  refuse(seq: number, reason: string, actor: Actor): WorkstationAction {
    const action = this.#awaiting(seq, actor, false);
    const approval: Approval = {
      ...(action.approval ?? { summary: action.rationale, recipients: [], preview: "", fingerprint: null }),
      decidedBy: actor.by ?? "humain",
      decidedAt: Date.now(),
      reason: reason.trim() === "" ? null : clean(reason, MAX_SUMMARY),
    };
    return this.#decide(action, { state: "refused", approved: false, approval, error: "refusée par l'humain" });
  }

  /** Les actions qui n'ont pas encore abouti : en file, louées (en cours), en attente de l'humain. */
  static readonly PENDING: readonly ActionState[] = ["queued", "running", "awaiting_approval"];

  /** Annule une action qui n'a pas abouti : `refused`, la raison dans `error` ; 409 sinon. */
  cancel(seq: number, actor: Actor): WorkstationAction {
    const action = this.getAction(seq);
    const cancelled = this.#cancel(action, `annulée par ${actor.by ?? "un client"}`);
    if (!cancelled) throw new HarnessError(409, `l'action #${seq} a déjà abouti (état ${this.getAction(seq).state})`);
    for (const listener of [...this.#halted]) listener([seq]);
    return cancelled;
  }

  #cancel(action: WorkstationAction, error: string): WorkstationAction | null {
    return this.#transition(action.seq, Workstation.PENDING, {
      state: "refused",
      approved: false,
      error,
      leasedAt: null,
    });
  }

  /**
   * L'arrêt d'urgence, permis à tout client : le poste passe en pause (l'extension ne loue
   * plus rien, l'observation est refusée), toute action qui n'a pas abouti est annulée, et
   * l'arrêt reste affiché jusqu'à la reprise par l'approbateur (`PUT …/settings`
   * `paused: false`). La session de service en cours est coupée par l'appelant (l'agent).
   */
  stop(actor: Actor): { status: WorkstationStatus; cancelled: number[] } {
    const by = actor.by ?? "un client";
    const { store } = this.#ctx;
    const cancelled = store.transaction(() => {
      const stored = store.getSetting<Record<string, unknown>>(SETTINGS_KEY) ?? {};
      store.setSetting(SETTINGS_KEY, { ...stored, paused: true, stopped: { at: Date.now(), by } }, actor.by);
      this.#ctx.event("workstation_stop", null, { by }, null);
      const seqs: number[] = [];
      for (const action of store.listWorkstationActions({ states: Workstation.PENDING, limit: 10_000 }))
        if (this.#cancel(action, `annulée par l'arrêt d'urgence (${by})`)) seqs.push(action.seq);
      return seqs.sort((a, b) => a - b);
    });
    this.#ctx.log(`poste : arrêt d'urgence par ${by}, ${cancelled.length} action(s) annulée(s)`);
    for (const listener of [...this.#halted]) listener(cancelled);
    return { status: this.status(), cancelled };
  }

  /** La capture gardée d'une action (de l'espace `space`, s'il est donné) ; 404 si elle n'en a pas (ou plus : rétention). */
  capture(seq: number, space?: string): WorkstationCapture {
    this.getAction(seq, space);
    const capture = this.#ctx.store.getWorkstationCapture(seq);
    if (!capture) throw new HarnessError(404, `aucune capture gardée pour l'action #${seq}`);
    return capture;
  }

  /**
   * Le direct de la session d'un job du poste, sous la forme de `GET /v1/runs/{id}/session`
   * (`job` au lieu de `runId`) : une page d'entrées (avant `before`), et seulement celles
   * d'après `since` (une `seq`) s'il est donné ; `more` s'il en reste de plus anciennes non lues.
   */
  sessionView(
    job: SessionJob,
    live: boolean,
    page: { before?: number | null; limit?: number; since?: number | null } = {},
  ): Record<string, unknown> {
    const { entries, more } = this.#ctx.sessions.page(
      workstationOwner(SESSION_JOBS[job]),
      page.before ?? null,
      page.limit,
    );
    const since = page.since ?? null;
    const fresh: SessionEntry[] = since === null ? entries : entries.filter((entry) => entry.seq > since);
    const oldest = entries[0]?.seq ?? null;
    return {
      runId: null,
      auditId: null,
      job,
      live,
      cursor: this.#ctx.store.lastEventId(),
      entries: fresh,
      more: more && (since === null || (oldest !== null && oldest - 1 > since)),
    };
  }

  /**
   * Les échéances, à chaque tour : un bail sans résultat après `actionTimeoutSec` → `failed` ;
   * une approbation non donnée après `approvalTtlHours` → `expired` (JAMAIS approuvée) ; une
   * action restée en file aussi longtemps → `expired` (elle ne part pas des jours plus tard) ;
   * un meeting `live` muet depuis `ORPHAN_MEETING_MS` → `ended` (son digest part). Puis, au
   * plus une fois par heure, la rétention des observations, des transcripts, des résultats
   * d'actions (vidés, la ligne du journal reste) et des contenus lus des canaux corpo.
   */
  maintain(now = Date.now()): void {
    const config = this.#ctx.config.workstation;
    const { store } = this.#ctx;
    for (const action of store.leasedWorkstationActionsBefore(now - config.actionTimeoutSec * 1000))
      this.#transition(action.seq, ["running"], { state: "failed", error: LEASE_LOST, leasedAt: null });
    const stale = now - config.approvalTtlHours * 3_600_000;
    for (const action of store.staleWorkstationActions(["awaiting_approval"], stale))
      this.#transition(action.seq, ["awaiting_approval"], {
        state: "expired",
        approved: false,
        error: APPROVAL_EXPIRED,
      });
    for (const action of store.staleWorkstationActions(["queued"], stale))
      this.#transition(action.seq, ["queued"], { state: "expired", approved: false, error: QUEUE_EXPIRED });
    // Un navigateur sorti de l'espace de ses actions sans passer par `assignBrowser` (espace retiré) : closes aussi.
    this.#browserDesk.closeStrayActions();
    for (const meeting of store.orphanWorkstationMeetings(now - ORPHAN_MEETING_MS))
      store.transaction(() => {
        const ended = store.updateWorkstationMeetingIf(meeting.id, ["live"], { state: "ended", endedAt: now });
        if (ended) this.#errandDesk.meetingEvent(ended);
      });
    if (now - this.#purgedAt >= PURGE_EVERY_MS) {
      this.#purgedAt = now;
      const before = now - config.retentionDays * DAY_MS;
      const pruned = store.transaction(
        () => store.pruneWorkstationObservations(before) + store.pruneWorkstationSegments(before),
      );
      if (pruned > 0)
        this.#ctx.log(`poste : ${pruned} observation(s) ou segment(s) de plus de ${config.retentionDays} j purgé(s)`);
      const cleared = store.clearWorkstationResultsBefore(before);
      if (cleared > 0)
        this.#ctx.log(`poste : ${cleared} résultat(s) d'action de plus de ${config.retentionDays} j vidé(s)`);
    }
    // Les captures, à chaque tour : leur rétention se compte en heures.
    store.pruneWorkstationCaptures(now - config.captureRetentionHours * 3_600_000);
  }

  // -- attentes ---------------------------------------------------------------------

  /** Attend un réveil de `waiters`, l'échéance, l'abandon du client ou l'arrêt. */
  #park(waiters: Set<Waiter>, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted || this.#closed) {
        resolve();
        return;
      }
      const done: Waiter = () => {
        clearTimeout(timer);
        waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  #wakeQueue(): void {
    for (const waiter of [...this.#queueWaiters]) waiter();
  }

  #changed(seq: number): void {
    for (const waiter of [...(this.#actionWaiters.get(seq) ?? [])]) waiter();
  }

  /** L'arrêt du service : chaque attente rend tout de suite (204 pour un long-poll). */
  close(): void {
    this.#closed = true;
    this.#wakeQueue();
    for (const waiters of this.#actionWaiters.values()) for (const waiter of [...waiters]) waiter();
  }

  // -- meetings -------------------------------------------------------------------

  getMeeting(id: string): Meeting {
    return this.#errandDesk.getMeeting(id);
  }

  createMeeting(body: Record<string, unknown>, hello: BrowserHello = NO_HELLO): Meeting {
    return this.#errandDesk.createMeeting(body, hello);
  }

  /** Un lot de segments transcrits d'un meeting en cours ; refusé en pause. */
  addSegments(id: string, body: Record<string, unknown>, hello: BrowserHello = NO_HELLO): number {
    return this.#errandDesk.addSegments(id, body, hello);
  }

  /** La fin d'un meeting : son digest part au prochain tour de l'agent. */
  endMeeting(id: string, hello: BrowserHello = NO_HELLO): Meeting {
    return this.#errandDesk.endMeeting(id, hello);
  }

  /** Les meetings ; `space` : ceux ouverts dans cet espace seulement. */
  listMeetings(limit: number, space?: string): Meeting[] {
    return this.#errandDesk.listMeetings(limit, space);
  }

  /** Un meeting et son transcript ; avec `space` (`?space=`), celui d'un autre espace — ou d'aucun — est inconnu (404). */
  meetingView(id: string, space?: string): { meeting: Meeting; transcript: Segment[] } {
    return this.#errandDesk.meetingView(id, space);
  }

  /** L'issue du digest d'un meeting terminé : `digested` avec résumé et besoins, ou `failed`. */
  finishDigest(id: string, outcome: { summary: string; needs: MeetingNeed[] } | { reason: string }): Meeting | null {
    return this.#errandDesk.finishDigest(id, outcome);
  }

  // -- demandes et automatisations ---------------------------------------------------------

  /** Une demande ; avec `space` (`?space=`), celle d'un autre espace — ou d'aucun — est inconnue (404). */
  getRequest(id: string, space?: string): WorkstationRequest {
    return this.#errandDesk.getRequest(id, space);
  }

  /**
   * Une demande de l'humain : une consigne que le job `poste-demande` exécutera dans le
   * navigateur (`browserId`, sinon le navigateur par défaut), quelle que soit l'autonomie.
   * Refusée en pause ; extension hors ligne : elle attend en file. Aucun run, aucun worktree.
   * Dans un espace (`space` : son id) elle s'exécute dans UN navigateur de cet espace — celui
   * qu'on désigne s'il lui appartient, sinon l'un des siens (en ligne de préférence) — et jamais
   * ailleurs : 404 espace inconnu, 409 s'il n'a pas de navigateur ou si le navigateur désigné
   * est d'un autre espace.
   */
  createRequest(body: Record<string, unknown>, actor: Actor): WorkstationRequest {
    return this.#errandDesk.createRequest(body, actor);
  }

  /** Les demandes ; `space` : celles de cet espace seulement. */
  listRequests(filter: { states?: readonly RequestState[]; limit?: number; space?: string }): WorkstationRequest[] {
    return this.#errandDesk.listRequests(filter);
  }

  /** Une demande et toutes ses actions (celles qu'a déposées son job, et elles seules), les plus anciennes d'abord. */
  requestView(id: string, space?: string): { request: WorkstationRequest; actions: WorkstationAction[] } {
    return this.#errandDesk.requestView(id, space);
  }

  /**
   * L'annulation par l'humain d'une demande en file ou en cours : ses actions pas encore
   * parties passent `failed`, son job est arrêté au tour suivant (`WorkstationAgent`).
   */
  cancelRequest(id: string, actor: Actor): WorkstationRequest {
    return this.#errandDesk.cancelRequest(id, actor);
  }

  /** Le départ d'une demande en file ; `null` si elle n'y est plus (annulée entre-temps). */
  startRequest(id: string): WorkstationRequest | null {
    return this.#errandDesk.startRequest(id);
  }

  /**
   * Une demande en file qui ne partira pas (son navigateur a quitté son espace) : `failed`, la raison
   * dite, ses actions closes. `null` si elle n'était plus en file.
   */
  rejectRequest(id: string, reason: string): WorkstationRequest | null {
    return this.#errandDesk.rejectRequest(id, reason);
  }

  /**
   * Pourquoi une demande en file attend. Écrite (et signalée) seulement si sa SORTE (le texte
   * avant le premier « : ») change : une dépense qui monte ou des slots qui bougent ne
   * réécrivent rien.
   */
  waitRequest(id: string, reason: string): void {
    this.#errandDesk.waitRequest(id, reason);
  }

  /**
   * L'issue d'une demande en cours : `done` avec le compte rendu, ou `failed` avec la raison
   * (ses actions pas encore parties passent `failed`). `null` si elle n'était plus en cours.
   */
  finishRequest(id: string, outcome: { report: string } | { reason: string }): WorkstationRequest | null {
    return this.#errandDesk.finishRequest(id, outcome);
  }

  getAutomation(id: string): WorkstationAutomation {
    return this.#errandDesk.getAutomation(id);
  }

  /** Les automatisations ; `space` : celles créées dans cet espace seulement. */
  listAutomations(space?: string): WorkstationAutomation[] {
    return this.#errandDesk.listAutomations(space);
  }

  /**
   * Une automatisation tirée de la tâche `task` (son rang) de la version `version` du profil,
   * si elle est automatisable : titre, fréquence et étapes copiés. Idempotente (même titre et
   * mêmes étapes dans le même espace : l'existante, `created: false`), permise en pause.
   * `browserId` : le navigateur de ses demandes ; `schedule` : son expression cron, lue par le
   * planificateur. Elle PORTE l'espace où elle est créée (`space` ; hors espace sinon) : la tâche vient
   * du profil de cet espace et le navigateur est l'un des siens (409 sinon, ou s'il n'en a aucun) —
   * hors espace, un navigateur hors espace (409 sinon). Elle garde ce navigateur et cet espace.
   */
  createAutomation(
    body: Record<string, unknown>,
    actor: Actor,
  ): { automation: WorkstationAutomation; created: boolean } {
    return this.#errandDesk.createAutomation(body, actor);
  }

  /**
   * Lance une automatisation : une demande « en file » dont la consigne reprend son titre et
   * ses étapes, rattachée à elle. C'est le point d'entrée du lancement par l'humain
   * (`POST …/automations/{id}/launch`) ET du planificateur (cible `automation`) : 404 si
   * l'automatisation n'existe plus, 409 en pause ou si son navigateur n'est plus dans l'espace où
   * elle a été créée ; l'appelant relance le tour de l'agent.
   */
  runAutomation(automationId: string, actor: Actor): WorkstationRequest {
    return this.#errandDesk.runAutomation(automationId, actor);
  }

  /** Supprime une automatisation ; les demandes déjà lancées gardent leur consigne. */
  deleteAutomation(id: string): string {
    return this.#errandDesk.deleteAutomation(id);
  }

  // -- profil et services --------------------------------------------------------------

  /**
   * Le profil d'une portée : celui de l'espace `space` (établi sur ses seuls navigateurs, avec leurs
   * statistiques), ou — `null` — le profil hors espace, qui ne lit que les navigateurs sans espace.
   */
  profileView(space: string | null = null): {
    profile: WorkstationProfile | null;
    stats: ProfileStats;
    browsers: BrowserView[];
  } {
    return this.#profileDesk.profileView(space);
  }

  /** Le dernier profil d'une portée (un espace, ou `null` : hors espace) : celui que reçoit un job qui y agit. */
  profileOf(space: string | null): WorkstationProfile | null {
    return this.#profileDesk.profileOf(space);
  }

  /** Une nouvelle version du profil de la portée `space` (`null` : le profil hors espace). */
  writeProfile(profile: WorkstationProfileBody, space: string | null = null): WorkstationProfile {
    return this.#profileDesk.writeProfile(profile, space);
  }

  recordShift(input: { startedAt: number; outcome: string; actions: number }): ShiftRow {
    return this.#profileDesk.recordShift(input);
  }
}
