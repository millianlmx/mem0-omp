// Feature harness-securite-api : l'API ne se laisse ni casser ni lire par la bande — un
// fichier de clients édité à la main et cassé garde le dernier jeu de clients lu (le jeton
// historique compris), un client ne retire que ses propres jetons push, et une erreur
// interne reste au journal du service au lieu de partir dans la réponse.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { HarnessError } from "../../omp-harness/errors.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);

async function serve(world: FakeWorld, clients: ClientRegistry, log: (line: string) => void = () => {}) {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients, log }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    call: async (method: string, route: string, token: string, body?: unknown) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("harness-securite-api/AC-1 : un fichier de clients cassé garde le dernier jeu lu et le jeton historique, l'erreur est dite une fois par version, et aucune écriture ne l'écrase", () => {
  const file = path.join(tmpdir("harness-securite-clients-"), "clients.json");
  const lines: string[] = [];
  const registry = new ClientRegistry(file, ADMIN, (line) => lines.push(line));
  const { token } = registry.add("iphone", "viewer", ["demo"]);
  assert.equal(registry.authenticate(token)?.name, "iphone");

  // Une virgule de trop, tapée à la main.
  fs.writeFileSync(file, `${fs.readFileSync(file, "utf8").trimEnd().slice(0, -1)},}\n`);
  assert.equal(registry.authenticate(ADMIN)?.role, "admin", "le jeton historique vaut toujours");
  assert.equal(registry.authenticate(token)?.name, "iphone", "le dernier jeu lu reste en vigueur");
  registry.authenticate(token);
  registry.list();
  assert.equal(lines.length, 1, `une seule ligne pour cette version du fichier : ${lines.join(" | ")}`);
  assert.match(lines[0] as string, /clients\.json illisible, 1 client\(s\) de la dernière lecture gardé\(s\)/);

  // Ajouter ou révoquer réécrirait le fichier sans les clients qu'il déclare : refusé.
  const broken = fs.readFileSync(file, "utf8");
  assert.throws(() => registry.add("mac", "operator", "*"), /illisible, corrige-le d'abord/);
  assert.throws(() => registry.revoke("iphone"), /illisible, corrige-le d'abord/);
  assert.equal(fs.readFileSync(file, "utf8"), broken, "le fichier cassé est laissé tel quel");
  // La ligne de commande (un registre neuf, sans dernière lecture) ne l'écrase pas non plus.
  const cli = new ClientRegistry(file, null, () => {});
  assert.throws(() => cli.add("mac", "operator", "*"), /illisible/);
  assert.equal(cli.authenticate(ADMIN), null);

  // Une nouvelle version, cassée autrement : dite à son tour ; corrigée : relue.
  fs.writeFileSync(file, "null\n");
  registry.authenticate(token);
  assert.equal(lines.length, 2);
  fs.writeFileSync(file, `${JSON.stringify({ clients: [] })}\n`);
  assert.equal(registry.authenticate(token), null, "le fichier corrigé fait foi");
  assert.equal(registry.add("mac", "operator", "*").client.name, "mac");
});

test("harness-securite-api/AC-2 : `DELETE /v1/push/activities/{jeton}` ne retire que les jetons du client qui appelle ; un admin les retire tous", async () => {
  const world = fakeWorld({});
  world.store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  const clients = new ClientRegistry(path.join(tmpdir("harness-securite-push-"), "clients.json"), ADMIN);
  const iphone = clients.add("iphone", "viewer", ["demo"]).token;
  const ipad = clients.add("ipad", "viewer", ["demo"]).token;
  const api = await serve(world, clients);
  const tokens = () =>
    world.store
      .listPushTokens({ kind: "activity", runId: "r1" })
      .map((row) => `${row.client}:${row.token.slice(0, 2)}`)
      .sort();
  try {
    for (const [token, bearer] of [
      ["ab", iphone],
      ["cd", ipad],
      ["ef", ipad],
    ] as const) {
      const registered = await api.call("POST", "/v1/push/activities", bearer, {
        runId: "r1",
        token: token.repeat(32),
      });
      assert.equal(registered.status, 201);
    }
    const foreign = await api.call("DELETE", `/v1/push/activities/${"cd".repeat(32)}`, iphone);
    assert.deepEqual([foreign.status, foreign.json.removed], [200, false]);
    assert.deepEqual(tokens(), ["ipad:cd", "ipad:ef", "iphone:ab"], "le jeton de l'iPad est resté");

    const own = await api.call("DELETE", `/v1/push/activities/${"ab".repeat(32)}`, iphone);
    assert.deepEqual([own.status, own.json.removed], [200, true]);
    const again = await api.call("DELETE", `/v1/push/activities/${"ab".repeat(32)}`, iphone);
    assert.deepEqual([again.status, again.json.removed], [200, false], "retirer deux fois reste un succès");

    const admin = await api.call("DELETE", `/v1/push/activities/${"cd".repeat(32)}`, ADMIN);
    assert.deepEqual([admin.status, admin.json.removed], [200, true]);
    assert.deepEqual(tokens(), ["ipad:ef"]);
  } finally {
    await api.close();
  }
});

test("harness-securite-api/AC-3 : une erreur imprévue rend un 500 générique avec une référence, sa cause va au journal ; une HarnessError garde son statut et son message", async () => {
  const world = fakeWorld({});
  const clients = new ClientRegistry(null, ADMIN);
  const lines: string[] = [];
  const api = await serve(world, clients, (line) => lines.push(line));
  const orchestrator = world.orchestrator as unknown as Record<string, unknown>;
  try {
    orchestrator.status = () => {
      throw new Error("EACCES: open '/var/lib/omp-harness/state/providers.env' (sk-secret-1234)");
    };
    const failed = await api.call("GET", "/v1/status", ADMIN);
    assert.equal(failed.status, 500);
    const message = String(failed.json.error);
    assert.match(message, /^erreur interne \(réf\. [0-9a-f]{8}\)$/);
    assert.ok(!message.includes("providers.env") && !message.includes("sk-secret"), message);
    const ref = /réf\. ([0-9a-f]{8})/.exec(message)?.[1] as string;
    const logged = lines.find((line) => line.includes(ref)) ?? "";
    assert.match(logged, /GET \/v1\/status : erreur interne [0-9a-f]{8} — Error: EACCES: open '\/var\/lib/);

    orchestrator.status = () => {
      throw new HarnessError(409, "le run a changé d'état (running)");
    };
    const refused = await api.call("GET", "/v1/status", ADMIN);
    assert.deepEqual([refused.status, refused.json.error], [409, "le run a changé d'état (running)"]);
  } finally {
    await api.close();
  }
});
