// L'ASSEMBLAGE des routes de parité (S-3) : construit le contexte partagé et
// concatène les tables de chaque module. `service.ts` et le test de parité
// (`test/req/api-distante-parite.test.ts`) passent par ici — une seule voie.
import type { RemoteMachine, RemoteRoute } from "./remoteApi.ts";
import { defaultExec } from "./remoteContext.ts";
import type { ExecFn, RemoteContext } from "./remoteContext.ts";
import type { DeviceRegistry } from "./remoteDevices.ts";
import { auditRoutes } from "./remoteAudits.ts";
import { cardRoutes } from "./remoteActions.ts";
import { handoverRoutes } from "./remoteHandover.ts";
import { hostedRoutes, conduiteFeed, hostedFeed } from "./remoteHosted.ts";
import { GestureJournal } from "./remoteJournal.ts";
import { mem0ProxyRoutes } from "./remoteMem0Proxy.ts";
import { memoryRoutes } from "./remoteMemory.ts";
import { PullRequestStates, pullRequestRoutes } from "./remotePullRequests.ts";
import { readRoutes } from "./remoteReads.ts";
import { StoreSource, storeRoutes } from "./remoteStore.ts";
import { StreamHub, streamRoutes } from "./remoteStream.ts";
import type { ServiceApi } from "./serviceApi.ts";

export type RemoteRoutesOptions = {
  api: ServiceApi;
  stateDir: string;
  machine: RemoteMachine;
  devices: DeviceRegistry;
  env?: Record<string, string | undefined>;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  exec?: ExecFn;
};

export type RemoteRoutes = {
  routes: RemoteRoute[];
  ctx: RemoteContext;
  /** Ferme les veilles, les flux et les minuteries. */
  close: () => void;
};

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createRemoteRoutes(options: RemoteRoutesOptions): RemoteRoutes {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const exec = options.exec ?? defaultExec(env);
  const store = new StoreSource({ stateDir: options.stateDir, now, pidAlive });
  const journal = new GestureJournal({ now });
  const base = { stateDir: options.stateDir, env, now, pidAlive, exec, store, journal };
  const pullRequests = new PullRequestStates(base);
  const streams = new StreamHub({
    machine: options.machine,
    devices: options.devices,
    store,
    journal,
    now,
    env,
    pullRequestStates: pullRequests,
    conduite: conduiteFeed(options.api),
    hosted: hostedFeed(options.api),
  });
  const ctx: RemoteContext = { api: options.api, machine: options.machine, devices: options.devices, streams, ...base };
  pullRequests.attach(ctx);
  const routes = [
    ...storeRoutes(ctx),
    ...streamRoutes(ctx),
    ...readRoutes(ctx),
    ...cardRoutes(ctx),
    ...memoryRoutes(ctx),
    ...hostedRoutes(ctx),
    ...auditRoutes(ctx),
    ...mem0ProxyRoutes(ctx),
    ...pullRequestRoutes(ctx),
    ...handoverRoutes(ctx),
  ];
  return {
    routes,
    ctx,
    close: () => {
      streams.closeAll();
      store.close();
      pullRequests.close();
    },
  };
}
