// Feature miroir-session-chrome, côté extension : omp-chrome recopie en continu TOUT le profil
// Chrome (lib/cookie-mirror.ts) dans le navigateur du poste sur le VPS, par le harness. Jugé
// contre un harness simulé en mémoire (`GET /v1/workstation/vps/mirror`,
// `POST /v1/workstation/vps/cookies`) et une source de cookies sans Chrome.
import test from "node:test";
import assert from "node:assert/strict";
import type { MirrorState, SourceCookie } from "../../omp-chrome/src/lib/cookie-mirror.ts";
import {
  CookieMirror,
  FULL_EVERY_MS,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_ENTRIES,
} from "../../omp-chrome/src/lib/cookie-mirror.ts";

const TARGET = { url: "https://harness.test", token: "jeton", browser: { id: "chrome-perso", label: "Perso" } };
const CONTRACT = ["name", "value", "domain", "path", "secure", "httpOnly", "hostOnly", "sameSite", "expirationDate"];

type Post = { body: Record<string, unknown>; bytes: number; browser: string | undefined };

/** Le harness simulé : la génération annoncée (`null` : pas de miroir) et les envois reçus. */
function fakeHarness() {
  const server = {
    generation: null as string | null,
    /** Statut imposé au prochain POST (503, 409…). */
    failNext: null as number | null,
    mirrorReads: 0,
    posts: [] as Post[],
  };
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/v1/workstation/vps/mirror" && (init.method ?? "GET") === "GET") {
      server.mirrorReads++;
      return json(200, { mirror: server.generation === null ? null : { generation: server.generation } });
    }
    if (url.pathname === "/v1/workstation/vps/cookies" && init.method === "POST") {
      const text = String(init.body);
      const body = JSON.parse(text) as Record<string, unknown>;
      if (server.failNext !== null) {
        const status = server.failNext;
        server.failNext = null;
        return json(status, { error: `refusé (${status})` });
      }
      if (body.generation !== server.generation) return json(409, { error: "génération périmée" });
      server.posts.push({ body, bytes: new TextEncoder().encode(text).length, browser: headers["X-OMP-Browser"] });
      const set = Array.isArray(body.set) ? body.set.length : 0;
      const removed = Array.isArray(body.removed) ? body.removed.length : 0;
      return json(200, { set, removed });
    }
    return json(404, { error: "route inconnue" });
  }) as typeof fetch;
  return { server, fetcher };
}

function cookie(name: string, extra: Partial<SourceCookie> & Record<string, unknown> = {}): SourceCookie {
  return {
    name,
    value: `v-${name}`,
    domain: ".exemple.test",
    path: "/",
    secure: true,
    httpOnly: true,
    hostOnly: false,
    sameSite: "lax",
    expirationDate: 1_900_000_000.5,
    ...extra,
  };
}

/** Un miroir branché sur le harness simulé, un profil modifiable, un état rangé et une horloge réglable. */
function setup(profile: SourceCookie[] = []) {
  const { server, fetcher } = fakeHarness();
  const world = { profile, reads: 0, state: null as MirrorState | null, now: 1_000_000 };
  const mirror = new CookieMirror({
    getAll: async () => {
      world.reads++;
      return world.profile;
    },
    load: async () => world.state,
    save: async (state) => {
      world.state = state;
    },
    now: () => world.now,
    fetcher,
  });
  return { server, world, mirror };
}

test("miroir-session-chrome/AC-1 : sans miroir annoncé, aucun cookie n'est lu ni envoyé, les changements sont abandonnés", async () => {
  const { server, world, mirror } = setup([cookie("sid")]);
  world.state = { generation: "ancienne", fullAt: world.now };
  mirror.recordChange({ removed: false, cookie: cookie("sid"), cause: "explicit" });

  await mirror.tick(TARGET);

  assert.equal(server.mirrorReads, 1);
  assert.equal(world.reads, 0);
  assert.equal(server.posts.length, 0);
  assert.equal(world.state, null);
  assert.equal(mirror.pending, 0);
  // Un changement sans génération rangée n'est jamais envoyé.
  mirror.recordChange({ removed: false, cookie: cookie("sid"), cause: "explicit" });
  await mirror.flush(TARGET);
  assert.equal(server.posts.length, 0);
  assert.equal(mirror.pending, 0);
});

test("miroir-session-chrome/AC-2 : une génération neuve renvoie tout le profil par lots bornés, `full` partout et `last` sur le dernier", async () => {
  const many = Array.from({ length: 2 * MAX_CHUNK_ENTRIES + 500 }, (_, i) => cookie(`c${i}`));
  const { server, world, mirror } = setup(many);
  server.generation = "g1";

  await mirror.tick(TARGET);

  assert.equal(world.reads, 1);
  assert.deepEqual(
    server.posts.map((post) => (post.body.set as unknown[]).length),
    [MAX_CHUNK_ENTRIES, MAX_CHUNK_ENTRIES, 500],
  );
  assert.ok(server.posts.every((post) => post.body.full === true && post.body.generation === "g1"));
  assert.deepEqual(
    server.posts.map((post) => post.body.last === true),
    [false, false, true],
  );
  assert.ok(server.posts.every((post) => post.browser === "chrome-perso"));
  const sent = server.posts.flatMap((post) => (post.body.set as { name: string }[]).map((c) => c.name));
  assert.deepEqual(
    sent,
    many.map((c) => c.name),
  );
  assert.deepEqual(world.state, { generation: "g1", fullAt: world.now });

  // Même génération, copie récente : rien n'est relu.
  server.posts.length = 0;
  await mirror.tick(TARGET);
  assert.equal(world.reads, 1);
  assert.equal(server.posts.length, 0);

  // Des cookies lourds : chaque lot tient aussi en octets, très en deçà du 1 Mio du serveur.
  world.profile = Array.from({ length: 400 }, (_, i) => cookie(`lourd${i}`, { value: "x".repeat(4000) }));
  world.now += FULL_EVERY_MS;
  await mirror.tick(TARGET);
  assert.equal(world.reads, 2);
  assert.ok(server.posts.length > 1);
  assert.ok(
    server.posts.every((post) => post.bytes <= MAX_CHUNK_BYTES + 1024),
    "lot trop gros",
  );
  assert.equal((server.posts.flatMap((post) => post.body.set as unknown[]) as unknown[]).length, 400);
  assert.equal(server.posts.filter((post) => post.body.last === true).length, 1);
  assert.equal(server.posts.at(-1)?.body.last, true);

  // Un profil vide envoie quand même un lot complet et dernier.
  const empty = setup([]);
  empty.server.generation = "g2";
  await empty.mirror.tick(TARGET);
  assert.deepEqual(
    empty.server.posts.map((post) => post.body),
    [{ generation: "g2", full: true, last: true, set: [] }],
  );
});

test("miroir-session-chrome/AC-3 : les changements se regroupent (le dernier l'emporte, l'écrasement est ignoré) et partent avec la génération", async () => {
  const { server, world, mirror } = setup();
  server.generation = "g1";
  await mirror.tick(TARGET);
  server.posts.length = 0;

  // Écrasement de « a » : le retrait d'écrasement est ignoré, la pose suivante l'emporte.
  mirror.recordChange({ removed: false, cookie: cookie("a", { value: "1" }), cause: "explicit" });
  mirror.recordChange({ removed: true, cookie: cookie("a", { value: "1" }), cause: "overwrite" });
  mirror.recordChange({ removed: false, cookie: cookie("a", { value: "2" }), cause: "explicit" });
  // « b » posé puis retiré : seul le retrait part.
  mirror.recordChange({ removed: false, cookie: cookie("b"), cause: "explicit" });
  mirror.recordChange({ removed: true, cookie: cookie("b"), cause: "expired" });
  // « c » retiré puis reposé : seule la pose part.
  mirror.recordChange({ removed: true, cookie: cookie("c"), cause: "explicit" });
  mirror.recordChange({ removed: false, cookie: cookie("c"), cause: "explicit" });
  // Un autre chemin est un autre cookie.
  mirror.recordChange({ removed: true, cookie: cookie("c", { path: "/x" }), cause: "evicted" });
  // La navigation privée et les cookies partitionnés ne sont pas recopiés.
  mirror.recordChange({ removed: false, cookie: cookie("prive", { storeId: "1" }), cause: "explicit" });
  mirror.recordChange({
    removed: false,
    cookie: cookie("part", { partitionKey: { topLevelSite: "https://exemple.test" } }),
    cause: "explicit",
  });
  assert.equal(mirror.pending, 4);

  await mirror.flush(TARGET);

  assert.equal(server.posts.length, 1);
  const body = server.posts[0]?.body as { generation: string; full?: boolean; set: SourceCookie[]; removed: unknown[] };
  assert.equal(body.generation, "g1");
  assert.equal(body.full, undefined);
  assert.deepEqual(
    body.set.map((c) => [c.name, c.value]),
    [
      ["a", "2"],
      ["c", "v-c"],
    ],
  );
  assert.deepEqual(body.removed, [
    { name: "b", domain: ".exemple.test", path: "/" },
    { name: "c", domain: ".exemple.test", path: "/x" },
  ]);
  assert.equal(mirror.pending, 0);
  assert.equal(world.reads, 1);

  // Un serveur indisponible garde la file pour l'envoi suivant.
  mirror.recordChange({ removed: true, cookie: cookie("a"), cause: "explicit" });
  server.failNext = 503;
  await assert.rejects(mirror.flush(TARGET));
  assert.equal(mirror.pending, 1);
  await mirror.flush(TARGET);
  assert.deepEqual(server.posts.at(-1)?.body, {
    generation: "g1",
    removed: [{ name: "a", domain: ".exemple.test", path: "/" }],
  });
  assert.equal(mirror.pending, 0);
});

test("miroir-session-chrome/AC-4 : un 409 à l'envoi des changements oublie la génération, le tour suivant renvoie tout le profil", async () => {
  const { server, world, mirror } = setup([cookie("sid"), cookie("lang")]);
  server.generation = "g1";
  await mirror.tick(TARGET);
  assert.equal(world.reads, 1);

  // Le pot du poste est remis à zéro : nouvelle génération côté serveur.
  server.generation = "g2";
  server.posts.length = 0;
  mirror.recordChange({ removed: false, cookie: cookie("sid", { value: "neuf" }), cause: "explicit" });
  await assert.rejects(mirror.flush(TARGET));
  assert.equal(world.state, null);
  assert.equal(server.posts.length, 0);

  world.profile = [cookie("sid", { value: "neuf" }), cookie("lang")];
  await mirror.tick(TARGET);
  assert.equal(world.reads, 2);
  assert.deepEqual(
    server.posts.map((post) => post.body),
    [{ generation: "g2", full: true, last: true, set: world.profile }],
  );
  assert.deepEqual(world.state, { generation: "g2", fullAt: world.now });
  // Le changement d'avant la copie est couvert par elle : il n'est pas renvoyé.
  assert.equal(mirror.pending, 0);
});

test("miroir-session-chrome/AC-5 : un cookie envoyé ne porte que les champs du contrat", async () => {
  const chromeShaped = {
    storeId: "0",
    session: true,
    firstPartyDomain: "",
  };
  const persistent = cookie("sid", { ...chromeShaped, session: false });
  const session = cookie("tmp", { ...chromeShaped, sameSite: "no_restriction" });
  delete session.expirationDate;
  const { server, mirror } = setup([persistent, session]);
  server.generation = "g1";

  await mirror.tick(TARGET);
  mirror.recordChange({ removed: false, cookie: cookie("chg", chromeShaped), cause: "explicit" });
  await mirror.flush(TARGET);

  const sent = server.posts.flatMap((post) => post.body.set as Record<string, unknown>[]);
  assert.equal(sent.length, 3);
  for (const entry of sent) {
    for (const key of Object.keys(entry)) assert.ok(CONTRACT.includes(key), `champ hors contrat : ${key}`);
  }
  assert.equal(sent[0]?.expirationDate, 1_900_000_000.5);
  assert.equal("expirationDate" in (sent[1] ?? {}), false);
  assert.equal(sent[1]?.sameSite, "no_restriction");
  assert.equal(sent[1]?.hostOnly, false);
});
