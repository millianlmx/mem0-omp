// Tests du PANNEAU commandant le service (S-11) : chaque geste part en COMMANDE
// vers l'API, un refus rend son texte tel quel, le pilote est nommé, et sans
// service les gestes sont refusés — plus aucune écriture locale du lot.
import test from "node:test";
import assert from "node:assert/strict";

import { SERVICE_DOWN_REFUSAL, createServiceClient, createServiceLotActions } from "../omp-mem0-req/serviceClient.ts";
import { driverLabel, panelDriver } from "../omp-mem0-req/panelRows.ts";
import type { Lot } from "../omp-mem0-req/lot.ts";
import { writeService } from "../omp-mem0-req/serviceState.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Une requête enregistrée par la doublure : l'URL, le corps et le jeton. */
type RecordedCall = { url: string; body: Record<string, unknown>; token: string | null };

/** Le corps JSON d'une requête, ou un objet vide : jamais une forme devinée. */
function asBody(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw === "") return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** `fetch` de doublure : il enregistre les requêtes et rend l'accusé demandé. */
function fakeFetch(replies: Array<{ state: "taken" | "refused"; reason: string | null }> = []) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const body = asBody(init?.body);
    calls.push({ url, body, token: headers.get("x-omp-service-token") });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? { state: "taken", reason: null };
    if (url.endsWith("/pilot")) {
      return new Response(JSON.stringify({ repoKey: "k", lotId: null, state: "piloting" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        ack: {
          version: 1,
          id: body.id,
          repo: body.repo,
          kind: body.kind,
          state: reply.state,
          reason: reply.reason,
          at: 1,
        },
      }),
      { status: 200 },
    );
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

/** Un magasin jetable avec un `service.json` VIVANT : les clients le lisent. */
function liveStateDir(): { stateDir: string; token: string } {
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "panel-state-"));
  const token = "c".repeat(32);
  writeService(
    { version: 1, pid: process.pid, port: 8899, token, startedAt: 1, stateDir, sessionFile: null },
    stateDir,
  );
  return { stateDir, token };
}

test("service-panel/AC-10 : chaque geste du panneau part en commande, et son refus s'affiche verbatim", async () => {
  const { fetchImpl, calls } = fakeFetch([{ state: "refused", reason: "« alpha » est déjà dans le lot" }]);
  const { stateDir, token } = liveStateDir();
  const client = createServiceClient({ fetchImpl, stateDir });
  const actions = createServiceLotActions({ repoRoot: "/repo", client });

  // `l` : le geste de lancement (le lot passe en marche, ses features partent).
  assert.equal(await actions.launch(), "« alpha » est déjà dans le lot", "un refus rend son motif, tel quel");
  // `a` : l'ajout d'une feature, avec ses deux modèles et ses dépendances.
  await actions.add({ name: "beta", description: "l'intention", deps: ["alpha"], modelReqSpecs: "m1", modelImplReview: null });
  // `x` : le retrait d'une feature qui n'a pas démarré.
  await actions.remove("beta");
  // `v` / `y` : les deux jalons.
  await actions.validate("beta");
  await actions.accept("beta");
  // `R` / `c` : la relance et l'abandon, avec le sort du worktree.
  await actions.relaunch("beta");
  await actions.cancel("beta", "archive");
  // `m` : les deux modèles d'une feature (les deux clés, toujours).
  await actions.editModels("beta", { modelReqSpecs: "m2", modelImplReview: "m3" });
  // Une réponse à un maillon terminé part en `reply`.
  await actions.answer("beta", "voici ma réponse");

  assert.deepEqual(
    calls.map(call => call.body.kind),
    ["start", "add", "remove", "verdict", "verdict", "relaunch", "cancel", "models", "reply"],
  );
  const add = calls[1]!.body;
  assert.equal(add.title, "beta");
  assert.equal(add.description, "l'intention");
  assert.deepEqual(add.deps, ["alpha"]);
  const cancel = calls[6]!.body;
  assert.equal(cancel.slug, "beta");
  assert.equal(cancel.fate, "archive");
  assert.deepEqual([calls[7]!.body.modelReqSpecs, calls[7]!.body.modelImplReview], ["m2", "m3"]);
  // Chaque commande porte l'identité de la route, l'instant et un identifiant : le
  // corps est EXACTEMENT celui du canal de fichiers (S-9).
  for (const call of calls) {
    assert.equal(call.body.version, 1);
    assert.equal(call.body.repo, "/repo");
    assert.equal(typeof call.body.sentAt, "number");
    assert.match(String(call.body.id), /^panel-/);
    assert.equal(call.token, token, "le jeton du service accompagne chaque geste");
    assert.match(call.url, /^http:\/\/127\.0\.0\.1:8899\/v1\/repos\/%2Frepo\//);
  }

  // Le réveil du dépôt passe par `POST /pilot` — plus aucune reprise locale (S-11).
  actions.adopt?.();
  assert.match(calls.at(-1)!.url, /\/v1\/repos\/%2Frepo\/pilot$/);
});

test("service-panel/AC-15 : sans service, les gestes sont refusés et le panneau le dit", async () => {
  const client = createServiceClient({
    stateDir: path.join(fs.realpathSync(os.tmpdir()), `panel-absent-${process.pid}`),
    fetchImpl: fakeFetch().fetchImpl,
  });
  const actions = createServiceLotActions({ repoRoot: "/repo", client });
  assert.equal(await actions.launch(), SERVICE_DOWN_REFUSAL);
  assert.match(SERVICE_DOWN_REFUSAL, /service OMP arrêté — les pipelines n'avancent plus \(\/service status\)/);
  // Le réveil ne jette pas non plus : un panneau qui rafraîchit ne doit jamais
  // mourir sur un service absent.
  assert.equal(actions.adopt?.(), true);
});

test("service-panel/AC-16 : le pilote est NOMMÉ — le service, en adoption, ou absent", () => {
  const lot = {
    version: 1,
    id: "k",
    repoRoot: "/repo",
    status: "running",
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: process.pid, sessionFile: null, sessionId: null, heartbeatAt: 1_700_000_000_000 },
    createdAt: 1,
    launchedAt: 1,
    features: [],
  } as unknown as Lot;

  // Le service pilote : l'en-tête le nomme, et ses gestes restent possibles.
  assert.deepEqual(panelDriver(lot, 1_700_000_000_000, process.pid), { kind: "service", pid: process.pid });
  assert.equal(driverLabel({ kind: "service", pid: 4242 }), "pilote : le service (pid 4242)");
  // Un lot que le service n'a pas encore adopté : « en adoption » (S-11) — et
  // jamais « pilote absent », puisque le service vit.
  assert.deepEqual(
    panelDriver({ ...lot, owner: { ...lot.owner, pid: 999_999 } }, 1_700_000_000_000, process.pid),
    { kind: "service", pid: null },
  );
  assert.equal(driverLabel({ kind: "service", pid: null }), "pilote : le service (en adoption)");
  // Sans service, plus aucune reprise locale : l'en-tête dit que rien n'avance.
  assert.equal(driverLabel({ kind: "dead" }), "pilote absent — les pipelines n'avancent plus (/service start)");
  assert.doesNotMatch(driverLabel({ kind: "dead" }), /l reprend/, "la reprise locale n'existe plus");
  // Un lot d'un AUTRE process que le service se consulte, comme avant.
  assert.deepEqual(panelDriver({ ...lot, owner: { ...lot.owner, pid: 1 } }, 1_700_000_000_000, null), {
    kind: "foreign",
    pid: 1,
  });
  assert.equal(driverLabel({ kind: "foreign", pid: 1 }), "piloté par pid 1 — consultation");
});
