// Le poste de travail, côté plugin : les outils workstation_* exposés au modèle.
// Lecture de l'état, du profil, de l'activité, des meetings et du journal ; action
// dans le navigateur (`workstation_act`), suivie jusqu'à son issue. Aucun outil
// n'approuve ni ne refuse : l'approbation d'un envoi est un geste humain dans l'app.
// Le serveur est un FAUX harness HTTP local qui enregistre chaque requête.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import reqExtension from "../../omp-mem0-req/extension.ts";
import { ACTION_KINDS, APPROVAL_RULE, type actApproval, actWait } from "../../omp-mem0-req/workstation.ts";
import { fakeSchema } from "../support/fake-zod.ts";
import { tmpdir } from "../support/repo.ts";

const TOKEN = "w".repeat(64);
const AT = Date.UTC(2026, 9, 29, 9, 30);
const NAMES = [
  "workstation_status",
  "workstation_profile",
  "workstation_activity",
  "workstation_meetings",
  "workstation_journal",
  "workstation_act",
];

type Part = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Part[]; isError?: boolean };
type Tool = {
  name: string;
  loadMode?: string;
  approval?: unknown;
  description: string;
  execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<Result>;
};

function plugin() {
  const tools = new Map<string, Tool>();
  const pi = {
    zod: { z: fakeSchema() },
    registerCommand: () => undefined,
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    sendUserMessage: () => undefined,
    sendMessage: () => undefined,
    on: () => undefined,
  };
  reqExtension(pi as never);
  return tools;
}

type Seen = { method: string; path: string; auth: string | undefined; body: unknown };
type Reply = { status?: number; payload?: unknown; holdMs?: number };
/** Une réponse fixe, une suite de réponses (la dernière se répète) ou une réponse calculée. */
type Script = Reply | Reply[] | ((url: URL) => Reply);

/** Un faux harness : `script` répond par « MÉTHODE chemin » (sans la query) ; toute requête est enregistrée. */
async function fakeHarness(script: Record<string, Script>) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      seen.push({
        method: req.method ?? "",
        path: url.pathname + url.search,
        auth: req.headers.authorization,
        body: raw === "" ? undefined : JSON.parse(raw),
      });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "jeton refusé" });
      const entry = script[`${req.method} ${url.pathname}`];
      const reply: Reply =
        entry === undefined
          ? { status: 404, payload: { error: "route inconnue" } }
          : typeof entry === "function"
            ? entry(url)
            : Array.isArray(entry)
              ? ((entry.length > 1 ? entry.shift() : entry[0]) as Reply)
              : entry;
      const respond = () => send(reply.status ?? 200, reply.payload ?? {});
      if (reply.holdMs) setTimeout(respond, reply.holdMs);
      else respond();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

/** Le harness visé par les outils ; aucun HARNESS_REPO : le poste ne dépend d'aucun dépôt. */
function pointAt(url: string | null): void {
  for (const key of ["HARNESS_URL", "HARNESS_TOKEN", "HARNESS_REPO"]) delete process.env[key];
  if (url === null) return;
  process.env.HARNESS_URL = url;
  process.env.HARNESS_TOKEN = TOKEN;
}

// Un dossier qui n'est PAS un dépôt git : le poste s'y joint quand même.
const ctx = { cwd: tmpdir("poste-outils-"), hasUI: true, ui: { notify: () => undefined } };

function action(state: string, extra: Record<string, unknown> = {}) {
  return {
    seq: 7,
    createdAt: AT,
    updatedAt: AT,
    origin: "session",
    by: "mac",
    kind: "snapshot",
    params: { tabId: 3 },
    rationale: "lire la facture du client",
    state,
    approved: false,
    approval: null,
    result: null,
    error: null,
    ...extra,
  };
}

const STATUS = {
  online: true,
  lastSeenAt: AT,
  extensionVersion: "0.1.0",
  observedSeconds: 11_520,
  thresholdHours: 8,
  autonomy: { setting: "auto", effective: "observe" },
  paused: false,
  selfIdentities: ["moi@exemple.fr"],
  pending: 2,
  profileUpdatedAt: null,
  lastShift: null,
  nextShiftAt: null,
};

const PROFILE = {
  version: 3,
  updatedAt: AT,
  summary: "Consultant qui facture le vendredi.",
  habits: ["lit ses mails avant 9 h"],
  tools: [{ name: "Gmail", usage: "échanges clients" }],
  schedule: "9 h – 18 h",
  repetitiveTasks: [
    { title: "Facturation", frequency: "hebdomadaire", steps: ["ouvrir Pennylane", "exporter"], automatable: true },
  ],
  clientNeeds: [{ need: "export CSV mensuel", who: "Paul", meetingId: "m1", at: AT }],
  preferences: ["réponses courtes"],
};

const STATS = {
  observedSeconds: 11_520,
  since: AT,
  topSites: [{ host: "mail.google.com", seconds: 3600, share: 0.31 }],
  activeHours: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 1800 : 0)),
  sequences: [{ steps: ["mail.google.com/mail", "app.pennylane.com/invoices/:id"], count: 4 }],
};

const MEETING = {
  id: "m1",
  title: "Point client",
  url: "https://meet.google.com/abc",
  startedAt: AT,
  endedAt: AT + 1_800_000,
  state: "digested",
  summary: "Paul veut un export",
  needs: [{ need: "export CSV mensuel", who: "Paul", due: "fin du mois", quote: "il nous faut le CSV" }],
  segments: 2,
};

const textOf = (result: Result | undefined) =>
  (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

test("poste-outils-omp/AC-1 : les six outils du poste sont essentiels ; seul workstation_act porte un accord, qui classe lecture et écriture par kind", () => {
  const tools = plugin();
  for (const name of NAMES) assert.equal(tools.get(name)?.loadMode, "essential", name);
  for (const name of NAMES.filter((item) => item !== "workstation_act"))
    assert.equal(tools.get(name)?.approval, undefined, name);
  const approval = tools.get("workstation_act")?.approval;
  assert.equal(typeof approval, "function");
  const tier = (args: unknown) => (approval as typeof actApproval)(args).tier;
  const reads = ["tabs", "snapshot", "screenshot", "wait", "decision"];
  for (const kind of ACTION_KINDS)
    assert.equal(tier({ kind, params: {} }), reads.includes(kind) ? "read" : "write", kind);
  // Un appel illisible ou un kind inconnu est classé en écriture : jamais d'accord implicite.
  for (const args of [undefined, null, {}, { kind: 3 }, { kind: "constructor" }, { kind: "send" }])
    assert.equal(tier(args), "write", JSON.stringify(args));
  // Aucun outil d'approbation : l'approbation est un geste humain dans l'app.
  assert.deepEqual(
    [...tools.keys()].filter((name) => /approve|refuse|approb|valid/i.test(name) && name.startsWith("workstation")),
    [],
  );
});

test("poste-outils-omp/AC-2 : chaque outil de lecture appelle sa route avec le jeton Bearer depuis un dossier hors dépôt, et rend une lecture en clair", async () => {
  const server = await fakeHarness({
    "GET /v1/workstation": { payload: STATUS },
    "GET /v1/workstation/profile": { payload: { profile: PROFILE, stats: STATS } },
    "GET /v1/workstation/observations": {
      payload: {
        observations: [
          { id: 1, kind: "visit", at: AT, url: "https://mail.google.com/mail", title: "Boîte", durationMs: 120_000 },
          {
            id: 2,
            kind: "interaction",
            at: AT + 1000,
            url: "https://app.pennylane.com/invoices",
            title: "Factures",
            action: "click",
            target: { role: "button", label: "Exporter" },
          },
        ],
      },
    },
    "GET /v1/workstation/meetings": { payload: { meetings: [MEETING] } },
    "GET /v1/workstation/meetings/m1": {
      payload: {
        meeting: MEETING,
        transcript: [
          { at: AT, speaker: "autres", text: "il nous faut le CSV" },
          { at: AT + 5000, speaker: "moi", text: "je m'en occupe" },
        ],
      },
    },
    "GET /v1/workstation/actions": {
      payload: {
        actions: [
          action("awaiting_approval", {
            kind: "click",
            approval: {
              summary: "Envoyer un message à Paul Martin sur Gmail",
              recipients: ["paul@client.fr"],
              preview: "Bonjour Paul",
              decidedBy: null,
              decidedAt: null,
              reason: null,
            },
          }),
          action("done", { seq: 6, origin: "agent", by: "agent", result: { text: "3 onglets" } }),
        ],
      },
    },
  });
  const tools = plugin();
  pointAt(server.url);
  const call = (name: string, params: unknown) => tools.get(name)?.execute("t", params, undefined, undefined, ctx);
  try {
    const status = await call("workstation_status", {});
    assert.equal(status?.isError, undefined);
    assert.match(textOf(status), /en ligne/);
    assert.match(textOf(status), /3 h 12 min/);
    assert.match(textOf(status), /attente d'approbation : 2/);

    const profile = textOf(await call("workstation_profile", {}));
    for (const expected of [
      /version 3/,
      /## Habitudes\n- lit ses mails avant 9 h/,
      /- Gmail : échanges clients/,
      /Facturation \(hebdomadaire, automatisable\) : ouvrir Pennylane → exporter/,
      /export CSV mensuel — Paul \(meeting m1/,
      /mail\.google\.com 31 %/,
      /9 h : 30 min/,
      /×4/,
    ])
      assert.match(profile, expected);

    const before = Date.now();
    const activity = textOf(await call("workstation_activity", { sinceMin: 30, limit: 9999 }));
    assert.match(activity, /visite « Boîte » https:\/\/mail\.google\.com\/mail \(2 min\)/);
    assert.match(activity, /click sur button « Exporter »/);
    const query = new URL(server.seen.at(-1)?.path ?? "", "http://x").searchParams;
    // `since` = maintenant − 30 min ; la limite est bornée à 500.
    assert.ok(Math.abs(Number(query.get("since")) - (before - 30 * 60_000)) < 5000, query.get("since") ?? "");
    assert.equal(query.get("limit"), "500");

    assert.match(
      textOf(await call("workstation_meetings", {})),
      /\[m1\] Point client — digested.*\n {2}résumé : Paul veut un export/,
    );
    const transcript = textOf(await call("workstation_meetings", { id: "m1" }));
    assert.match(transcript, /autres : il nous faut le CSV\n.*moi : je m'en occupe/);
    assert.match(transcript, /export CSV mensuel — Paul \(échéance : fin du mois\)/);

    const journal = textOf(await call("workstation_journal", { state: "awaiting_approval,done", limit: 5 }));
    assert.match(journal, /#7 .*\[en attente d'approbation\] click/);
    assert.match(journal, /pourquoi : lire la facture du client/);
    assert.match(journal, /approbation : Envoyer un message à Paul Martin sur Gmail → paul@client\.fr/);
    assert.match(journal, /#6 .*\[faite\] snapshot .* par l'agent 24\/24/);

    assert.deepEqual(
      server.seen.map((item) => `${item.method} ${item.path.replace(/since=\d+/, "since=N")}`),
      [
        "GET /v1/workstation",
        "GET /v1/workstation/profile",
        "GET /v1/workstation/observations?since=N&limit=500",
        "GET /v1/workstation/meetings?limit=20",
        "GET /v1/workstation/meetings/m1",
        "GET /v1/workstation/actions?state=awaiting_approval,done&limit=5",
      ],
    );
    assert.ok(server.seen.every((item) => item.auth === `Bearer ${TOKEN}`));

    // Un état inconnu est refusé avant tout appel.
    const count = server.seen.length;
    const bad = await call("workstation_journal", { state: "done,approved" });
    assert.equal(bad?.isError, true);
    assert.match(textOf(bad), /approved/);
    assert.equal(server.seen.length, count);
  } finally {
    pointAt(null);
    await server.close();
  }
});

test("poste-outils-omp/AC-3 : workstation_act dépose l'action avec sa raison, la suit jusqu'à « faite » et rend le snapshot avec ses refs", async () => {
  const server = await fakeHarness({
    "POST /v1/workstation/actions": { status: 201, payload: { action: action("queued") } },
    // Un « running » rendu aussitôt (le plugin patiente alors 1 s avant de relancer l'attente).
    "GET /v1/workstation/actions/7": [
      { payload: { action: action("running") } },
      {
        payload: {
          action: action("done", {
            result: {
              data: {
                title: "Facture 12",
                url: "https://app.pennylane.com/invoices/12",
                text: "Montant 1 200 €",
                elements: [{ ref: "e4", role: "button", label: "Envoyer" }],
              },
            },
          }),
        },
      },
    ],
  });
  const tools = plugin();
  pointAt(server.url);
  try {
    const result = await tools
      .get("workstation_act")
      ?.execute(
        "t",
        { kind: "snapshot", params: { tabId: 3 }, rationale: "lire la facture du client" },
        undefined,
        undefined,
        ctx,
      );
    assert.equal(result?.isError, undefined);
    const out = textOf(result);
    assert.match(out, /Action #7 \(snapshot\) faite/);
    assert.match(out, /Montant 1 200 €/);
    assert.match(out, /\[e4\] button « Envoyer »/);
    assert.deepEqual(server.seen[0], {
      method: "POST",
      path: "/v1/workstation/actions",
      auth: `Bearer ${TOKEN}`,
      body: { kind: "snapshot", params: { tabId: 3 }, rationale: "lire la facture du client" },
    });
    const polls = server.seen.slice(1);
    assert.equal(polls.length, 2);
    for (const poll of polls) {
      assert.match(poll.path, /^\/v1\/workstation\/actions\/7\?wait=\d+$/);
      const wait = Number(new URL(poll.path, "http://x").searchParams.get("wait"));
      assert.ok(wait >= 1 && wait <= 30, poll.path);
    }
  } finally {
    pointAt(null);
    await server.close();
  }
});

test("poste-outils-omp/AC-4 : une action retenue par la garde d'envoi rend aussitôt « en attente d'approbation » et la consigne d'approuver dans l'app, sans relance", async () => {
  const held = action("awaiting_approval", {
    kind: "click",
    params: { tabId: 3, ref: "e4" },
    approval: {
      summary: "Envoyer un message à Paul Martin sur Gmail",
      recipients: ["paul@client.fr"],
      preview: "Bonjour Paul, voici la facture.",
      decidedBy: null,
      decidedAt: null,
      reason: null,
    },
  });
  const server = await fakeHarness({
    "POST /v1/workstation/actions": { status: 201, payload: { action: action("queued", { kind: "click" }) } },
    "GET /v1/workstation/actions/7": { payload: { action: held } },
  });
  const tools = plugin();
  pointAt(server.url);
  try {
    const started = Date.now();
    const result = await tools
      .get("workstation_act")
      ?.execute(
        "t",
        { kind: "click", params: { tabId: 3, ref: "e4" }, rationale: "envoyer la facture demandée", waitSec: 120 },
        undefined,
        undefined,
        ctx,
      );
    assert.ok(Date.now() - started < 5000, "rendu sans attendre la fin de waitSec");
    const out = textOf(result);
    assert.match(out, /EN ATTENTE DE L'APPROBATION DE L'HUMAIN : Envoyer un message à Paul Martin sur Gmail/);
    assert.match(out, /paul@client\.fr/);
    assert.match(out, /Bonjour Paul, voici la facture\./);
    assert.ok(out.includes(APPROVAL_RULE));
    assert.match(APPROVAL_RULE, /OMP Console/);
    assert.match(APPROVAL_RULE, /Ne réessaie pas/);
    assert.deepEqual(
      server.seen.map((item) => `${item.method} ${new URL(item.path, "http://x").pathname}`),
      ["POST /v1/workstation/actions", "GET /v1/workstation/actions/7"],
    );
  } finally {
    pointAt(null);
    await server.close();
  }
});

test("poste-outils-omp/AC-5 : waitSec borne l'attente — 30 s par défaut, 0 à 120 ; 0 ne suit pas, une attente courte s'arrête à l'échéance sans redéposer", async () => {
  assert.equal(actWait(undefined), 30);
  assert.equal(actWait(0), 0);
  assert.equal(actWait(-4), 0);
  assert.equal(actWait(45), 45);
  assert.equal(actWait(500), 120);
  assert.equal(actWait(Number.NaN), 30);

  // Le serveur tient chaque attente aussi longtemps qu'on la lui demande, et l'action reste en cours.
  // Délai réel voulu : c'est l'échéance de waitSec contre une vraie requête HTTP qui est jugée.
  const server = await fakeHarness({
    "POST /v1/workstation/actions": { status: 201, payload: { action: action("queued") } },
    "GET /v1/workstation/actions/7": (url) => ({
      payload: { action: action("running") },
      holdMs: Number(url.searchParams.get("wait")) * 1000,
    }),
  });
  const tools = plugin();
  pointAt(server.url);
  const act = (waitSec: number) =>
    tools
      .get("workstation_act")
      ?.execute(
        "t",
        { kind: "snapshot", params: { tabId: 3 }, rationale: "lire la facture du client", waitSec },
        undefined,
        undefined,
        ctx,
      );
  try {
    const none = await act(0);
    assert.equal(none?.isError, undefined);
    assert.match(textOf(none), /toujours en file/);
    assert.match(textOf(none), /workstation_journal/);
    assert.deepEqual(
      server.seen.map((item) => item.method),
      ["POST"],
    );

    const started = Date.now();
    const short = await act(1);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 4000, `${elapsed} ms`);
    assert.match(textOf(short), /toujours en cours/);
    const after = server.seen.slice(1);
    assert.deepEqual(
      after.map((item) => `${item.method} ${item.path}`),
      ["POST /v1/workstation/actions", "GET /v1/workstation/actions/7?wait=1"],
    );
  } finally {
    pointAt(null);
    await server.close();
  }
});

test("poste-outils-omp/AC-6 : un screenshot fait rend l'image JPEG comme contenu image ; sans image transmise, une explication en erreur", async () => {
  const shot = action("done", { kind: "screenshot", params: { tabId: 3 } });
  const server = await fakeHarness({
    "POST /v1/workstation/actions": { status: 201, payload: { action: action("queued", { kind: "screenshot" }) } },
    "GET /v1/workstation/actions/7": [{ payload: { action: shot, image: "/9j/4AAQ" } }, { payload: { action: shot } }],
  });
  const tools = plugin();
  pointAt(server.url);
  const act = () =>
    tools
      .get("workstation_act")
      ?.execute(
        "t",
        { kind: "screenshot", params: { tabId: 3 }, rationale: "vérifier la mise en page" },
        undefined,
        undefined,
        ctx,
      );
  try {
    const result = await act();
    assert.equal(result?.isError, undefined);
    assert.deepEqual(
      result?.content.find((part) => part.type === "image"),
      { type: "image", data: "/9j/4AAQ", mimeType: "image/jpeg" },
    );
    assert.match(textOf(result), /Action #7 \(screenshot\) faite/);
    const lost = await act();
    assert.equal(lost?.isError, true);
    assert.equal(
      lost?.content.some((part) => part.type === "image"),
      false,
    );
    assert.match(textOf(lost), /refais un screenshot/);
  } finally {
    pointAt(null);
    await server.close();
  }
});

test("poste-outils-omp/AC-7 : workstation_act refuse avant tout appel une raison vide, un kind inconnu ou des params qui ne sont pas un objet", async () => {
  const server = await fakeHarness({});
  const tools = plugin();
  pointAt(server.url);
  const act = (params: unknown) => tools.get("workstation_act")?.execute("t", params, undefined, undefined, ctx);
  try {
    const empty = await act({ kind: "open", params: { url: "https://exemple.fr" }, rationale: "   " });
    assert.equal(empty?.isError, true);
    assert.match(textOf(empty), /rationale/);
    const unknown = await act({ kind: "send", params: {}, rationale: "écrire à Paul" });
    assert.equal(unknown?.isError, true);
    assert.match(textOf(unknown), /send/);
    const list = await act({ kind: "tabs", params: [], rationale: "voir les onglets" });
    assert.equal(list?.isError, true);
    assert.equal(server.seen.length, 0);
  } finally {
    pointAt(null);
    await server.close();
  }
});

test("poste-outils-omp/AC-8 : aucun outil n'émet jamais de requête vers une route /approve ou /refuse, quel que soit l'état rendu", async () => {
  const approval = {
    summary: "Envoyer un message",
    recipients: [],
    preview: "Salut",
    decidedBy: null,
    decidedAt: null,
    reason: null,
  };
  const server = await fakeHarness({
    "GET /v1/workstation": { payload: { ...STATUS, pending: 1 } },
    "GET /v1/workstation/profile": { payload: { profile: null, stats: { ...STATS, topSites: [], sequences: [] } } },
    "GET /v1/workstation/observations": { payload: { observations: [] } },
    "GET /v1/workstation/meetings": { payload: { meetings: [] } },
    "GET /v1/workstation/meetings/m1": { payload: { meeting: MEETING, transcript: [] } },
    "GET /v1/workstation/actions": { payload: { actions: [action("awaiting_approval", { approval })] } },
    "POST /v1/workstation/actions": { status: 201, payload: { action: action("queued") } },
    "GET /v1/workstation/actions/7": [
      { payload: { action: action("awaiting_approval", { approval }) } },
      { payload: { action: action("refused", { approval: { ...approval, decidedBy: "iphone", reason: "non" } }) } },
      { payload: { action: action("expired", { approval }) } },
      { payload: { action: action("failed", { error: "ref périmée" }) } },
      { payload: { action: action("done") } },
    ],
  });
  const tools = plugin();
  pointAt(server.url);
  const call = (name: string, params: unknown) => tools.get(name)?.execute("t", params, undefined, undefined, ctx);
  try {
    await call("workstation_status", {});
    await call("workstation_profile", {});
    await call("workstation_activity", {});
    await call("workstation_meetings", {});
    await call("workstation_meetings", { id: "m1" });
    await call("workstation_journal", { state: "awaiting_approval" });
    const outcomes: Result[] = [];
    for (let index = 0; index < 5; index += 1) {
      const result = await call("workstation_act", {
        kind: "click",
        params: { tabId: 3, ref: "e4" },
        rationale: "répondre au client",
      });
      if (result) outcomes.push(result);
    }
    assert.match(textOf(outcomes[0]), /EN ATTENTE DE L'APPROBATION/);
    assert.match(textOf(outcomes[1]), /refusée par l'humain : non\. Ne la refais pas/);
    assert.equal(outcomes[1]?.isError, true);
    assert.match(textOf(outcomes[2]), /expirée/);
    assert.match(textOf(outcomes[3]), /échouée : ref périmée/);
    assert.equal(outcomes[4]?.isError, undefined);
    assert.ok(server.seen.length >= 16);
    assert.deepEqual(
      server.seen.filter((item) => /\/(approve|refuse)(\/|\?|$)/.test(item.path)),
      [],
    );
    // Un POST n'est jamais rien d'autre que le dépôt d'une action.
    assert.deepEqual(
      [...new Set(server.seen.filter((item) => item.method !== "GET").map((item) => item.path))],
      ["/v1/workstation/actions"],
    );
  } finally {
    pointAt(null);
    await server.close();
  }
});

test("poste-outils-omp/AC-9 : harness non appairé, injoignable, poste hors ligne ou en pause, jeton non propriétaire — chaque cas rend un refus en clair", async () => {
  const tools = plugin();
  const home = process.env.HOME;
  const calls: [string, unknown][] = [
    ["workstation_status", {}],
    ["workstation_profile", {}],
    ["workstation_activity", {}],
    ["workstation_meetings", {}],
    ["workstation_journal", {}],
    ["workstation_act", { kind: "tabs", params: {}, rationale: "voir les onglets" }],
  ];
  const call = (name: string, params: unknown) => tools.get(name)?.execute("t", params, undefined, undefined, ctx);
  try {
    // Pas appairé : ni variable d'environnement, ni ~/.omp/harness.json.
    pointAt(null);
    process.env.HOME = tmpdir("poste-outils-home-");
    for (const [name, params] of calls) {
      const result = await call(name, params);
      assert.equal(result?.isError, true, name);
      assert.match(textOf(result), /harness non configuré/, name);
    }
    process.env.HOME = home;

    // Injoignable : un port fermé.
    const gone = await fakeHarness({});
    await gone.close();
    pointAt(gone.url);
    for (const [name, params] of calls) {
      const result = await call(name, params);
      assert.equal(result?.isError, true, name);
      assert.match(textOf(result), /harness injoignable/, name);
    }

    const offline = await fakeHarness({
      "POST /v1/workstation/actions": { status: 409, payload: { error: "l'extension du poste est hors ligne" } },
    });
    pointAt(offline.url);
    const off = await call("workstation_act", calls[5]?.[1]);
    assert.equal(off?.isError, true);
    assert.match(textOf(off), /hors ligne.*Chrome.*omp-chrome/s);
    await offline.close();

    const paused = await fakeHarness({
      "POST /v1/workstation/actions": { status: 409, payload: { error: "le poste est en pause" } },
    });
    pointAt(paused.url);
    const pause = await call("workstation_act", calls[5]?.[1]);
    assert.equal(pause?.isError, true);
    assert.match(textOf(pause), /en pause.*OMP Console/s);
    await paused.close();

    const scoped = await fakeHarness({
      "GET /v1/workstation": { status: 403, payload: { error: "le poste est réservé au propriétaire" } },
    });
    pointAt(scoped.url);
    const denied = await call("workstation_status", {});
    assert.equal(denied?.isError, true);
    assert.match(textOf(denied), /réservé au propriétaire.*jeton sans filtre de dépôts/s);
    await scoped.close();
  } finally {
    process.env.HOME = home;
    pointAt(null);
  }
});
