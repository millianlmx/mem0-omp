// Le jeton du service comparé en temps constant (token-compare-non-constant-time) :
// le VRAI routeur (`createServiceRequestHandler`) invoqué directement, sur la
// route protégée `GET /v1/health` dont la doublure compte ses appels.
//
// Ce fichier est LE SEUL porteur des ids `token-compare-non-constant-time/AC-<n>` :
// un id par test.
import test from "node:test";
import assert from "node:assert/strict";
import { SERVICE_TOKEN_HEADER, createServiceRequestHandler } from "../../omp-mem0-req/serviceHttp.ts";
import type { ServiceApi } from "../../omp-mem0-req/serviceApi.ts";

const T = "a".repeat(32);
const HEALTH = { ok: true };
const REFUSAL = { status: 401, body: '{"error":"unauthorized"}' };

type Handle = (req: Request) => Promise<Response>;
type Reply = { status: number; body: string };

function handlerFor(token: string): { handle: Handle; calls: { n: number } } {
  const calls = { n: 0 };
  const api = {
    health: async () => {
      calls.n++;
      return HEALTH;
    },
  } as unknown as ServiceApi;
  return { handle: createServiceRequestHandler({ api, token }), calls };
}

async function send(handle: Handle, header: string | null): Promise<Reply> {
  const response = await handle(
    new Request("http://127.0.0.1/v1/health", {
      headers: header === null ? {} : { [SERVICE_TOKEN_HEADER]: header },
    }),
  );
  return { status: response.status, body: await response.text() };
}

/** Les en-têtes refusés d'AC-2 à AC-5, jeton configuré `T`. */
const REFUSED: Record<string, (string | null)[]> = {
  "AC-2": [null],
  "AC-3": [T.slice(0, 31), "a"],
  "AC-4": [`${T}a`, T + "b".repeat(32)],
  "AC-5": ["b".repeat(32), `${T.slice(0, 31)}b`, "é".repeat(32)],
};

async function assertRefused(ac: string): Promise<Reply[]> {
  const replies: Reply[] = [];
  for (const header of REFUSED[ac]!) {
    const { handle, calls } = handlerFor(T);
    const reply = await send(handle, header);
    assert.equal(reply.status, 401, `${ac} ${JSON.stringify(header)} : ${reply.body}`);
    assert.equal(calls.n, 0, `${ac} ${JSON.stringify(header)} : handler protégé atteint`);
    replies.push(reply);
  }
  return replies;
}

test("token-compare-non-constant-time/AC-1 : le jeton configuré exact atteint le handler protégé (200, corps de health)", async () => {
  const { handle, calls } = handlerFor(T);
  const reply = await send(handle, T);
  assert.equal(reply.status, 200, reply.body);
  assert.deepEqual(JSON.parse(reply.body), HEALTH);
  assert.equal(calls.n, 1);
});

test("token-compare-non-constant-time/AC-2 : sans en-tête X-OMP-Service-Token ⇒ 401, handler non atteint", async () => {
  await assertRefused("AC-2");
});

test("token-compare-non-constant-time/AC-3 : jeton plus court (préfixe strict compris) ⇒ 401, handler non atteint", async () => {
  await assertRefused("AC-3");
});

test("token-compare-non-constant-time/AC-4 : jeton plus long (jeton configuré suivi d'autres caractères) ⇒ 401, handler non atteint", async () => {
  await assertRefused("AC-4");
});

test("token-compare-non-constant-time/AC-5 : jeton de même longueur mais différent ⇒ 401 (y compris 32 « é » = 64 octets : 401, pas 500)", async () => {
  await assertRefused("AC-5");
});

test("token-compare-non-constant-time/AC-6 : les refus (en-tête absent, plus court, plus long, même longueur différent) ont statut et corps strictement identiques", async () => {
  const replies: Reply[] = [];
  for (const ac of Object.keys(REFUSED)) replies.push(...(await assertRefused(ac)));
  assert.equal(replies.length, 8);
  for (const reply of replies) assert.deepEqual(reply, REFUSAL);
});

test("token-compare-non-constant-time/AC-7 : jeton configuré vide ⇒ toute requête (sans en-tête, en-tête vide, jeton quelconque) reçoit 401", async () => {
  for (const header of [null, "", T]) {
    const { handle, calls } = handlerFor("");
    const reply = await send(handle, header);
    assert.deepEqual(reply, REFUSAL, `en-tête ${JSON.stringify(header)}`);
    assert.equal(calls.n, 0, `en-tête ${JSON.stringify(header)} : handler protégé atteint`);
  }
});
