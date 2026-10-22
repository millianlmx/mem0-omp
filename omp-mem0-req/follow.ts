// Le suivi d'une session : le flux `GET /v1/events?live=1` tenu ouvert, et chaque
// moment où l'humain est attendu (specs prêtes, verdict, escalades) ou où une feature
// finit (mergée, en échec) posté dans la conversation en message « [harness] … »,
// visible par l'utilisateur ET par le modèle, sans déclencher de tour.
//
// Démarré seul après `harness_launch` / `harness_project` en session interactive
// (filtré sur les runs lancés), ou à la main par `/harness-follow` (tout le dépôt).
// Reconnexion 5 s après une coupure ; arrêt à `session_shutdown`.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { openEvents } from "./events.ts";
import type { HarnessEvent } from "./events.ts";
import { harnessCall } from "./harness.ts";
import type { HarnessTarget } from "./harness.ts";
import { parseRunView } from "./wire.ts";

export const FOLLOW_MESSAGE_TYPE = "harness";
export const RECONNECT_MS = 5_000;

/** Les événements qui méritent une ligne dans la session. */
const FOLLOWED: Record<string, true> = { specs_ready: true, verdict: true, escalations: true, run_state: true };

export type Followed = { id: string; title: string };

export type Follower = {
  /** Suit `runs` sur `target` ; une liste vide suit tout le dépôt. Un suivi déjà ouvert sur la même cible s'élargit. */
  start(target: HarnessTarget, runs: Followed[]): void;
  stop(): void;
  active(): boolean;
  /** Les ids suivis (vide : tout le dépôt). */
  following(): string[];
};

export type FollowerOptions = {
  fetcher?: typeof fetch;
  reconnectMs?: number;
  /** Les erreurs de connexion, pour l'utilisateur ; rien par défaut. */
  onError?: (message: string) => void;
};

/** Le texte posté pour un événement suivi, ou `null` s'il ne mérite rien. */
export function followLine(event: HarnessEvent, title: string): string | null {
  const name = `${title} [${event.runId ?? "?"}]`;
  const reason =
    typeof event.payload.reason === "string" && event.payload.reason !== "" ? ` — ${event.payload.reason}` : "";
  switch (event.type) {
    case "specs_ready":
      return `[harness] specs prêtes à valider : ${name}${reason}. Lis-les avec harness_run ; harness_validate si l'utilisateur tranche.`;
    case "verdict": {
      const verdict = event.payload.verdict;
      const blockers =
        verdict !== null && typeof verdict === "object" && "blockers" in verdict && Array.isArray(verdict.blockers)
          ? verdict.blockers.length
          : 0;
      const risk =
        verdict !== null && typeof verdict === "object" && "risk" in verdict && typeof verdict.risk === "string"
          ? verdict.risk
          : "?";
      return `[harness] verdict de revue à valider : ${name} — risque ${risk}, ${blockers} bloquant(s)${reason}. harness_run pour le lire.`;
    }
    case "escalations": {
      const items = Array.isArray(event.payload.items) ? event.payload.items : [];
      const questions = items
        .map((item) =>
          item !== null && typeof item === "object" && "question" in item && typeof item.question === "string"
            ? `  · ${item.question}`
            : null,
        )
        .filter((line): line is string => line !== null);
      return [
        `[harness] ${items.length} question(s) en attente sur ${name} :`,
        ...questions,
        "harness_run pour les options ; harness_answer si l'utilisateur répond.",
      ].join("\n");
    }
    case "run_state": {
      const state = event.payload.state;
      if (state === "merged") return `[harness] ${name} mergée${reason}.`;
      if (state === "failed")
        return `[harness] ${name} en échec${reason}. harness_retry si l'utilisateur veut relancer.`;
      return null;
    }
    default:
      return null;
  }
}

export function createFollower(pi: Pick<ExtensionAPI, "sendMessage">, options: FollowerOptions = {}): Follower {
  const reconnectMs = options.reconnectMs ?? RECONNECT_MS;
  const titles = new Map<string, string>();
  let target: HarnessTarget | null = null;
  let runs = new Set<string>();
  let controller: AbortController | null = null;
  let timer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;
  let cursor: number | undefined;
  let generation = 0;

  async function titleOf(current: HarnessTarget, runId: string): Promise<string> {
    const known = titles.get(runId);
    if (known !== undefined) return known;
    try {
      const view = parseRunView(
        await harnessCall<unknown>(current, "GET", `/v1/runs/${encodeURIComponent(runId)}`, undefined, {
          fetcher: options.fetcher,
        }),
      );
      const title = view?.run.title || runId;
      titles.set(runId, title);
      return title;
    } catch {
      return runId;
    }
  }

  function wanted(current: HarnessTarget, event: HarnessEvent): boolean {
    if (FOLLOWED[event.type] !== true || event.runId === null) return false;
    return runs.size > 0 ? runs.has(event.runId) : event.repo === current.repo;
  }

  async function loop(current: HarnessTarget, mine: number): Promise<void> {
    while (mine === generation) {
      controller = new AbortController();
      try {
        const opened = await openEvents(
          current,
          { live: true, after: cursor },
          { signal: controller.signal, fetcher: options.fetcher },
        );
        for await (const event of opened.events) {
          if (mine !== generation) return;
          if (event.id !== null) cursor = event.id;
          if (!wanted(current, event)) continue;
          const line = followLine(event, await titleOf(current, event.runId ?? ""));
          if (line !== null)
            pi.sendMessage({ customType: FOLLOW_MESSAGE_TYPE, content: line, display: true }, { triggerTurn: false });
        }
      } catch (err) {
        if (mine !== generation) return;
        options.onError?.(err instanceof Error ? err.message : String(err));
      }
      if (mine !== generation) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, reconnectMs);
        timer.unref?.();
      });
      clearTimeout(timer ?? undefined);
      timer = null;
      wake = null;
    }
  }

  return {
    start(next, launched) {
      for (const run of launched) titles.set(run.id, run.title);
      const same =
        target !== null && target.url === next.url && target.token === next.token && target.repo === next.repo;
      if (same && controller !== null) {
        // Le suivi reste ouvert : un filtre vide (tout le dépôt) absorbe les nouveaux runs,
        // un filtre nommé s'élargit à ceux qu'on vient de lancer.
        if (runs.size > 0) for (const run of launched) runs.add(run.id);
        return;
      }
      this.stop();
      target = next;
      runs = new Set(launched.map((run) => run.id));
      cursor = undefined;
      generation += 1;
      void loop(next, generation);
    },
    stop() {
      generation += 1;
      controller?.abort();
      controller = null;
      clearTimeout(timer ?? undefined);
      timer = null;
      wake?.();
      target = null;
      runs = new Set();
    },
    active: () => target !== null,
    following: () => [...runs],
  };
}
