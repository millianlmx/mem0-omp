// Les navigateurs, la présence et les espaces du poste : réglages et statut, navigateur par défaut, espace d'un
// navigateur, comptes et mirroir du navigateur `vps`. L'état partagé avec la file d'actions arrive par des rappels.
import { isRecord } from "../config/config.ts";
import type { Actor, HarnessContext } from "../runs/context.ts";
import type { ActionPatch, ActionState, ShiftRow, WorkstationAction } from "../db/db.ts";
import { HarnessError } from "../api/errors.ts";
import { ACCOUNT_DOMAINS, ACCOUNT_STATES, VPS_BROWSER } from "../browser/vps-policy.ts";
import type { AccountDomain, AccountState, AccountView } from "../browser/vps-policy.ts";
import {
  AUTONOMIES,
  SETTINGS_KEY,
  OBSERVED_KEY,
  REQUEST_OUT_OF_SPACE,
  bad,
  parseSettings,
} from "./workstation-input.ts";
import type {
  Autonomy,
  EffectiveAutonomy,
  WorkstationSettings,
  BrowserHello,
  BrowserView,
  WorkstationStatus,
  Presence,
} from "./workstation-input.ts";
import type { Workstation } from "./workstation.ts";

/** Le navigateur d'une extension sans `browserId` (version ancienne) quand aucun autre n'est connu. */
export const LEGACY_BROWSER = "default";

/** Le dernier contact de l'extension date de moins de 60 s : elle est en ligne. */
export const ONLINE_MS = 60_000;

/** L'état des comptes du navigateur `vps` (table `settings`) : domaine → { state, at }. */
const ACCOUNTS_KEY = "workstation.vps.accounts";

/** La portée (espace du navigateur `vps`, espace de la source du mirroir) sous laquelle la session du `vps` a été remplie. */
const VPS_JAR_KEY = "workstation.vps.jar";

/** Une demande, une action ou une automatisation visent un espace qui n'a aucun navigateur rattaché. */
export const NO_SPACE_BROWSER =
  "cet espace n'a pas de navigateur : rattachez-en un (PUT /v1/workstation/browsers/{id} {space})";

/** Une action déposée dans un espace que son navigateur a quitté depuis (réattribué, espace retiré). */
export const ACTION_OUT_OF_SPACE =
  "le navigateur de l'action n'est plus dans l'espace où elle a été déposée : elle ne s'exécute pas ailleurs";

/**
 * L'autonomie appliquée : `auto` reste en `observe` tant que l'observation n'a pas atteint
 * `thresholdHours`, puis passe `act` ; les autres réglages s'appliquent tels quels.
 */
export function effectiveAutonomy(
  setting: Autonomy,
  observedSeconds: number,
  thresholdHours: number,
): EffectiveAutonomy {
  if (setting !== "auto") return setting;
  return observedSeconds >= thresholdHours * 3600 ? "act" : "observe";
}

type PresenceHooks = {
  /** La présence de chaque navigateur : la même `Map` que celle de la file d'actions. */
  presence: Map<string, Presence>;
  /** Ceux que l'annulation d'une action en cours prévient : le même ensemble que celui de la file d'actions. */
  halted: Set<(seqs: number[] | null) => void>;
  /** Le dernier envoi du mirroir accepté par le navigateur `vps`, gardé par la file d'actions. */
  mirroredAt: () => number | null;
  /** Pose le dernier envoi du mirroir accepté (`null` : purgé). */
  setMirroredAt: (at: number | null) => void;
  /** La transition d'une action par compare-and-swap ; `null` si elle n'est plus dans l'un des états attendus. */
  transition: (seq: number, expected: readonly ActionState[], patch: ActionPatch) => WorkstationAction | null;
  /** Réveille le long-poll de l'extension. */
  wakeQueue: () => void;
};

/** Les navigateurs, la présence et les espaces du poste ; la file d'actions lui prête l'état qu'elle partage. */
export class PresenceDesk {
  readonly #ctx: HarnessContext;
  readonly #host: Workstation;
  readonly #hooks: PresenceHooks;

  constructor(ctx: HarnessContext, host: Workstation, hooks: PresenceHooks) {
    this.#ctx = ctx;
    this.#host = host;
    this.#hooks = hooks;
  }

  settings(): WorkstationSettings {
    const stored = this.#ctx.store.getSetting<Record<string, unknown>>(SETTINGS_KEY) ?? {};
    return {
      autonomy: (AUTONOMIES as readonly unknown[]).includes(stored.autonomy) ? (stored.autonomy as Autonomy) : "auto",
      selfIdentities: Array.isArray(stored.selfIdentities)
        ? stored.selfIdentities.filter((entry): entry is string => typeof entry === "string")
        : [],
      paused: stored.paused === true,
      thresholdHours:
        typeof stored.thresholdHours === "number" && stored.thresholdHours > 0
          ? stored.thresholdHours
          : this.#ctx.config.workstation.thresholdHours,
      stopped:
        isRecord(stored.stopped) && typeof stored.stopped.at === "number" && typeof stored.stopped.by === "string"
          ? { at: stored.stopped.at, by: stored.stopped.by }
          : null,
      defaultBrowser: typeof stored.defaultBrowser === "string" ? stored.defaultBrowser : null,
      mirrorBrowser: typeof stored.mirrorBrowser === "string" ? stored.mirrorBrowser : null,
      allowedHosts: Array.isArray(stored.allowedHosts)
        ? stored.allowedHosts.filter((entry): entry is string => typeof entry === "string")
        : [...this.#ctx.config.workstation.allowedHosts],
      exfiltrationGuard:
        typeof stored.exfiltrationGuard === "boolean"
          ? stored.exfiltrationGuard
          : this.#ctx.config.workstation.exfiltrationGuard,
      navigationSource: {
        allowedHosts: Array.isArray(stored.allowedHosts) ? "setting" : "config",
        exfiltrationGuard: typeof stored.exfiltrationGuard === "boolean" ? "setting" : "config",
      },
    };
  }

  /** Les réglages posés depuis une app (seuls les champs donnés changent ; `thresholdHours: null` revient à la configuration). */
  updateSettings(body: Record<string, unknown>, actor: Actor): WorkstationStatus {
    const patch = parseSettings(body);
    const { store } = this.#ctx;
    if (typeof patch.defaultBrowser === "string") this.known(patch.defaultBrowser);
    if (typeof patch.mirrorBrowser === "string") {
      this.known(patch.mirrorBrowser);
      // Le mirroir copie une session entière : jamais d'un espace vers le navigateur d'un autre.
      if (
        store.getWorkstationBrowser(VPS_BROWSER) &&
        this.#host.spaceOfBrowser(patch.mirrorBrowser) !== this.#host.spaceOfBrowser(VPS_BROWSER)
      )
        throw new HarnessError(
          409,
          "mirrorBrowser : ce navigateur et le navigateur vps ne sont pas dans le même espace — la session d'un client ne se copie pas chez un autre",
        );
    }
    store.transaction(() => {
      const stored = { ...(store.getSetting<Record<string, unknown>>(SETTINGS_KEY) ?? {}), ...patch };
      if (stored.thresholdHours === null) delete stored.thresholdHours;
      if (stored.defaultBrowser === null) delete stored.defaultBrowser;
      if (stored.mirrorBrowser === null) delete stored.mirrorBrowser;
      if (stored.allowedHosts === null) delete stored.allowedHosts;
      if (stored.exfiltrationGuard === null) delete stored.exfiltrationGuard;
      // La reprise par l'approbateur lève l'arrêt d'urgence.
      if (patch.paused === false) delete stored.stopped;
      store.setSetting(SETTINGS_KEY, stored, actor.by);
      this.#ctx.event("workstation_settings", null, actor.by ? { by: actor.by } : {}, null);
    });
    // Une pause levée ou un autre navigateur par défaut : ce qui attendait en file peut partir.
    if (patch.paused === false || patch.defaultBrowser !== undefined) this.#hooks.wakeQueue();
    return this.#host.status();
  }

  /**
   * Le temps observé cumulé et la première observation : de tout le poste (sans portée — c'est lui qui
   * fait passer l'autonomie `auto` à `act`), des navigateurs d'un espace, ou (`null`) de ceux hors
   * espace — le total moins ce que les espaces ont compté (ceux retirés depuis compris).
   */
  observed(space?: string | null): { ms: number; since: number | null } {
    const { store } = this.#ctx;
    const read = (key: string): { ms: number; since: number | null } => {
      const stored = store.getSetting<{ ms?: unknown; since?: unknown }>(key);
      return {
        ms: typeof stored?.ms === "number" ? stored.ms : 0,
        since: typeof stored?.since === "number" ? stored.since : null,
      };
    };
    if (typeof space === "string") return read(`${OBSERVED_KEY}:${space}`);
    const total = read(OBSERVED_KEY);
    if (space === undefined) return total;
    const inSpaces = store.workstationObservedInSpaces(`${OBSERVED_KEY}:`);
    return { ms: Math.max(0, total.ms - inSpaces), since: total.since };
  }

  effective(settings: WorkstationSettings = this.#host.settings()): EffectiveAutonomy {
    return effectiveAutonomy(settings.autonomy, Math.floor(this.#host.observed().ms / 1000), settings.thresholdHours);
  }

  /**
   * Le navigateur par défaut : celui des réglages s'il est connu, sinon le premier vu ;
   * `null` tant qu'aucune extension ne s'est présentée.
   */
  defaultBrowserId(): string | null {
    const { store } = this.#ctx;
    const chosen = this.#host.settings().defaultBrowser;
    if (chosen !== null && store.getWorkstationBrowser(chosen)) return chosen;
    // Le navigateur du serveur n'est le défaut que si l'approbateur l'a choisi : une extension ancienne (sans identifiant) ne doit jamais tomber sur lui.
    return store.listWorkstationBrowsers().find((browser) => browser.id !== VPS_BROWSER)?.id ?? null;
  }

  /** Un navigateur désigné doit être connu (une extension s'est présentée avec cet identifiant). */
  known(browserId: string): string {
    if (!this.#ctx.store.getWorkstationBrowser(browserId))
      throw new HarnessError(404, `navigateur inconnu : ${browserId}`);
    return browserId;
  }

  /** L'espace (son id) d'un navigateur AUJOURD'HUI : ce qu'il écrit désormais le garde ; `null` hors espace, ou sans navigateur. */
  spaceOfBrowser(browserId: string | null): string | null {
    return browserId === null ? null : (this.#ctx.store.getWorkstationBrowser(browserId)?.spaceId ?? null);
  }

  /** Le navigateur d'un espace où agir : un des siens en ligne, sinon le premier vu ; `null` s'il n'en a aucun. */
  browserOfSpace(space: string, now: number): string | null {
    const browsers = this.#ctx.store.workstationBrowsersOf(space);
    return (browsers.find((browser) => this.#host.online(now, browser.id)) ?? browsers[0])?.id ?? null;
  }

  /**
   * Le navigateur qui agit DANS un espace : celui qu'on désigne s'il lui appartient, sinon l'un des
   * siens ; 409 si le navigateur désigné est ailleurs ou si l'espace n'en a aucun — jamais le
   * navigateur par défaut, jamais celui d'un autre espace.
   */
  browserIn(space: string, browserId: string | null): string {
    if (browserId !== null) {
      if (this.#host.spaceOfBrowser(this.known(browserId)) !== space)
        throw new HarnessError(409, `le navigateur ${browserId} n'appartient pas à cet espace`);
      return browserId;
    }
    const own = this.#host.browserOfSpace(space);
    if (own === null) throw new HarnessError(409, NO_SPACE_BROWSER);
    return own;
  }

  /**
   * Sans espace désigné (ni `?space=`), on n'agit que dans un navigateur HORS de tout espace : celui
   * qu'on nomme, sinon le navigateur par défaut. 409 s'il appartient à un espace — sans dire pour quel
   * client on agit, on n'agit dans le navigateur d'aucun.
   */
  outsideSpaces(browserId: string | null): void {
    const space = this.#host.spaceOfBrowser(browserId ?? this.#host.defaultBrowserId());
    if (space === null) return;
    const name = this.#ctx.store.getSpace(space)?.name ?? space;
    throw new HarnessError(
      409,
      `${browserId === null ? "le navigateur par défaut" : `le navigateur ${browserId}`} appartient à l'espace « ${name} » : désignez cet espace (\`?space=\`) pour y agir — sans espace, on n'agit que dans un navigateur hors espace`,
    );
  }

  /** Un espace désigné dans un corps (`space`) : absent ou `null` → hors espace ; sinon un espace connu (404). */
  spaceRef(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.trim() === "") bad("space : identifiant d'espace attendu, ou null");
    if (!this.#ctx.store.getSpace(value)) throw new HarnessError(404, `espace inconnu : ${value}`);
    return value;
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
    this.known(browserId);
    if (space === undefined) bad("space : identifiant d'espace attendu, ou null (hors espace)");
    const target = this.spaceRef(space);
    const { store } = this.#ctx;
    store.transaction(() => {
      const browser = store.setWorkstationBrowserSpace(browserId, target);
      this.#ctx.event(
        "workstation_browser",
        null,
        { id: browserId, label: browser?.label ?? null, space: target },
        null,
      );
    });
    this.#ctx.log(
      `poste : navigateur ${browserId} ${target === null ? "détaché de tout espace" : `rattaché à l'espace ${target}`} par ${actor.by ?? "un client"}`,
    );
    this.closeStrayActions();
    // Le navigateur `vps` en attente d'une action relit sa portée tout de suite : sa purge passe d'abord.
    this.#hooks.wakeQueue();
    return this.#host.browsers().find((browser) => browser.id === browserId) as BrowserView;
  }

  /** Le motif d'une action dont le navigateur n'est plus dans l'espace où elle a été déposée ; `null` s'il y est. */
  strayError(action: WorkstationAction, space = this.#host.spaceOfBrowser(action.browserId)): string | null {
    if ((action.space ?? null) === space) return null;
    return action.requestId === null ? ACTION_OUT_OF_SPACE : REQUEST_OUT_OF_SPACE;
  }

  /**
   * Clôt (`failed`, le motif dit) toute action pas encore partie — en file ou en attente d'approbation —
   * dont le navigateur n'est plus dans l'espace où elle a été déposée : navigateur réattribué, espace
   * retiré. Sans espace, il n'y a rien à clore. Rend leur nombre.
   */
  closeStrayActions(): number {
    const pending: readonly ActionState[] = ["queued", "awaiting_approval"];
    let closed = 0;
    for (const action of this.#ctx.store.listWorkstationActions({ states: pending, limit: 10_000 })) {
      const error = this.strayError(action);
      if (error !== null && this.#hooks.transition(action.seq, pending, { state: "failed", approved: false, error }))
        closed++;
    }
    return closed;
  }

  /**
   * La source du mirroir de session vers le navigateur `vps`, si la copie est permise : le navigateur
   * réglé (`mirrorBrowser`) ET le navigateur `vps` sont dans le même espace (ou tous deux hors espace).
   * Sinon `null` : la copie est suspendue, la session d'un client ne passe pas chez un autre.
   */
  mirrorSource(): string | null {
    const source = this.#host.settings().mirrorBrowser;
    return source !== null && this.#host.spaceOfBrowser(source) === this.#host.spaceOfBrowser(VPS_BROWSER)
      ? source
      : null;
  }

  /** La portée sous laquelle la session du navigateur `vps` (cookies miroités, connexions) a été remplie. */
  #vpsJar(): { vps: string | null; source: string | null } {
    const stored = this.#ctx.store.getSetting<{ vps?: unknown; source?: unknown }>(VPS_JAR_KEY);
    return {
      vps: typeof stored?.vps === "string" ? stored.vps : null,
      source: typeof stored?.source === "string" ? stored.source : null,
    };
  }

  /**
   * La session du navigateur `vps` vient d'une AUTRE portée que celle d'aujourd'hui : son espace, ou
   * celui de la source du mirroir, a changé depuis qu'elle a été remplie (navigateur réattribué, espace
   * retiré). Tant que c'est vrai — et la marque est en base, elle survit à un redémarrage — il ne loue
   * aucune action et n'accepte aucun cookie : l'exécuteur la purge d'abord (`VpsBrowser`), puis le dit
   * par `vpsPurged`. Sans espace, jamais.
   */
  vpsPurgeDue(): boolean {
    const jar = this.#vpsJar();
    const source = this.#host.settings().mirrorBrowser;
    return (
      jar.vps !== this.#host.spaceOfBrowser(VPS_BROWSER) ||
      (source !== null && jar.source !== this.#host.spaceOfBrowser(source))
    );
  }

  /** La session du navigateur `vps` vient d'être purgée : elle repart vide dans la portée d'aujourd'hui, ses comptes déconnectés. */
  vpsPurged(): void {
    const { store } = this.#ctx;
    const source = this.#host.settings().mirrorBrowser;
    store.transaction(() => {
      store.setSetting(
        VPS_JAR_KEY,
        {
          vps: this.#host.spaceOfBrowser(VPS_BROWSER),
          source: source === null ? this.#vpsJar().source : this.#host.spaceOfBrowser(source),
        },
        null,
      );
      for (const domain of ACCOUNT_DOMAINS) this.#host.setVpsAccount(domain, "disconnected");
    });
    this.#hooks.setMirroredAt(null);
    this.#ctx.log("poste : session du navigateur vps purgée — sa portée (son espace ou celui de sa source) a changé");
  }

  /**
   * Les identités de l'utilisateur dans une portée : celles de l'espace (`spaces.identities`, même
   * vides : rien n'y est alors « à soi ») ; hors espace (`null`), la liste du poste. La garde d'envoi
   * d'un navigateur lit celles de SON espace.
   */
  identitiesIn(space: string | null): string[] {
    if (space === null) return this.#host.settings().selfIdentities;
    return this.#ctx.store.getSpace(space)?.identities ?? [];
  }

  /** Le navigateur d'un appel : le sien, sinon (extension ancienne) le navigateur par défaut. */
  #browserOf(hello: BrowserHello): string {
    return hello.id ?? this.#host.defaultBrowserId() ?? LEGACY_BROWSER;
  }

  /** Un contact d'une extension (long-poll, observation, résultat, transcript) : rend son navigateur. */
  touch(hello: BrowserHello): string {
    const id = this.#browserOf(hello);
    const now = Date.now();
    const presence = this.#hooks.presence.get(id);
    if (presence) presence.lastSeenAt = now;
    else this.#hooks.presence.set(id, { lastSeenAt: now, polls: 0, agentTabs: null });
    const { store } = this.#ctx;
    const before = store.getWorkstationBrowser(id);
    store.transaction(() => {
      store.touchWorkstationBrowser({ id, label: hello.label, version: hello.version, at: now });
      if (!before || (hello.label !== null && hello.label !== before.label))
        this.#ctx.event("workstation_browser", null, { id, label: hello.label ?? before?.label ?? null }, null);
    });
    return id;
  }

  #isOnline(presence: Presence | undefined, now: number): boolean {
    return presence !== undefined && (presence.polls > 0 || now - presence.lastSeenAt < ONLINE_MS);
  }

  /** Le navigateur `browserId` est en ligne ; sans navigateur désigné : l'un d'eux au moins. */
  online(now: number, browserId: string | null): boolean {
    if (browserId !== null) return this.#isOnline(this.#hooks.presence.get(browserId), now);
    for (const presence of this.#hooks.presence.values()) if (this.#isOnline(presence, now)) return true;
    return false;
  }

  /** Le navigateur n'est plus joignable : hors ligne tout de suite (sans attendre `ONLINE_MS`). Il reste connu. */
  forget(browserId: string): void {
    this.#hooks.presence.delete(browserId);
  }

  onHalt(listener: (seqs: number[] | null) => void): void {
    this.#hooks.halted.add(listener);
  }

  /** L'état de chaque compte du navigateur `vps` : non connecté tant que rien ne dit le contraire. */
  vpsAccounts(): AccountView[] {
    const stored = this.#ctx.store.getSetting<Record<string, { state?: unknown; at?: unknown }>>(ACCOUNTS_KEY) ?? {};
    return ACCOUNT_DOMAINS.map((domain) => {
      const entry = stored[domain];
      const state = (ACCOUNT_STATES as readonly unknown[]).includes(entry?.state)
        ? (entry?.state as AccountState)
        : "disconnected";
      return { domain, state, changedAt: typeof entry?.at === "number" ? entry.at : null };
    });
  }

  /** Pose l'état d'un compte ; un changement émet `workstation_account` (la notification ne part que pour `expired`). */
  setVpsAccount(domain: AccountDomain, state: AccountState): boolean {
    const { store } = this.#ctx;
    return store.transaction(() => {
      if (this.#host.vpsAccounts().find((account) => account.domain === domain)?.state === state) return false;
      const stored = store.getSetting<Record<string, unknown>>(ACCOUNTS_KEY) ?? {};
      store.setSetting(ACCOUNTS_KEY, { ...stored, [domain]: { state, at: Date.now() } }, null);
      this.#ctx.event("workstation_account", null, { domain, state }, null);
      return true;
    });
  }

  /** Un envoi du mirroir de Chrome vient d'être posé dans le navigateur `vps` (ni cookie ni compte retenu). */
  markMirrored(at: number): void {
    this.#hooks.setMirroredAt(at);
  }

  /** Les navigateurs connus, du premier vu au dernier. */
  browsers(now: number): BrowserView[] {
    const fallback = this.#host.defaultBrowserId();
    return this.#ctx.store.listWorkstationBrowsers().map((row) => ({
      id: row.id,
      label: row.label,
      online: this.#host.online(now, row.id),
      lastSeenAt: row.lastSeenAt,
      firstSeenAt: row.firstSeenAt,
      extensionVersion: row.version,
      isDefault: row.id === fallback,
      space: row.spaceId,
      ...(row.id === VPS_BROWSER ? { accounts: this.#host.vpsAccounts(), mirroredAt: this.#hooks.mirroredAt() } : {}),
    }));
  }

  /** Le prochain service de l'agent 24/24 : après le repos qui suit le dernier, si l'autonomie le permet. */
  nextShiftAt(
    settings: WorkstationSettings,
    effective: EffectiveAutonomy,
    last: ShiftRow | null,
    now: number,
  ): number | null {
    if (!this.#host.enabled || settings.paused || effective === "observe") return null;
    return last ? last.at + this.#ctx.config.workstation.shiftEveryMin * 60_000 : now;
  }

  /**
   * Le statut du poste ; avec `space` (`?space=`), ce qui se compte par navigateur — navigateurs,
   * présence, temps observé, identités, approbations en attente, profil — est celui de l'espace ;
   * l'autonomie, la pause, les services et la navigation gardée restent ceux du poste.
   */
  status(now: number, space?: string): WorkstationStatus {
    const { store } = this.#ctx;
    const settings = this.#host.settings();
    const effective = effectiveAutonomy(
      settings.autonomy,
      Math.floor(this.#host.observed().ms / 1000),
      settings.thresholdHours,
    );
    const observedSeconds = Math.floor(this.#host.observed(space).ms / 1000);
    const last = store.lastWorkstationShift();
    const browsers = this.#host.browsers(now).filter((browser) => space === undefined || browser.space === space);
    const latest = browsers
      .filter((browser) => browser.id !== VPS_BROWSER)
      .reduce<BrowserView | null>(
        (best, browser) => (best === null || browser.lastSeenAt > best.lastSeenAt ? browser : best),
        null,
      );
    const seen = [...this.#hooks.presence]
      .filter(([id]) => space === undefined || browsers.some((browser) => browser.id === id))
      .reduce<number | null>(
        (max, [, presence]) => (max === null || presence.lastSeenAt > max ? presence.lastSeenAt : max),
        null,
      );
    return {
      online: space === undefined ? this.#host.online(now) : browsers.some((browser) => browser.online),
      lastSeenAt: seen,
      extensionVersion: latest?.extensionVersion ?? null,
      observedSeconds,
      thresholdHours: settings.thresholdHours,
      autonomy: { setting: settings.autonomy, effective },
      paused: settings.paused,
      selfIdentities: space === undefined ? settings.selfIdentities : (store.getSpace(space)?.identities ?? []),
      pending: store.countWorkstationActions("awaiting_approval", space),
      profileUpdatedAt: store.latestWorkstationProfile(space ?? null)?.updatedAt ?? null,
      lastShift: last ? { at: last.at, outcome: last.outcome, actions: last.actions } : null,
      nextShiftAt: this.#host.nextShiftAt(settings, effective, last, now),
      stopped: settings.stopped,
      browsers,
      defaultBrowser: browsers.find((browser) => browser.isDefault)?.id ?? null,
      mirrorBrowser: settings.mirrorBrowser,
      allowedHosts: settings.allowedHosts,
      exfiltrationGuard: settings.exfiltrationGuard,
      navigationSource: settings.navigationSource,
    };
  }
}
