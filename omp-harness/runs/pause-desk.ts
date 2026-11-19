// La pause globale (« Tout suspendre ») et celle d'un espace : l'état gardé dans les réglages, ce qui retient
// l'admission, les échéances et les jobs, et l'arrêt immédiat des runs vivants (`now`).
import type { Actor, HarnessContext } from "./context.ts";
import type { RepoFilter, ScheduleTarget, Space } from "../db/db.ts";
import { HarnessError } from "../api/errors.ts";
import { PAUSE_REASON, heldForPause } from "./machine.ts";
import type { Slot } from "../runners/scheduler.ts";
import type { LiveRun } from "./steps.ts";
import { NO_SPACE_HOLDS } from "../spaces/spaces.ts";
import type { SpaceHold, SpaceHolds } from "../spaces/spaces.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { spaceBudgetText } from "./run-queue.ts";

/**
 * La pause globale (« Tout suspendre ») : qui l'a posée ou levée, quand, et pourquoi. `now` : elle a
 * interrompu sur-le-champ ce qui tournait, au lieu de laisser finir les étapes en cours. Gardée dans
 * les réglages (`settings`, clé `pause`) : elle survit à un redémarrage.
 */
export type PauseState = {
  paused: boolean;
  by: string | null;
  at: number | null;
  reason: string | null;
  now: boolean;
};

/** Un espace en pause, tel que `GET /v1/pause` le rend : son identifiant, son nom et sa pause. */
export type SpacePause = PauseState & { id: string; name: string };

/** La pause telle que l'API la rend : la pause globale, et les espaces EN PAUSE que voit le lecteur. */
export type PauseView = PauseState & { spaces: SpacePause[] };

const PAUSE_KEY = "pause";
/** La clé de réglage de la pause d'un espace : `pause:<espaceId>`. */
function spacePauseKey(spaceId: string): string {
  return `${PAUSE_KEY}:${spaceId}`;
}
/** Qui a suspendu, quand la pause vient du service lui-même (aucun client). */
const PAUSE_SERVICE = "le service";

type PauseHost = Pick<Orchestrator, "store" | "spaces" | "audits" | "intake" | "pilot" | "workstation">;

type PauseHooks = {
  /** Les runs conduits en ce moment : lus ici, jamais écrits. */
  live: ReadonlyMap<string, LiveRun & { slot: Slot }>;
  /** Attend qu'un run vivant soit arrêté. */
  halt: (runId: string) => Promise<void>;
  /** Un tour de scheduling, pour qu'une reprise reparte sans attendre l'horloge. */
  kick: () => void;
};

export class PauseDesk {
  readonly #ctx: HarnessContext;
  readonly #host: PauseHost;
  readonly #hooks: PauseHooks;
  /** La pause globale, relue des réglages au démarrage : rien n'est admis ni lancé tant qu'elle tient. */
  #pause: PauseState;
  /**
   * Les espaces en pause (leur identifiant), relus des réglages au démarrage : leurs runs ne sont plus
   * admis, leurs runs vivants retournent en file, le serveur ne décide plus rien seul pour eux — les
   * autres espaces continuent. Vide sans espace en pause : aucune lecture de plus.
   */
  readonly #spacePauses = new Map<string, PauseState>();
  /** Les runs vivants qu'une pause immédiate (`now`) interrompt : ils retournent en file, sans échec compté. */
  readonly #pauseStops = new Set<string>();
  /** L'arrêt immédiat en cours (runs, audits, Demandes, pilote) : rien ne repart avant qu'il ait fini. */
  #suspending: Promise<void> | null = null;

  constructor(ctx: HarnessContext, host: PauseHost, hooks: PauseHooks) {
    this.#ctx = ctx;
    this.#host = host;
    this.#hooks = hooks;
    this.#pause = pauseOf(ctx.store.getSetting<unknown>(PAUSE_KEY));
  }

  /** La pause globale telle que `GET /v1/pause` la rend. */
  get pause(): PauseState {
    return this.#pause;
  }

  /** L'arrêt immédiat en cours, ou `null` : `stop` l'attend avant de fermer le reste. */
  get suspending(): Promise<void> | null {
    return this.#suspending;
  }

  /** Les espaces en pause, relus des réglages : une fois, à la construction du service. */
  loadSpaces(): void {
    for (const space of this.#ctx.store.listSpaces()) {
      const pause = pauseOf(this.#ctx.store.getSetting<unknown>(spacePauseKey(space.id)));
      if (pause.paused) this.#spacePauses.set(space.id, pause);
    }
  }

  /** Cet espace est-il en pause ? Ce que lit `SpaceDesk` pour dire l'état d'un espace. */
  spacePaused(spaceId: string): boolean {
    return this.#spacePauses.has(spaceId);
  }

  /** Un espace retiré oublie sa pause et son réglage. */
  forgetSpace(spaceId: string): void {
    this.#spacePauses.delete(spaceId);
    this.#ctx.store.deleteSetting(spacePauseKey(spaceId));
  }

  /** L'arrêt immédiat d'une pause : l'étape abandonnée n'est ni un échec ni une tentative. */
  parkIfStopped(runId: string): void {
    if (this.#pauseStops.delete(runId)) this.#parkForPause(runId);
  }

  /**
   * Ce qui retient tout pendant la pause globale (« en pause : suspendu par … »), ou `null` hors pause.
   * Une pause levée pendant que son arrêt immédiat s'achève retient encore, le temps qu'il finisse.
   */
  hold(): string | null {
    const { paused, by, reason } = this.#pause;
    if (!paused) return this.#suspending === null ? null : "reprise : l'arrêt immédiat de la pause s'achève";
    return `${PAUSE_REASON} ${by ?? PAUSE_SERVICE}${reason === null ? "" : ` — ${reason}`}`;
  }

  /** La pause de l'espace d'un dépôt, si cet espace est en pause ; sans aucun espace en pause, aucune lecture. */
  #spacePause(repo: string): { space: Space; pause: PauseState } | null {
    if (this.#spacePauses.size === 0) return null;
    const space = this.#host.spaces.spaceOf(repo);
    const pause = space === null ? undefined : this.#spacePauses.get(space.id);
    return space !== null && pause !== undefined ? { space, pause } : null;
  }

  /** L'espace de ce dépôt est-il en pause ? Ce que lisent les merges, les échéances et l'autonomie d'un tour. */
  readonly spaceHeld = (repo: string): boolean => this.#spacePause(repo) !== null;

  /** La phrase de la pause d'un espace : ce qui retient ses runs en file, ses Demandes, ses jobs. */
  #spacePauseText(space: Space, pause: PauseState): string {
    return `${PAUSE_REASON} ${pause.by ?? PAUSE_SERVICE} (espace « ${space.name} »)${pause.reason === null ? "" : ` — ${pause.reason}`}`;
  }

  /** Ce qui retient en file les runs d'un dépôt dont l'espace est en pause, ou `null`. */
  spaceHold(repo: string): string | null {
    const held = this.#spacePause(repo);
    return held === null ? null : this.#spacePauseText(held.space, held.pause);
  }

  /**
   * Ce qui retient, pour ce tour, TOUT ce qui appartient à un espace — planifications, audits, Demandes,
   * rêves, jobs du poste — comme l'admission retient ses runs : sa pause d'abord, sinon son budget du
   * jour atteint (compté une fois par espace et par tour). Par le dépôt (`ofRepo`) ou par l'espace
   * (`ofSpace` : une Demande, un navigateur du poste, une connexion Atlassian). Hors de tout espace :
   * jamais rien ; sur un serveur sans espace : aucune lecture de plus.
   */
  spaceHolds(now: number): SpaceHolds {
    const spaces = this.#host.store.listSpaces();
    if (spaces.length === 0) return NO_SPACE_HOLDS;
    const known = new Map<string, SpaceHold | null>();
    const of = (space: Space | undefined): SpaceHold | null => {
      if (space === undefined) return null;
      let hold = known.get(space.id);
      if (hold === undefined) {
        const pause = this.#spacePauses.get(space.id);
        const budget = pause === undefined ? this.#host.spaces.budgetHoldOf(space, now) : null;
        hold =
          pause !== undefined
            ? { cause: "paused", text: this.#spacePauseText(space, pause) }
            : budget !== null
              ? { cause: "space_budget", text: spaceBudgetText(budget) }
              : null;
        known.set(space.id, hold);
      }
      return hold;
    };
    return {
      ofRepo: (repo) => of(spaces.find((space) => space.repos.includes(repo))),
      ofSpace: (id) => (id === null ? null : of(spaces.find((space) => space.id === id))),
    };
  }

  /** L'espace où une planification agit : celui du dépôt de sa cible ; pour une automatisation du poste, celui de son navigateur. */
  scheduleHold(target: ScheduleTarget, holds: SpaceHolds): SpaceHold | null {
    if (target.kind !== "automation") return holds.ofRepo(target.repo);
    const automation = this.#host.store.getWorkstationAutomation(target.automationId);
    if (automation === null) return null;
    const browser = automation.browserId ?? this.#host.workstation.defaultBrowserId();
    return holds.ofSpace(this.#host.workstation.spaceOfBrowser(browser));
  }

  /** Qui a suspendu ce qui tourne sur ce dépôt : l'auteur de la pause globale, sinon de celle de son espace ; `null` hors pause. */
  pauser(repo: string): string | null {
    if (this.#pause.paused) return this.#pause.by ?? PAUSE_SERVICE;
    const held = this.#spacePause(repo);
    return held === null ? null : `${held.pause.by ?? PAUSE_SERVICE} (espace « ${held.space.name} »)`;
  }

  /** `GET /v1/pause` : la pause globale, et les espaces en pause dont le lecteur voit un dépôt. */
  pauseView(repos: RepoFilter): PauseView {
    const spaces: SpacePause[] = [];
    if (this.#spacePauses.size > 0)
      for (const space of this.#host.store.listSpaces()) {
        const pause = this.#spacePauses.get(space.id);
        if (pause !== undefined && (repos === null || space.repos.some((repo) => repos.includes(repo))))
          spaces.push({ id: space.id, name: space.name, ...pause });
      }
    return { ...this.#pause, spaces };
  }

  /**
   * « Tout suspendre », ou reprendre. En pause, plus aucun run n'est admis, chaque run vivant retourne
   * en file avant sa prochaine étape (rien n'est annulé), et ni audit, ni rêve, ni planification, ni
   * Demande, ni job du poste ne démarre ; `paused: false` relance le tour. `now` : ce qui tourne est
   * interrompu sur-le-champ (`#suspendNow`) au lieu de finir son étape — une pause déjà posée sans lui
   * peut le recevoir ensuite. Le réglage est écrit (`settings`, clé `pause`) : il survit à un redémarrage.
   * Réservé au propriétaire : un client borné à des dépôts ou un pilote est refusé (403). Redire l'état
   * courant ne change rien.
   *
   * `spaceRef` (identifiant ou nom) : la pause d'UN espace, par le même chemin (réglage `pause:<espaceId>`,
   * événement `pause` avec `space`). Ses runs ne sont plus admis, ses runs vivants retournent en file
   * (tout de suite avec `now`), ses merges non engagés, son autonomie et ses échéances attendent ; les
   * autres espaces continuent. Espace inconnu : 404, après le refus du non-propriétaire.
   */
  setPause(
    paused: boolean,
    reason: string,
    actor: Actor,
    repos: RepoFilter,
    now: boolean,
    spaceRef: string | null,
  ): PauseState {
    if (repos !== null)
      throw new HarnessError(
        403,
        spaceRef === null
          ? "la pause de tout le serveur est réservée au propriétaire"
          : "la pause d'un espace est réservée au propriétaire",
      );
    if (actor.pilot)
      throw new HarnessError(403, "geste réservé à l'humain — un pilote ne suspend ni ne relance l'usine");
    const space = spaceRef === null ? null : this.#host.spaces.resolve(spaceRef, null);
    const current = space === null ? this.#pause : (this.#spacePauses.get(space.id) ?? pauseOf(null));
    const hardened = paused && current.paused && now && !current.now;
    if (paused === current.paused && !hardened) return current;
    // Une pause durcie (`now` après coup) garde son instant, et sa raison si aucune autre n'est donnée.
    const next: PauseState = {
      paused,
      by: actor.by,
      at: hardened ? current.at : Date.now(),
      reason: !paused ? null : reason !== "" ? reason : hardened ? current.reason : null,
      now: paused && now,
    };
    const { store } = this.#ctx;
    store.transaction(() => {
      store.setSetting(space === null ? PAUSE_KEY : spacePauseKey(space.id), next, actor.by);
      this.#ctx.event(
        "pause",
        null,
        { paused, by: actor.by, reason: next.reason, now: next.now, ...(space === null ? {} : { space: space.id }) },
        null,
      );
    });
    if (space === null) this.#pause = next;
    else if (paused) this.#spacePauses.set(space.id, next);
    else this.#spacePauses.delete(space.id);
    const scope = space === null ? "pause globale" : `pause de l'espace « ${space.name} »`;
    this.#ctx.log(
      paused
        ? `${scope} ${next.now ? "immédiate " : ""}posée${actor.by ? ` par ${actor.by}` : ""}${next.reason === null ? "" : ` : ${next.reason}`}`
        : `${scope} levée${actor.by ? ` par ${actor.by}` : ""}`,
    );
    const failed = (err: unknown): void =>
      this.#ctx.log(`pause immédiate : ${err instanceof Error ? err.message : String(err)}`, { level: "error", err });
    if (next.now && space !== null) {
      // L'arrêt immédiat d'un espace ne touche que ses runs : rien d'autre n'attend qu'il ait fini.
      void this.#suspendNow(space.repos)
        .catch(failed)
        .finally(() => this.#hooks.kick());
    } else if (next.now) {
      const suspending = (this.#suspending ?? Promise.resolve())
        .then(() => this.#suspendNow())
        .catch(failed)
        .finally(() => {
          if (this.#suspending === suspending) this.#suspending = null;
          this.#hooks.kick();
        });
      this.#suspending = suspending;
    }
    this.#hooks.kick();
    return next;
  }

  /**
   * L'arrêt immédiat d'une pause (`now`). Chaque run vivant est interrompu comme par une annulation
   * (étape abandonnée, runner arrêté) mais retourne en file à la même étape (`#parkForPause`). Les
   * audits et les Demandes en cours sont arrêtés et repartent de zéro à la reprise, par le chemin d'un
   * redémarrage (ils n'ont encore rien écrit) ; le pilote rend la main sans rien inscrire. Les rêves et
   * les jobs du poste finissent : rien ne sait les reprendre (le poste a son propre arrêt d'urgence).
   * `repos` : l'arrêt immédiat d'un ESPACE — seuls les runs vivants de ses dépôts sont interrompus.
   */
  async #suspendNow(repos: readonly string[] | null = null): Promise<void> {
    const runs = [...this.#hooks.live.keys()].filter(
      (id) => repos === null || repos.includes(this.#host.store.getRun(id)?.repo ?? ""),
    );
    for (const id of runs) this.#pauseStops.add(id);
    await Promise.allSettled(runs.map((id) => this.#hooks.halt(id)));
    if (repos !== null) return;
    await this.#host.audits.stop();
    await this.#host.audits.recover();
    await this.#host.intake.stop();
    await this.#host.intake.recover();
    await this.#host.pilot.stop();
  }

  /**
   * Un run qu'une pause immédiate vient d'interrompre : s'il est encore `running`, il retourne en file
   * à la même étape, tentatives et dernière cause d'échec intactes, sans délai de relance. Son worktree
   * et ses checkpoints restent ; l'étape relancée à la reprise apprend d'où repartir.
   */
  #parkForPause(runId: string): void {
    const { store } = this.#ctx;
    const run = store.getRun(runId);
    if (run?.state !== "running" || run.step === null) return;
    const cursor = { step: run.step, fixes: run.fixes, attempts: run.attempts };
    const held = this.#pause.paused ? null : this.#spacePause(run.repo);
    const whose = held === null ? "du serveur" : `de l'espace « ${held.space.name} »`;
    const who = this.pauser(run.repo) ?? this.#pause.by ?? PAUSE_SERVICE;
    store.transaction(() => {
      if (this.#ctx.transition(run, heldForPause(cursor, who), ["running"]))
        store.addInstructions(
          runId,
          `Étape /${cursor.step} interrompue par la pause ${whose} à ${new Date().toISOString()} ; le worktree garde le travail en cours : repars de \`git diff ${run.baseSha ?? "main"}\` — ne refais pas ce qui est fait.`,
        );
    });
  }
}

/** La pause lue dans les réglages : absente ou illisible, le serveur n'est pas en pause. */
function pauseOf(stored: unknown): PauseState {
  const off: PauseState = { paused: false, by: null, at: null, reason: null, now: false };
  if (typeof stored !== "object" || stored === null) return off;
  const { paused, by, at, reason, now } = stored as Record<string, unknown>;
  if (typeof paused !== "boolean") return off;
  return {
    paused,
    by: typeof by === "string" ? by : null,
    at: typeof at === "number" ? at : null,
    reason: typeof reason === "string" ? reason : null,
    now: paused && now === true,
  };
}
