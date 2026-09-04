// Tests de buildSummary (omp-mem0-req/extension.ts) : fonction pure, ne lit que
// st.reqConfirmed. On construit un ReqState minimal structurellement valide.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSummary } from "../omp-mem0-req/extension.ts";

type Confirmation = { question: string; answer: string; index?: number };
const st = (confirmed: Confirmation[]) => ({
  reqMode: false,
  reqTurns: 0,
  reqMessages: [],
  reqConfirmed: confirmed,
  reqSummary: null,
});

test("buildSummary: aucun besoin confirmé → message d'invite", () => {
  assert.match(buildSummary(st([])), /Aucun besoin/);
});

test("buildSummary: besoins confirmés numérotés avec détail entre parenthèses", () => {
  const out = buildSummary(
    st([
      { question: "stocker les tokens hashés", answer: "argon2id" },
      { question: "TTL de session", answer: "30 min" },
    ]),
  );
  assert.equal(out, "1. ACTION : stocker les tokens hashés (argon2id)\n2. ACTION : TTL de session (30 min)");
});

test("buildSummary: réponse vide → pas de parenthèses", () => {
  assert.equal(buildSummary(st([{ question: "activer le rate-limit", answer: "  " }])), "1. ACTION : activer le rate-limit");
});

test("buildSummary: entrée sans question ignorée, fallback si toutes vides", () => {
  assert.match(buildSummary(st([{ question: "", answer: "x" }])), /Aucun besoin/);
});
