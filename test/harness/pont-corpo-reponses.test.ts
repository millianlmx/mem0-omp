// Feature pont-corpo-reponses : quand un run lié à l'origine d'un collègue passe `merged`, `failed` ou
// `cancelled`, le serveur rédige un brouillon de réponse (`final`, `attente`) ; l'approbateur le relit,
// l'approuve (une demande du poste saisit le texte exact dans le fil) et l'envoi attend une seconde
// approbation, celle de la garde d'envoi du poste. Rien ne part sans ces deux gestes ; aucun client
// Gmail ou Slack n'existe. Noms, adresses, fils, liens et jetons : fictifs.
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { REPLY_TYPED_UNCONFIRMED } from "../../omp-harness/corporate/replies.ts";
import type {
  EventRow,
  ReplyRow,
  RunRow,
  SignalChannel,
  WorkstationAction,
  WorkstationRequest,
} from "../../omp-harness/db.ts";
import { EVENT_TYPES } from "../../omp-harness/events.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { newId } from "../../omp-harness/ids.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import { workstationOwner } from "../../omp-harness/session-feed.ts";
import {
  REPLY_APPROVAL_SUMMARY,
  REPLY_SEND_GUARD,
  REPLY_SEND_TAKEN,
  uploadDir,
} from "../../omp-harness/workstation.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

// -- données fictives ------------------------------------------------------------------------------

const COLLEAGUE = "alice.martin";
const COLLEAGUE_MAIL = "camille.durand@client.example";
const THREAD = "1700000000.000100";
const PR = "https://github.com/moi/demo/pull/7";
const SUBJECT = "fix(export): borne la liste des lignes exportées";
const TITLE = "L'export plante sur les grosses listes";
const EXCERPT =
  "Le bouton Exporter plante dès que la liste dépasse 200 lignes. C'est bloquant pour la clôture mensuelle.";
const ACTOR = { by: "app-approbateur" };
const APPROVER_MARK = "seul l'appareil approbateur";
const OWNER_ONLY = "le poste est réservé au propriétaire";
const ACTS_ON_REPLIES = "geste réservé à l'humain — un client pilote n'agit pas sur les réponses aux collègues";
const READS_REPLIES = "réservé à l'humain — un client pilote ne lit pas les réponses aux collègues";
/** L'extension rapporte ces onglets comme ceux de la fenêtre de l'agent : les gestes y partent sans garde d'onglet. */
const TABS = { "X-OMP-Agent-Tabs": "1,2,3" };
const IDLE = { "poste-demande": [[{ sleep: 120_000 }]] };
const ACT = (args: Record<string, unknown>) => ({ tool: "workstation_act", args });
const REPORT = (report: string) => ({ tool: "workstation_request_report", args: { report } });

/** Le brouillon `final` que le gabarit du serveur rédige pour un sujet de commit et un lien. */
const finalText = (subject: string, link: string): string =>
  `Bonjour,\n\nC'est corrigé : ${subject}.\n${link}\n\nMerci pour le signalement !`;

// -- le monde ---------------------------------------------------------------------------------------

type HttpReply = { status: number; json: Record<string, unknown> };
type Tokens = { approver: string; operator: string; pilot: string; viewer: string; narrow: string };
type World = {
  world: FakeWorld;
  tokens: Tokens;
  /** Le journal du SERVICE (lignes JSON), pas celui du faux runner. */
  log: string[];
  /** Les adresses appelées par `fetch` : un client Gmail ou Slack en laisserait. */
  fetched: string[];
  /** Tout ce que le store a publié, écrit ou éphémère. */
  published: EventRow[];
  call: (
    token: string,
    method: string,
    route: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<HttpReply>;
  close: () => Promise<void>;
};

async function open(scenario: Record<string, unknown> = IDLE, patch?: (config: HarnessConfig) => void): Promise<World> {
  const log: string[] = [];
  const fetched: string[] = [];
  const fetchDouble = (async (input: unknown) => {
    fetched.push(String(input));
    throw new Error("aucun réseau dans ces tests");
  }) as typeof fetch;
  const world = fakeWorld(scenario, {
    fetch: fetchDouble,
    harnessLog: (line, fields) => log.push(JSON.stringify({ line, fields })),
    ...(patch ? { patch } : {}),
  });
  const published: EventRow[] = [];
  world.store.onEvent((event) => published.push(event));
  const clients = new ClientRegistry(path.join(tmpdir("pont-corpo-reponses-"), "clients.json"), "a".repeat(64));
  const tokens: Tokens = {
    approver: clients.add("app-approbateur", "admin", "*", true).token,
    operator: clients.add("mac", "operator", "*").token,
    pilot: clients.add("vigie", "operator", "*", false, true).token,
    viewer: clients.add("ipad", "viewer", "*").token,
    narrow: clients.add("mac-demo", "operator", ["demo"]).token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    world,
    tokens,
    log,
    fetched,
    published,
    call: async (token, method, route, body, headers = {}) => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, json: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await world.orchestrator.stop();
    },
  };
}

const ws = (w: World) => w.world.orchestrator.workstation;
const store = (w: World) => w.world.store;
const approver = (w: World, method: string, route: string, body?: unknown, headers?: Record<string, string>) =>
  w.call(w.tokens.approver, method, route, body, headers);

/** Un tour de l'orchestrateur à chaque sondage : les jobs du poste partent et finissent, les brouillons se réconcilient. */
async function until(w: World, predicate: () => boolean, describe = "condition"): Promise<void> {
  await waitFor(
    () => {
      void w.world.orchestrator.tick();
      return predicate();
    },
    () => `${describe} ${JSON.stringify(w.world.log().slice(-4))}`,
  );
}

let counter = 0;
const URLS: Record<SignalChannel, (n: number) => string> = {
  slack: (n) => `https://acme.slack.example/archives/C0FAKE/p${n}`,
  gmail: (n) => `https://mail.example/#inbox/${n}`,
  chrome: (n) => `https://wiki.client.example/pages/${n}`,
  manual: () => "",
};

type Linked = {
  channel?: SignalChannel;
  state?: "merged" | "failed" | "cancelled";
  /** Le signal d'une origine déjà créée : un run de plus lui est lié (relance de l'issue). */
  signal?: string;
  prUrl?: string | null;
  subject?: string | null;
  title?: string | null;
};

/** Un signal confirmé et un run lié, tels que la confirmation les laisse (écrits par le store, sans forge). */
function link(w: World, over: Linked = {}): { signal: string; run: RunRow; url: string; threadRef: string } {
  const n = ++counter;
  const channel = over.channel ?? "slack";
  const db = store(w);
  let signalId = over.signal;
  if (signalId === undefined) {
    signalId = newId("sg");
    db.insertSignal({
      id: signalId,
      channel,
      threadRef: `${THREAD}.${n}`,
      url: URLS[channel](n),
      personRef: COLLEAGUE,
      excerpt: EXCERPT,
    });
    db.updateSignal(signalId, {
      state: "confirmed",
      repo: "demo",
      title: over.title === undefined ? TITLE : over.title,
      issueRepo: "demo",
      issueNumber: n,
      issueUrl: `https://github.com/moi/demo/issues/${n}`,
      confirmedBy: "app-approbateur",
      confirmedAt: Date.now(),
    });
  }
  const run = db.createRun({
    id: newId("r"),
    repo: "demo",
    slug: `corpo-${n}`,
    title: `Issue #${n}`,
    request: "corriger",
    branch: `harness/corpo-${n}`,
    state: over.state ?? "merged",
  });
  const subject = over.subject === undefined ? SUBJECT : over.subject;
  db.updateRun(run.id, {
    prUrl: over.prUrl === undefined ? PR : over.prUrl,
    ...(subject === null ? {} : { verdict: { commit: { subject, body: "corps" } } as never }),
  });
  db.linkSignalRun(run.id, signalId);
  const signal = db.getSignal(signalId);
  const threadRef = signal?.threadRef ?? "";
  return { signal: signalId, run: db.getRun(run.id) as RunRow, url: signal?.url ?? "", threadRef };
}

const replies = (w: World, run: string): ReplyRow[] => store(w).repliesOfRun(run);
const reconcile = (w: World): void => w.world.orchestrator.corporateReplies.reconcile();

/** Un run lié, réconcilié : son brouillon est rendu. */
function drafted(w: World, over: Linked = {}) {
  const made = link(w, over);
  reconcile(w);
  const reply = replies(w, made.run.id)[0] as ReplyRow;
  assert.ok(reply, "le brouillon existe");
  return { ...made, reply };
}

/** Le brouillon tel que la route le rend (suivi de l'envoi compris). */
async function view(w: World, id: string): Promise<Record<string, unknown>> {
  const got = await approver(w, "GET", `/v1/replies/${id}`);
  assert.equal(got.status, 200, JSON.stringify(got.json));
  return got.json.reply as Record<string, unknown>;
}

const originOf = async (w: World, runId: string): Promise<Record<string, unknown> | null> => {
  const got = await approver(w, "GET", `/v1/runs/${runId}/origin`);
  assert.equal(got.status, 200, JSON.stringify(got.json));
  return got.json.origin as Record<string, unknown> | null;
};

async function listed(w: World, state?: string): Promise<Record<string, unknown>[]> {
  const got = await approver(w, "GET", `/v1/replies${state === undefined ? "" : `?state=${state}`}`);
  assert.equal(got.status, 200, JSON.stringify(got.json));
  return got.json.replies as Record<string, unknown>[];
}

// -- l'extension du poste ------------------------------------------------------------------------------

/** L'extension se présente (en ligne) et rapporte les onglets de la fenêtre de l'agent. */
async function online(w: World): Promise<void> {
  assert.equal((await approver(w, "GET", "/v1/workstation/next?wait=0", undefined, TABS)).status, 204);
}

/** L'extension loue la prochaine action. */
async function lease(w: World, wait = 25): Promise<WorkstationAction> {
  const next = await approver(w, "GET", `/v1/workstation/next?wait=${wait}`, undefined, TABS);
  assert.equal(next.status, 200, "une action est louée");
  return next.json.action as WorkstationAction;
}

async function give(w: World, seq: number, body: Record<string, unknown>): Promise<void> {
  const got = await approver(w, "POST", `/v1/workstation/actions/${seq}/result`, body);
  assert.equal(got.status, 200, JSON.stringify(got.json));
}

const FINISHED = { outcome: "done", result: { text: "fait" } };
/** L'extension retient un envoi : son aperçu est le texte du compositeur. */
const HELD = (preview: string) => ({
  outcome: "needs_approval",
  approval: { summary: "Envoyer la réponse", recipients: [COLLEAGUE_MAIL], preview },
});

/** L'approbation ordinaire d'une action retenue (la révision affichée). */
function allow(w: World, seq: number): void {
  ws(w).approve(seq, { by: "app-approbateur", rev: ws(w).getAction(seq).updatedAt });
}

const ACTION_REASON = "geste de la réponse";
function act(w: World, requestId: string, kind: string, params: Record<string, unknown>): WorkstationAction {
  return ws(w).createAction({ kind, params, rationale: ACTION_REASON } as never, "agent", "agent", requestId);
}

const CLICK = { tabId: 1, ref: "e2" };
const TYPE = (text: string, extra: Record<string, unknown> = {}) => ({ tabId: 1, ref: "e1", text, ...extra });

/** Un brouillon approuvé : sa demande du poste est en cours (le job la tient, sans rien faire). */
async function approved(w: World, over: Linked = {}, text?: string) {
  const made = drafted(w, over);
  const body = text ?? made.reply.text;
  await online(w);
  const got = await approver(w, "POST", `/v1/replies/${made.reply.id}/approve`, { text: body });
  assert.equal(got.status, 201, JSON.stringify(got.json));
  const request = got.json.request as WorkstationRequest;
  await until(w, () => ws(w).getRequest(request.id).state === "running", "la demande du poste démarre");
  return { ...made, request, text: body };
}

/** La demande est close : son job s'arrête, la suivante peut partir. */
async function ended(w: World, request: WorkstationRequest): Promise<void> {
  ws(w).finishRequest(request.id, { report: "terminé" });
  await until(w, () => !w.world.orchestrator.workstationAgent.isLive("poste-demande"), "le job de la demande s'arrête");
}

const noWorkstationTrace = (w: World): void => {
  assert.deepEqual(store(w).listWorkstationRequests({ limit: 100 }), [], "aucune demande du poste");
  assert.deepEqual(store(w).listWorkstationActions({ limit: 100 }), [], "aucune action du poste");
};

const replyEvents = (w: World): EventRow[] => store(w).eventsOfType("reply");

// -- AC-150 à AC-153 : la rédaction des brouillons ---------------------------------------------------------

test("pont-corpo-reponses/AC-150 : un run lié slack puis gmail passé merged reçoit exactement un brouillon final, avec le lien de la PR et le sujet du commit, sans demande ni action du poste", async () => {
  const w = await open();
  try {
    const slack = link(w, { channel: "slack" });
    const gmailPr = "https://github.com/moi/demo/pull/8";
    const gmailSubject = "feat(export): ajoute le CSV";
    const gmail = link(w, { channel: "gmail", prUrl: gmailPr, subject: gmailSubject });
    await until(w, () => store(w).listReplies({ limit: 10 }).length === 2, "les deux brouillons");
    for (const made of [slack, gmail]) {
      const own = replies(w, made.run.id);
      assert.deepEqual(
        own.map((row) => [row.kind, row.state, row.signalId]),
        [["final", "draft", made.signal]],
      );
      const row = (await listed(w)).find((entry) => entry.runId === made.run.id) as Record<string, unknown>;
      assert.equal(row.channel, store(w).getSignal(made.signal)?.channel);
      assert.equal(row.url, made.url);
      assert.equal(row.personRef, COLLEAGUE);
      assert.equal(row.signalId, made.signal);
      const expected = made === slack ? finalText(SUBJECT, PR) : finalText(gmailSubject, gmailPr);
      assert.equal(row.text, expected);
      assert.equal((await originOf(w, made.run.id))?.reply, "brouillon");
    }
    assert.equal((await listed(w)).length, 2);
    noWorkstationTrace(w);
    assert.deepEqual(w.fetched, [], "aucune requête réseau");
  } finally {
    await w.close();
  }
});

test("pont-corpo-reponses/AC-151 : un seul brouillon final par run malgré les tours et un redémarrage ; sans PR ni sujet de commit, le lien de l'issue et le titre gardé sur la proposition ; un sujet que redact modifierait cède la place au titre", async () => {
  const w = await open();
  let second: Orchestrator | null = null;
  try {
    const made = drafted(w);
    for (let turn = 0; turn < 3; turn++) reconcile(w);
    second = new Orchestrator(w.world.deps);
    second.corporateReplies.reconcile();
    await w.world.orchestrator.tick();
    assert.equal(replies(w, made.run.id).length, 1);
    const created = replyEvents(w).filter((event) => event.payload.state === "draft");
    assert.equal(created.length, 1, "un événement de création");

    const bare = drafted(w, { prUrl: null, subject: null });
    const issueUrl = store(w).getSignal(bare.signal)?.issueUrl as string;
    assert.equal(bare.reply.text, finalText(TITLE, issueUrl));
    const noTitle = drafted(w, { prUrl: null, subject: null, title: "" });
    assert.match(noTitle.reply.text, /C'est corrigé : l'issue #\d+\./);

    const leaky = drafted(w, { subject: "fix(auth): token: expiré après 5 min" });
    assert.equal(leaky.reply.text, finalText(TITLE, PR), "le sujet que redact masquerait n'est pas repris");
    const approvable = await approver(w, "PUT", `/v1/replies/${leaky.reply.id}`, { text: leaky.reply.text });
    assert.equal(approvable.status, 200, "un brouillon rédigé passe les contrôles de la modification");
  } finally {
    await second?.stop();
    await w.close();
  }
});

test("pont-corpo-reponses/AC-152 : un run failed puis un run cancelled ont chacun un brouillon attente unique ; après relance et fusion, le brouillon final du nouveau run apparaît sans dupliquer l'attente", async () => {
  const w = await open();
  try {
    const failed = link(w, { state: "failed", channel: "gmail" });
    const cancelled = link(w, { state: "cancelled", channel: "slack" });
    for (let turn = 0; turn < 3; turn++) await w.world.orchestrator.tick();
    for (const made of [failed, cancelled]) {
      assert.deepEqual(
        replies(w, made.run.id).map((row) => [row.kind, row.signalId]),
        [["attente", made.signal]],
      );
    }
    const text = replies(w, failed.run.id)[0]?.text as string;
    assert.match(text, /n'a pas encore abouti/);
    assert.ok(text.includes(store(w).getSignal(failed.signal)?.issueUrl as string), "le lien de l'issue");
    assert.equal(text.includes(PR), false);
    noWorkstationTrace(w);

    const relaunched = link(w, { signal: failed.signal, state: "merged", channel: "gmail" });
    for (let turn = 0; turn < 2; turn++) reconcile(w);
    assert.deepEqual(
      replies(w, relaunched.run.id).map((row) => row.kind),
      ["final"],
    );
    assert.deepEqual(
      replies(w, failed.run.id).map((row) => row.kind),
      ["attente"],
      "pas de second attente",
    );
    assert.equal(store(w).listReplies({ limit: 50 }).length, 3);
  } finally {
    await w.close();
  }
});

test("pont-corpo-reponses/AC-153 : pas d'attente pour un run dépassé ; l'attente en brouillon est classée à la relance, celle en attente d'approbation ne l'est pas ; relance sur place : un seul attente, classé à la fusion", async () => {
  const w = await open();
  try {
    // Un run échoué dont l'issue a déjà été relancée avant le tour : aucune attente pour lui.
    const old = link(w, { state: "failed" });
    link(w, { signal: old.signal, state: "failed" });
    reconcile(w);
    assert.deepEqual(replies(w, old.run.id), [], "aucun attente pour l'ancien run");

    // Une attente en brouillon avant la relance : classée au tour suivant, texte gardé, approbation refusée.
    const first = drafted(w, { state: "failed", channel: "gmail" });
    assert.equal(
      (await listed(w)).some((entry) => entry.id === first.reply.id),
      true,
    );
    link(w, { signal: first.signal, state: "failed", channel: "gmail" });
    await online(w);
    reconcile(w);
    const listedNow = (await listed(w)).some((entry) => entry.id === first.reply.id);
    assert.equal(listedNow, false, "absente de la liste par défaut");
    assert.equal((await originOf(w, first.run.id))?.reply, "aucune");
    assert.equal((await view(w, first.reply.id)).state, "archived");
    assert.equal((await view(w, first.reply.id)).text, first.reply.text);
    const refused = await approver(w, "POST", `/v1/replies/${first.reply.id}/approve`, { text: first.reply.text });
    assert.equal(refused.status, 409);
    assert.deepEqual(store(w).listWorkstationRequests({ limit: 10 }), []);

    // Une attente déjà en attente d'approbation à la relance : elle n'est pas classée.
    const pending = drafted(w, { state: "failed", channel: "slack" });
    const asked = await approver(w, "POST", `/v1/replies/${pending.reply.id}/approve`, { text: pending.reply.text });
    assert.equal(asked.status, 201, JSON.stringify(asked.json));
    link(w, { signal: pending.signal, state: "failed", channel: "slack" });
    reconcile(w);
    assert.equal((await view(w, pending.reply.id)).state, "pending");
    ws(w).cancelRequest((asked.json.request as WorkstationRequest).id, ACTOR);

    // Relance sur place : le même run échoue de nouveau (rien de recréé), puis passe merged.
    const place = drafted(w, { state: "failed", channel: "gmail" });
    store(w).updateRun(place.run.id, { state: "failed" });
    reconcile(w);
    assert.deepEqual(
      replies(w, place.run.id).map((row) => row.kind),
      ["attente"],
    );
    assert.equal(
      (await listed(w)).some((entry) => entry.id === place.reply.id),
      true,
      "toujours dans la liste",
    );
    store(w).updateRun(place.run.id, { state: "merged" });
    reconcile(w);
    assert.deepEqual(
      replies(w, place.run.id)
        .map((row) => [row.kind, row.state])
        .sort(),
      [
        ["attente", "archived"],
        ["final", "draft"],
      ],
    );
    assert.equal((await originOf(w, place.run.id))?.reply, "brouillon");
    const late = await approver(w, "POST", `/v1/replies/${place.reply.id}/approve`, { text: place.reply.text });
    assert.equal(late.status, 409);

    // Relancé sur place et passé merged avant tout tour : un final seulement.
    const fast = link(w, { state: "failed" });
    store(w).updateRun(fast.run.id, { state: "merged" });
    reconcile(w);
    assert.deepEqual(
      replies(w, fast.run.id).map((row) => row.kind),
      ["final"],
    );
  } finally {
    await w.close();
  }
});

// -- AC-154 à AC-159 : modification, approbation, envoi ---------------------------------------------------------

test("pont-corpo-reponses/AC-154 : l'approbation porte le texte approuvé, seul texte de la consigne et de la saisie ; un non approbateur ne modifie pas ; un texte modifié entre-temps est écrasé ; un brouillon en attente ou envoyé ne se modifie plus", async () => {
  const w = await open();
  try {
    const made = drafted(w, { channel: "gmail" });
    const id = made.reply.id;
    const edited = `${made.reply.text}\n\nJe reste disponible pour un point.`;
    const put = await approver(w, "PUT", `/v1/replies/${id}`, { text: edited });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(replies(w, made.run.id)[0]?.text, edited);
    assert.equal(replyEvents(w).length, 1, "la modification n'émet aucun événement");

    // Un propriétaire non approbateur ne modifie pas ; un texte vide, trop long ou secret est refusé.
    const operator = await w.call(w.tokens.operator, "PUT", `/v1/replies/${id}`, { text: "autre" });
    assert.equal(operator.status, 403);
    assert.ok(String(operator.json.error).includes(APPROVER_MARK));
    assert.equal(replies(w, made.run.id)[0]?.text, edited);
    for (const bad of ["   ", "x".repeat(1501), `ghp_${"a".repeat(36)}`, "token: abcdef123456"]) {
      assert.equal((await approver(w, "PUT", `/v1/replies/${id}`, { text: bad })).status, 400);
    }
    assert.equal((await approver(w, "PUT", `/v1/replies/${id}`, {})).status, 400);

    // Une autre fenêtre modifie en T2 ; l'approbation porte T : T écrase T2 et c'est T qui part.
    await approver(w, "PUT", `/v1/replies/${id}`, { text: "Texte T2 de l'autre fenêtre." });
    await online(w);
    const approvedRes = await approver(w, "POST", `/v1/replies/${id}/approve`, { text: edited });
    assert.equal(approvedRes.status, 201, JSON.stringify(approvedRes.json));
    const request = approvedRes.json.request as WorkstationRequest;
    assert.equal((approvedRes.json.reply as ReplyRow).state, "pending");
    assert.equal((approvedRes.json.reply as ReplyRow).text, edited);
    assert.ok(request.instruction.includes(edited));
    assert.equal(request.instruction.includes("T2"), false);
    assert.ok(request.instruction.includes(made.url), "la consigne porte l'url du fil");
    assert.equal(replies(w, made.run.id)[0]?.text, edited);
    await until(w, () => ws(w).getRequest(request.id).state === "running");
    // La seule saisie acceptée est T.
    assert.throws(() => act(w, request.id, "type", TYPE("Texte T2 de l'autre fenêtre.")), /saisie refusée/);
    const typed = act(w, request.id, "type", TYPE(edited));
    assert.equal(typed.params.text, edited);

    // En attente d'approbation : plus de modification ni de seconde approbation.
    const locked = await approver(w, "PUT", `/v1/replies/${id}`, { text: "encore" });
    assert.equal(locked.status, 409);
    assert.equal(replies(w, made.run.id)[0]?.text, edited);
    assert.equal((await approver(w, "POST", `/v1/replies/${id}/approve`, { text: edited })).status, 409);
    store(w).updateReplyIf(id, ["pending"], { state: "sent" });
    assert.equal((await approver(w, "PUT", `/v1/replies/${id}`, { text: "encore" })).status, 409);
    assert.equal(replies(w, made.run.id)[0]?.text, edited);
  } finally {
    await w.close();
  }
});

test("pont-corpo-reponses/AC-155 : un brouillon gmail ne s'approuve pas par un operator non approbateur ni par un client pilote ; aucune demande, état inchangé", async () => {
  const w = await open();
  try {
    const made = drafted(w, { channel: "gmail" });
    const route = `/v1/replies/${made.reply.id}/approve`;
    const operator = await w.call(w.tokens.operator, "POST", route, { text: made.reply.text });
    assert.equal(operator.status, 403);
    assert.ok(String(operator.json.error).includes(APPROVER_MARK), String(operator.json.error));
    const pilot = await w.call(w.tokens.pilot, "POST", route, { text: made.reply.text });
    assert.equal(pilot.status, 403);
    assert.equal(pilot.json.error, ACTS_ON_REPLIES);
    assert.equal(String(pilot.json.error).includes(APPROVER_MARK), false);
    assert.equal((await w.call(w.tokens.viewer, "POST", route, { text: made.reply.text })).status, 403);
    assert.equal((await view(w, made.reply.id)).state, "draft");
    assert.deepEqual(store(w).listWorkstationRequests({ limit: 10 }), []);
  } finally {
    await w.close();
  }
});

test("pont-corpo-reponses/AC-156 : l'approbation slack pose une demande dont la consigne porte l'url et le texte ; le job voit refusés une saisie autre, Control+v, Meta+v, Space et un upload, et acceptés la saisie exacte puis Entrée ; aucun appel Gmail ou Slack", async () => {
  const TEXT = "Bonjour, c'est corrigé, merci pour le signalement !";
  const scenario = {
    "poste-demande": [
      [
        ACT({ kind: "type", params: TYPE("Un texte qui n'est pas celui approuvé"), rationale: "saisir" }),
        ACT({ kind: "key", params: { tabId: 1, key: "Control+v" }, rationale: "coller" }),
        ACT({ kind: "key", params: { tabId: 1, key: "Meta+v" }, rationale: "coller" }),
        ACT({ kind: "key", params: { tabId: 1, key: "Space" }, rationale: "activer" }),
        ACT({ kind: "upload", params: { tabId: 1, ref: "e3", file: "piece.txt" }, rationale: "joindre" }),
        ACT({ kind: "type", params: TYPE(TEXT), rationale: "saisir le texte approuvé" }),
        ACT({ kind: "key", params: { tabId: 1, key: "Enter" }, rationale: "envoyer" }),
        REPORT("saisi"),
      ],
    ],
  };
  const w = await open(scenario);
  try {
    fs.mkdirSync(uploadDir(w.world.config), { recursive: true });
    fs.writeFileSync(path.join(uploadDir(w.world.config), "piece.txt"), "pièce");
    const made = drafted(w, { channel: "slack" });
    await approver(w, "PUT", `/v1/replies/${made.reply.id}`, { text: TEXT });
    await online(w);
    const got = await approver(w, "POST", `/v1/replies/${made.reply.id}/approve`, { text: TEXT });
    assert.equal(got.status, 201, JSON.stringify(got.json));
    const request = got.json.request as WorkstationRequest;
    assert.ok(request.instruction.includes(made.url) && request.instruction.includes(TEXT));
    assert.equal(store(w).listWorkstationRequests({ limit: 10 }).length, 1, "exactement une demande");
    assert.equal((await originOf(w, made.run.id))?.reply, "en attente d'approbation");

    // L'extension rend les deux seules actions créées : la saisie exacte, puis la touche Entrée.
    const typed = await lease(w);
    assert.deepEqual([typed.kind, typed.params.text], ["type", TEXT]);
    await give(w, typed.seq, FINISHED);
    const entered = await lease(w);
    assert.deepEqual([entered.kind, entered.params.key], ["key", "Enter"]);
    assert.equal(entered.state, "running", "slack : la touche Entrée part sans garde serveur");
    await give(w, entered.seq, HELD(TEXT));
    await until(w, () => !w.world.orchestrator.workstationAgent.isLive("poste-demande"), "le job finit");

    const actions = store(w).listWorkstationActions({ requestId: request.id, order: "asc", limit: 20 });
    assert.deepEqual(
      actions.map((action) => action.kind),
      ["type", "key"],
      "les gestes refusés ne sont pas créés",
    );
    const results = w.world
      .log()
      .filter((entry) => entry.kind === "tool" && entry.tool === "workstation_act")
      .map((entry) => String(entry.result));
    assert.equal(results.filter((result) => result.startsWith("action refusée")).length, 5);
    assert.match(results[0] as string, /saisie refusée/);
    assert.match(results[1] as string, /touche refusée/);
    assert.match(results[3] as string, /touche refusée/);
    assert.match(results[4] as string, /geste refusé dans une demande de réponse : upload/);
    assert.equal(
      w.fetched.some((address) => /gmail\.googleapis\.com|slack\.com/.test(address)),
      false,
      "aucun appel Gmail ou Slack",
    );
  } finally {
    await w.close();
  }
});

test("pont-corpo-reponses/AC-157 : brouillon chrome : la navigation retenue par allowedHosts n'envoie rien ; le clic d'envoi attend l'approbateur (garde serveur), puis l'envoi retenu par l'extension, puis envoyée ; un bouton non reconnu ramène au brouillon avec « vérifiez le fil »", async () => {
  const w = await open();
  try {
    ws(w).updateSettings({ allowedHosts: ["autre.example"] }, ACTOR);
    const first = await approved(w, { channel: "chrome" });
    const text = first.text;
    const id = first.reply.id;

    const nav = act(w, first.request.id, "navigate", { tabId: 1, url: first.url });
    assert.equal(nav.state, "awaiting_approval");
    allow(w, nav.seq);
    await give(w, (await lease(w)).seq, FINISHED);
    assert.equal((await view(w, id)).state, "pending", "la navigation approuvée n'envoie rien");

    const typed = act(w, first.request.id, "type", TYPE(text));
    await give(w, (await lease(w)).seq, FINISHED);
    assert.equal(typed.state, "queued");
    const click = act(w, first.request.id, "click", CLICK);
    assert.equal(click.state, "awaiting_approval", "le clic attend l'approbateur");
    assert.ok(String(click.approval?.summary).includes(REPLY_SEND_GUARD));
    assert.equal((await approver(w, "GET", "/v1/workstation/next?wait=0", undefined, TABS)).status, 204, "pas loué");
    allow(w, click.seq);
    const leased = await lease(w);
    assert.equal(leased.seq, click.seq);
    await give(w, click.seq, HELD(text));
    assert.equal(ws(w).getAction(click.seq).state, "awaiting_approval", "l'envoi retenu attend de nouveau");
    assert.equal(store(w).getReply(id)?.sendSeq, click.seq);
    assert.equal((await view(w, id)).state, "pending");
    allow(w, click.seq);
    await give(w, (await lease(w)).seq, FINISHED);
    assert.equal((await view(w, id)).state, "sent");
    assert.equal((await originOf(w, first.run.id))?.reply, "envoyée");
    await ended(w, first.request);

    // Un bouton que l'extension ne classe pas comme envoi : approuvé, rendu done, la demande finit done.
    const second = await approved(w, { channel: "chrome" });
    act(w, second.request.id, "type", TYPE(second.text));
    await give(w, (await lease(w)).seq, FINISHED);
    const save = act(w, second.request.id, "click", CLICK);
    assert.equal(save.state, "awaiting_approval");
    allow(w, save.seq);
    await give(w, (await lease(w)).seq, FINISHED);
    ws(w).finishRequest(second.request.id, { report: "cliqué" });
    await until(w, () => store(w).getReply(second.reply.id)?.state === "draft", "retour au brouillon");
    const back = await view(w, second.reply.id);
    assert.equal(back.error, REPLY_TYPED_UNCONFIRMED);
    assert.match(String(back.error), /vérifiez le fil/);
    assert.equal(back.text, second.text);
  } finally {
    await w.close();
  }
});

test("pont-corpo-reponses/AC-158 : l'état suit la demande et l'envoi : retour au brouillon (échec, annulation, refus, expiration, fin sans envoi), attente tant qu'une action est ouverte, un seul envoi vivant, « Répondre » n'est pas l'envoi", async () => {
  const w = await open();
  try {
    const again = async (id: string, text: string, expectedError: RegExp) => {
      const row = await view(w, id);
      assert.equal(row.state, "draft");
      assert.equal(row.text, text);
      assert.match(String(row.error), expectedError);
    };

    // Échec de la demande, puis annulation : retour au brouillon, texte gardé, réapprobation acceptée.
    const one = await approved(w, { channel: "slack" });
    ws(w).finishRequest(one.request.id, { reason: "échec" });
    await until(w, () => store(w).getReply(one.reply.id)?.state === "draft");
    await again(one.reply.id, one.text, /la demande du poste a échoué/);
    await until(w, () => !w.world.orchestrator.workstationAgent.isLive("poste-demande"));
    const retry = await approver(w, "POST", `/v1/replies/${one.reply.id}/approve`, { text: one.text });
    assert.equal(retry.status, 201, JSON.stringify(retry.json));
    const retryRequest = retry.json.request as WorkstationRequest;
    await until(w, () => ws(w).getRequest(retryRequest.id).state === "running");
    ws(w).cancelRequest(retryRequest.id, ACTOR);
    await until(w, () => store(w).getReply(one.reply.id)?.state === "draft");
    await again(one.reply.id, one.text, /annulée/);
    await until(w, () => !w.world.orchestrator.workstationAgent.isLive("poste-demande"));

    // Fin sans aucun envoi : « la demande s'est terminée sans envoi ».
    const two = await approved(w, { channel: "slack" });
    await ended(w, two.request);
    await again(two.reply.id, two.text, /terminée sans envoi/);

    // Envoi retenu refusé : retour au brouillon, la demande encore en cours est annulée.
    const three = await approved(w, { channel: "slack" });
    const sendA = act(w, three.request.id, "click", CLICK);
    await lease(w);
    await give(w, sendA.seq, HELD(three.text));
    assert.equal(store(w).getReply(three.reply.id)?.sendSeq, sendA.seq);
    // Un second envoi retenu pendant que le premier attend : clos, sans approbation ni marque.
    const sendB = act(w, three.request.id, "key", { tabId: 1, key: "Enter" });
    await lease(w);
    await give(w, sendB.seq, HELD(three.text));
    assert.equal(ws(w).getAction(sendB.seq).state, "failed");
    assert.equal(ws(w).getAction(sendB.seq).error, REPLY_SEND_TAKEN);
    assert.equal(store(w).getReply(three.reply.id)?.sendSeq, sendA.seq, "l'envoi marqué ne change pas");
    const approvals = store(w)
      .eventsOfType("workstation_approval")
      .map((event) => event.payload.seq);
    assert.deepEqual(approvals, [sendA.seq], "aucune approbation pour le second envoi");
    ws(w).refuse(sendA.seq, "non", { by: "app-approbateur", rev: ws(w).getAction(sendA.seq).updatedAt });
    await until(w, () => store(w).getReply(three.reply.id)?.state === "draft");
    await again(three.reply.id, three.text, /refusé/);
    assert.equal(ws(w).getRequest(three.request.id).state, "cancelled");
    await until(w, () => !w.world.orchestrator.workstationAgent.isLive("poste-demande"));

    // Envoi retenu expiré.
    const four = await approved(w, { channel: "slack" });
    const sendC = act(w, four.request.id, "click", CLICK);
    await lease(w);
    await give(w, sendC.seq, HELD(four.text));
    ws(w).maintain(Date.now() + 48 * 3_600_000);
    await until(w, () => store(w).getReply(four.reply.id)?.state === "draft");
    await again(four.reply.id, four.text, /expiré/);
    await until(w, () => !w.world.orchestrator.workstationAgent.isLive("poste-demande"));

    // La demande finit done alors que l'envoi retenu attend : l'état reste, puis envoyée.
    const five = await approved(w, { channel: "slack" });
    const sendD = act(w, five.request.id, "click", CLICK);
    await lease(w);
    await give(w, sendD.seq, HELD(five.text));
    ws(w).finishRequest(five.request.id, { report: "retenu" });
    reconcile(w);
    assert.equal((await view(w, five.reply.id)).state, "pending");
    allow(w, sendD.seq);
    await give(w, (await lease(w)).seq, FINISHED);
    assert.equal((await view(w, five.reply.id)).state, "sent");
    await until(w, () => !w.world.orchestrator.workstationAgent.isLive("poste-demande"));

    // La demande finit done alors que le clic d'envoi est chez l'extension : toujours en attente ;
    // le needs_approval tardif devient l'envoi retenu et une nouvelle approbation est refusée.
    const six = await approved(w, { channel: "slack" });
    const sendE = act(w, six.request.id, "click", CLICK);
    await lease(w);
    ws(w).finishRequest(six.request.id, { report: "clic en cours" });
    reconcile(w);
    assert.equal((await view(w, six.reply.id)).state, "pending");
    await give(w, sendE.seq, HELD(six.text));
    assert.equal(store(w).getReply(six.reply.id)?.sendSeq, sendE.seq);
    assert.equal((await view(w, six.reply.id)).state, "pending");
    assert.equal((await approver(w, "POST", `/v1/replies/${six.reply.id}/approve`, { text: six.text })).status, 409);
    ws(w).refuse(sendE.seq, "non", { by: "app-approbateur", rev: ws(w).getAction(sendE.seq).updatedAt });
    await until(w, () => store(w).getReply(six.reply.id)?.state === "draft");
    await until(w, () => !w.world.orchestrator.workstationAgent.isLive("poste-demande"));

    // gmail : « Répondre » ouvre le compositeur (aperçu sans le texte) : pas l'envoi ; puis le vrai envoi.
    const seven = await approved(w, { channel: "gmail" });
    const reply = act(w, seven.request.id, "click", CLICK);
    await lease(w);
    await give(w, reply.seq, HELD(""));
    assert.equal(ws(w).getAction(reply.seq).state, "awaiting_approval");
    assert.equal(store(w).getReply(seven.reply.id)?.sendSeq, null);
    allow(w, reply.seq);
    await give(w, (await lease(w)).seq, FINISHED);
    assert.equal((await view(w, seven.reply.id)).state, "pending");
    assert.equal(store(w).getReply(seven.reply.id)?.sendSeq, null);
    act(w, seven.request.id, "type", TYPE(seven.text));
    await give(w, (await lease(w)).seq, FINISHED);
    const send = act(w, seven.request.id, "click", CLICK);
    await lease(w);
    await give(w, send.seq, HELD(seven.text.replace(/\n/g, "\n\n")));
    assert.equal(store(w).getReply(seven.reply.id)?.sendSeq, send.seq, "les retours à la ligne ne comptent pas");
    allow(w, send.seq);
    await give(w, (await lease(w)).seq, FINISHED);
    assert.equal((await view(w, seven.reply.id)).state, "sent");
  } finally {
    await w.close();
  }
});

test("pont-corpo-reponses/AC-159 : un brouillon manual est à copier : approbation refusée en 409, aucune demande ni action du poste", async () => {
  const w = await open();
  try {
    const made = drafted(w, { channel: "manual" });
    assert.equal(made.reply.state, "draft");
    await online(w);
    const got = await approver(w, "POST", `/v1/replies/${made.reply.id}/approve`, { text: made.reply.text });
    assert.equal(got.status, 409);
    assert.match(String(got.json.error), /manual/);
    noWorkstationTrace(w);
    assert.equal((await view(w, made.reply.id)).state, "draft");
    // Il se modifie comme les autres.
    assert.equal((await approver(w, "PUT", `/v1/replies/${made.reply.id}`, { text: "Version à copier." })).status, 200);
  } finally {
    await w.close();
  }
});

// -- AC-160 à AC-163 : l'état de l'origine, la propriété, les événements ------------------------------------------

test("pont-corpo-reponses/AC-160 : origin.reply vaut aucune, brouillon, en attente d'approbation puis envoyée ; un run sans origine rend origin: null", async () => {
  const w = await open();
  try {
    const bare = link(w, { channel: "slack" });
    assert.equal((await originOf(w, bare.run.id))?.reply, "aucune", "aucun brouillon avant le tour");
    reconcile(w);
    assert.equal((await originOf(w, bare.run.id))?.reply, "brouillon");
    await online(w);
    const got = await approver(w, "POST", `/v1/replies/${replies(w, bare.run.id)[0]?.id}/approve`, {
      text: replies(w, bare.run.id)[0]?.text,
    });
    assert.equal(got.status, 201, JSON.stringify(got.json));
    const request = got.json.request as WorkstationRequest;
    assert.equal((await originOf(w, bare.run.id))?.reply, "en attente d'approbation");
    await until(w, () => ws(w).getRequest(request.id).state === "running");
    const click = act(w, request.id, "click", CLICK);
    await lease(w);
    await give(w, click.seq, HELD(replies(w, bare.run.id)[0]?.text as string));
    allow(w, click.seq);
    await give(w, (await lease(w)).seq, FINISHED);
    assert.equal((await originOf(w, bare.run.id))?.reply, "envoyée");
    const origin = await originOf(w, bare.run.id);
    assert.deepEqual(Object.keys(origin as object).sort(), [
      "channel",
      "confirmedAt",
      "confirmedBy",
      "excerpt",
      "issue",
      "personRef",
      "reply",
      "signalId",
      "threadRef",
      "url",
    ]);

    const orphan = store(w).createRun({
      id: newId("r"),
      repo: "demo",
      slug: "sans-origine",
      title: "Sans origine",
      request: "x",
      branch: "harness/sans-origine",
      state: "merged",
    });
    assert.deepEqual((await approver(w, "GET", `/v1/runs/${orphan.id}/origin`)).json, { origin: null });
  } finally {
    await w.close();
  }
});

test("pont-corpo-reponses/AC-161 : un client restreint et un client pilote sont refusés sur les brouillons, sans événement de brouillon pour le restreint ; le pilote ne lit ni la demande de réponse ni ses actions ni la prochaine action", async () => {
  const w = await open();
  try {
    const made = await approved(w, { channel: "gmail" });
    const id = made.reply.id;
    const typed = act(w, made.request.id, "type", TYPE(made.text));
    const leased = await lease(w);
    await give(w, leased.seq, { ...FINISHED, image: "AAAA" });
    assert.equal(typed.seq, leased.seq);

    for (const [method, route, body] of [
      ["GET", "/v1/replies", undefined],
      ["GET", `/v1/replies/${id}`, undefined],
      ["PUT", `/v1/replies/${id}`, { text: "autre" }],
      ["POST", `/v1/replies/${id}/approve`, { text: made.text }],
      ["POST", `/v1/replies/${id}/archive`, undefined],
    ] as const) {
      const narrow = await w.call(w.tokens.narrow, method, route, body);
      assert.deepEqual([narrow.status, narrow.json.error], [403, OWNER_ONLY], `${method} ${route} restreint`);
      const pilot = await w.call(w.tokens.pilot, method, route, body);
      assert.equal(pilot.status, 403, `${method} ${route} pilote`);
      assert.equal(pilot.json.error, method === "GET" ? READS_REPLIES : ACTS_ON_REPLIES);
    }
    assert.equal((await w.call(w.tokens.narrow, "GET", `/v1/runs/${made.run.id}/origin`)).json.error, OWNER_ONLY);
    assert.deepEqual(
      store(w)
        .eventsSince(0, null, 1000, ["demo"])
        .filter((event) => event.type === "reply"),
      [],
      "le client restreint ne reçoit aucun événement de brouillon",
    );
    assert.ok(replyEvents(w).length > 0);

    // Le client pilote : la demande de réponse et ses actions ne se lisent pas.
    const requests = await w.call(w.tokens.pilot, "GET", "/v1/workstation/requests");
    const actions = await w.call(w.tokens.pilot, "GET", "/v1/workstation/actions");
    assert.equal(requests.status, 200);
    assert.equal(actions.status, 200);
    const escaped = JSON.stringify(made.text).slice(1, -1);
    for (const listing of [requests, actions]) {
      const text = JSON.stringify(listing.json);
      assert.equal(text.includes(made.request.id) || text.includes(escaped) || text.includes(made.url), false);
    }
    assert.equal(
      (actions.json.actions as WorkstationAction[]).some((action) => action.seq === typed.seq),
      false,
    );
    for (const route of [
      `/v1/workstation/requests/${made.request.id}`,
      `/v1/workstation/actions/${typed.seq}`,
      `/v1/workstation/actions/${typed.seq}/capture`,
      "/v1/workstation/next?wait=0",
    ])
      assert.equal((await w.call(w.tokens.pilot, "GET", route)).status, 403, route);
    // L'approbateur lit toujours la demande et ses actions.
    const own = await approver(w, "GET", `/v1/workstation/requests/${made.request.id}`);
    assert.equal(own.status, 200);
    assert.ok((own.json.request as WorkstationRequest).instruction.includes(made.text));
    const seen = await approver(w, "GET", "/v1/workstation/actions");
    assert.ok((seen.json.actions as WorkstationAction[]).some((action) => action.seq === typed.seq));
    assert.equal((await approver(w, "GET", `/v1/workstation/actions/${typed.seq}/capture`)).status, 200);
  } finally {
    await w.close();
  }
});

test("pont-corpo-reponses/AC-162 : chaque changement d'état émet un événement reply {id, state} sans repo ni run ; le type, la capacité et les routes sont déclarés, au README", async () => {
  const w = await open();
  try {
    const made = await approved(w, { channel: "slack" });
    ws(w).finishRequest(made.request.id, { reason: "échec" });
    await until(w, () => store(w).getReply(made.reply.id)?.state === "draft");
    await until(w, () => !w.world.orchestrator.workstationAgent.isLive("poste-demande"));
    assert.equal((await approver(w, "POST", `/v1/replies/${made.reply.id}/archive`)).status, 200);
    const events = replyEvents(w).filter((event) => event.payload.id === made.reply.id);
    assert.deepEqual(
      events.map((event) => event.payload),
      ["draft", "pending", "draft", "archived"].map((state) => ({ id: made.reply.id, state })),
    );
    for (const event of events) assert.deepEqual([event.repo, event.runId], [null, null]);

    assert.ok((EVENT_TYPES as readonly string[]).includes("reply"));
    assert.ok((API_FEATURES as readonly string[]).includes("corporate-replies"));
    const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
    for (const [method, sample] of [
      ["GET", "/v1/replies"],
      ["GET", "/v1/replies/rp1"],
      ["PUT", "/v1/replies/rp1"],
      ["POST", "/v1/replies/rp1/approve"],
      ["POST", "/v1/replies/rp1/archive"],
    ] as const)
      assert.ok(
        routes.some((route) => route.method === method && route.pattern.test(sample)),
        `${method} ${sample} absente d'apiRoutes()`,
      );
    const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
    const documented = [
      "GET /v1/replies",
      "PUT /v1/replies/{id}",
      "POST /v1/replies/{id}/approve",
      "POST /v1/replies/{id}/archive",
    ];
    for (const route of documented) assert.ok(readme.includes(`\`${route}`), `${route} manque au README`);
    assert.match(readme, /`GET \/v1\/events\?[^\n]*`reply` \(/);
  } finally {
    await w.close();
  }
});

test("pont-corpo-reponses/AC-163 : poste désactivé, le propriétaire lit la liste et l'origine ; l'approbation d'un brouillon slack est refusée sans demande", async () => {
  const w = await open(IDLE, (config) => {
    config.workstation.enabled = false;
  });
  try {
    const made = link(w, { channel: "slack" });
    await until(w, () => replies(w, made.run.id).length === 1, "le brouillon, poste désactivé");
    assert.equal((await listed(w)).length, 1);
    assert.equal((await originOf(w, made.run.id))?.reply, "brouillon");
    const reply = replies(w, made.run.id)[0] as ReplyRow;
    const got = await approver(w, "POST", `/v1/replies/${reply.id}/approve`, { text: reply.text });
    assert.equal(got.status, 409);
    assert.match(String(got.json.error), /workstation\.enabled/);
    assert.deepEqual(store(w).listWorkstationRequests({ limit: 10 }), []);
    assert.equal((await view(w, reply.id)).state, "draft");
  } finally {
    await w.close();
  }
});

// -- AC-164 : la confidentialité ---------------------------------------------------------------------------------

test("pont-corpo-reponses/AC-164 : ni le texte du brouillon, ni le fil, ni l'url, ni la personne ne sortent par les journaux, les événements (écrits ou éphémères), le direct ou le prompt du service", async () => {
  const MARKER_A = "Le marqueur fictif Zorglub traverse ce texte.";
  const MARKER_B = "Il tient en deux phrases distinctes.";
  const MARKER = `${MARKER_A} ${MARKER_B}`;
  const TEXT = `${finalText(SUBJECT, PR)}\n\n${MARKER}`;
  const FAILING = "Texte du second brouillon : Octavie répond au tableau Mercure.";
  const link164 = { channel: "slack" } as const;
  // Le scénario est statique : l'url du fil est celle du prochain signal lié (`counter` + 1).
  const futureUrl = URLS.slack(counter + 1);
  const scenario = {
    "poste-demande": [
      [
        { tool: "progress", args: { message: TEXT } },
        { frame: { type: "tool_execution_start", toolName: "workstation_act", intent: futureUrl } },
        ACT({ kind: "navigate", params: { tabId: 1, url: futureUrl }, rationale: `ouvrir ${futureUrl}` }),
        ACT({ kind: "type", params: TYPE(`${TEXT} (autre)`), rationale: `saisir sur ${futureUrl}` }),
        ACT({ kind: "type", params: TYPE(TEXT), rationale: `saisir sur ${futureUrl}` }),
        ACT({ kind: "click", params: CLICK, rationale: `envoyer sur ${futureUrl}` }),
        REPORT(`Réponse saisie dans ${futureUrl} : ${TEXT}`),
      ],
      [{ error: { message: FAILING, httpStatus: 400 } }],
    ],
  };
  const w = await open(scenario);
  try {
    ws(w).updateSettings({ allowedHosts: ["autre.example"] }, ACTOR);
    // Un `attente` après un échec, la relance, puis le `final` que l'approbateur complète.
    const failed = link(w, { ...link164, state: "failed" });
    assert.equal(failed.url, futureUrl, "l'url du fil est celle que le scénario cite");
    reconcile(w);
    const relaunched = link(w, { ...link164, signal: failed.signal, state: "merged" });
    reconcile(w);
    const final = replies(w, relaunched.run.id)[0] as ReplyRow;
    assert.equal(final.text, finalText(SUBJECT, PR));
    assert.equal((await approver(w, "PUT", `/v1/replies/${final.id}`, { text: TEXT })).status, 200);
    await online(w);
    const got = await approver(w, "POST", `/v1/replies/${final.id}/approve`, { text: TEXT });
    assert.equal(got.status, 201, JSON.stringify(got.json));
    const request = got.json.request as WorkstationRequest;

    // L'extension : la navigation retenue par allowedHosts est approuvée, la saisie exacte, puis l'envoi retenu.
    await until(
      w,
      () =>
        store(w)
          .listWorkstationActions({ requestId: request.id })
          .some((action) => action.kind === "navigate"),
      "la navigation est déposée",
    );
    const nav = store(w)
      .listWorkstationActions({ requestId: request.id })
      .find((action) => action.kind === "navigate");
    assert.equal(nav?.state, "awaiting_approval");
    allow(w, nav?.seq as number);
    await give(w, (await lease(w)).seq, FINISHED);
    await give(w, (await lease(w)).seq, FINISHED);
    const click = await lease(w);
    assert.equal(click.kind, "click");
    await give(w, click.seq, HELD(TEXT));
    await until(w, () => ws(w).getRequest(request.id).state === "done", "la demande finit");
    allow(w, click.seq);
    await give(w, (await lease(w)).seq, FINISHED);
    assert.equal((await view(w, final.id)).state, "sent");
    await until(w, () => !w.world.orchestrator.workstationAgent.isLive("poste-demande"));

    // Une seconde demande de réponse dont le runner échoue avec le texte pour raison.
    const other = drafted(w, { channel: "slack" });
    await approver(w, "PUT", `/v1/replies/${other.reply.id}`, { text: FAILING });
    const second = await approver(w, "POST", `/v1/replies/${other.reply.id}/approve`, { text: FAILING });
    assert.equal(second.status, 201, JSON.stringify(second.json));
    const secondRequest = second.json.request as WorkstationRequest;
    await until(w, () => ws(w).getRequest(secondRequest.id).state === "failed", "le runner échoue");
    assert.equal(ws(w).getRequest(secondRequest.id).reason?.includes("Octavie"), false);
    await until(w, () => store(w).getReply(other.reply.id)?.state === "draft");

    // Un passage du service 24/24 : son prompt lit les actions récentes, masquées.
    ws(w).updateSettings({ autonomy: "act" }, ACTOR);
    await until(
      w,
      () => w.world.log().some((entry) => entry.kind === "prompt" && entry.step === "poste-service"),
      "le service part",
    );

    const served = w.world.log().find((entry) => entry.kind === "prompt" && entry.step === "poste-service");
    const prompt = String(served?.message);
    assert.match(prompt, /réponse à un collègue \(détail masqué\)/);
    const forbidden = [
      TEXT,
      JSON.stringify(TEXT).slice(1, -1),
      MARKER,
      MARKER_A,
      MARKER_B,
      FAILING,
      failed.threadRef,
      failed.url,
      COLLEAGUE,
    ];
    const places: Record<string, string> = {
      "journal du service": w.log.join("\n"),
      "journal des événements": JSON.stringify(store(w).eventsSince(0, null, 100_000)),
      "événements publiés": JSON.stringify(w.published),
      "prompt du service": prompt,
    };
    for (const [place, text] of Object.entries(places))
      assert.deepEqual(
        forbidden.filter((needle) => text.includes(needle)),
        [],
        `${place} ne porte rien du brouillon, du fil ni de la personne`,
      );
    for (const event of store(w).eventsOfType("workstation_approval")) {
      assert.deepEqual([event.payload.summary, event.payload.recipients], [REPLY_APPROVAL_SUMMARY, []]);
    }
    assert.ok(store(w).eventsOfType("workstation_approval").length >= 2, "la navigation et l'envoi");
    assert.deepEqual(
      w.published.filter((event) => event.type === "activity").map((event) => event.payload.intent),
      w.published.filter((event) => event.type === "activity").map(() => null),
    );
    assert.deepEqual(w.world.orchestrator.sessions.page(workstationOwner("poste-demande")).entries, []);
    const actions = await approver(w, "GET", "/v1/workstation/actions");
    assert.ok(
      (actions.json.actions as WorkstationAction[]).some((action) =>
        String(action.approval?.preview).includes(MARKER_A),
      ),
      "l'aperçu de l'envoi reste lisible par le propriétaire",
    );
  } finally {
    await w.close();
  }
});

// -- AC-165, AC-166 : classer, parcours complet ---------------------------------------------------------------------

test("pont-corpo-reponses/AC-165 : classer est réservé à l'approbateur ; un brouillon classé disparaît de la liste, reply vaut aucune, il ne se modifie ni ne se réapprouve ni ne se reclasse, et un redémarrage n'en recrée pas ; un brouillon en attente ne se classe pas", async () => {
  const w = await open();
  let second: Orchestrator | null = null;
  try {
    const made = drafted(w, { channel: "manual" });
    const route = `/v1/replies/${made.reply.id}/archive`;
    const operator = await w.call(w.tokens.operator, "POST", route);
    assert.equal(operator.status, 403);
    assert.ok(String(operator.json.error).includes(APPROVER_MARK));
    assert.equal((await w.call(w.tokens.pilot, "POST", route)).status, 403);
    const narrow = await w.call(w.tokens.narrow, "POST", route);
    assert.deepEqual([narrow.status, narrow.json.error], [403, OWNER_ONLY]);
    assert.equal((await listed(w)).length, 1, "le brouillon reste listé");

    const archived = await approver(w, "POST", route);
    assert.equal(archived.status, 200, JSON.stringify(archived.json));
    assert.equal((archived.json.reply as ReplyRow).state, "archived");
    assert.deepEqual(await listed(w), []);
    assert.equal((await originOf(w, made.run.id))?.reply, "aucune");
    assert.deepEqual(
      replyEvents(w)
        .slice(-1)
        .map((event) => event.payload),
      [{ id: made.reply.id, state: "archived" }],
    );
    noWorkstationTrace(w);
    const approval = await approver(w, "POST", `/v1/replies/${made.reply.id}/approve`, { text: made.reply.text });
    assert.equal(approval.status, 409);
    assert.equal((await approver(w, "PUT", `/v1/replies/${made.reply.id}`, { text: "autre" })).status, 409);
    assert.equal((await approver(w, "POST", route)).status, 409);
    assert.equal(replies(w, made.run.id)[0]?.text, made.reply.text);

    reconcile(w);
    second = new Orchestrator(w.world.deps);
    second.corporateReplies.reconcile();
    assert.equal(replies(w, made.run.id).length, 1, "aucun nouveau brouillon pour ce run");

    const pending = drafted(w, { channel: "slack" });
    const asked = await approver(w, "POST", `/v1/replies/${pending.reply.id}/approve`, { text: pending.reply.text });
    assert.equal(asked.status, 201);
    const refused = await approver(w, "POST", `/v1/replies/${pending.reply.id}/archive`);
    assert.equal(refused.status, 409);
    assert.equal((await view(w, pending.reply.id)).state, "pending");
  } finally {
    await second?.stop();
    await w.close();
  }
});

test("pont-corpo-reponses/AC-166 : gmail failed puis relance merged : la liste par défaut ne garde que le final, vide après approbation, et reply vaut envoyée une fois l'envoi retenu approuvé", async () => {
  const w = await open();
  try {
    const failed = link(w, { channel: "gmail", state: "failed" });
    reconcile(w);
    const relaunched = link(w, { signal: failed.signal, channel: "gmail", state: "merged" });
    reconcile(w);
    const final = replies(w, relaunched.run.id)[0] as ReplyRow;
    assert.deepEqual(
      (await listed(w)).map((entry) => entry.id),
      [final.id],
      "seul le final reste listé",
    );
    await online(w);
    const got = await approver(w, "POST", `/v1/replies/${final.id}/approve`, { text: final.text });
    assert.equal(got.status, 201, JSON.stringify(got.json));
    assert.deepEqual(await listed(w), []);
    assert.deepEqual(
      (await listed(w, "pending")).map((entry) => entry.id),
      [final.id],
    );
    const request = got.json.request as WorkstationRequest;
    await until(w, () => ws(w).getRequest(request.id).state === "running");
    act(w, request.id, "type", TYPE(final.text));
    await give(w, (await lease(w)).seq, FINISHED);
    const send = act(w, request.id, "click", CLICK);
    await lease(w);
    await give(w, send.seq, HELD(final.text));
    allow(w, send.seq);
    await give(w, (await lease(w)).seq, FINISHED);
    assert.deepEqual(await listed(w), []);
    assert.equal((await originOf(w, relaunched.run.id))?.reply, "envoyée");
    assert.deepEqual(
      (await listed(w, "sent")).map((entry) => entry.id),
      [final.id],
    );
  } finally {
    await w.close();
  }
});
