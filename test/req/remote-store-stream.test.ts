// Le magasin filaire et le flux SSE du protocole distant du VPS (S-3 ; AC-12) :
// la forme de l'instantané `StoreSnapshot` d'un magasin minimal, l'ordre des trames
// d'ouverture de `GET /v1/stream`, le battement de cœur, la rediffusion des changements,
// la file de 64 trames et la fermeture des flux d'un appareil révoqué.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GestureJournal } from "../../omp-mem0-req/remoteJournal.ts";
import { DeviceRegistry, devicesFilePath } from "../../omp-mem0-req/remoteDevices.ts";
import { StoreSource, componentsPayload, readStoreSnapshot } from "../../omp-mem0-req/remoteStore.ts";
import { StreamHub } from "../../omp-mem0-req/remoteStream.ts";
import type { Feed } from "../../omp-mem0-req/remoteContext.ts";

const NOW = 1_700_000_000_000;
const RUN_ID = "a1b2c3d4e5f60718";
const LOT_ID = "d0ef9a50f7dc3a37";

function mktmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "remote-store-stream-"));
}

function put(stateDir: string, relative: string, value: unknown): void {
  const file = path.join(stateDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

/** Un magasin minimal : un run, une entrée d'historique, un lot, un fichier illisible et un fichier au schéma incomplet. */
function minimalStore(stateDir: string): void {
  put(stateDir, `running/${RUN_ID}.json`, {
    version: 1,
    id: RUN_ID,
    cwd: "/work/repo",
    label: "repo",
    phase: "impl",
    state: "running",
    phaseStartedAt: NOW - 5_000,
    updatedAt: NOW - 1_000,
    sessionFile: "/work/repo/session.jsonl",
    owner: { pid: 4242 },
    inbox: "",
  });
  put(stateDir, `history/${RUN_ID}.json`, {
    version: 1,
    id: RUN_ID,
    cwd: "/work/repo",
    label: "repo",
    phase: "review",
    finalState: "done",
    phaseStartedAt: NOW - 9_000,
    endedAt: NOW - 8_000,
  });
  put(stateDir, `lots/${LOT_ID}.json`, {
    version: 1,
    id: LOT_ID,
    repoRoot: "/work/repo",
    status: "running",
    reviewCap: 2,
    owner: { pid: 4242, heartbeatAt: NOW - 1_000 },
    createdAt: NOW - 20_000,
    features: [
      {
        slug: "alpha",
        name: "Alpha",
        branch: "feat/alpha",
        worktree: "/work/wt/alpha",
        origin: "panneau",
        state: "waiting",
        phase: "specs",
        waitKind: "specs",
        quota: { reason: "x" },
        escalation: { key: "k", kind: "jalon", phase: "specs", question: "q", options: ["a"], reason: "r", at: NOW },
      },
    ],
  });
  put(stateDir, "lots/ffffffffffffffff.json", "pas du json");
  put(stateDir, "lots/eeeeeeeeeeeeeeee.json", { version: 1, id: "x" });
}

const alive = (pid: number): boolean => pid === 4242;

test("remote-store-stream : l'instantané d'un magasin minimal a la forme filaire du StoreSnapshot Swift", () => {
  const stateDir = mktmp();
  minimalStore(stateDir);
  const snapshot = readStoreSnapshot({ stateDir, now: () => NOW, pidAlive: alive });

  assert.equal(snapshot.root, "present");
  // running : ownerPid aplati, isStale calculé, optionnels nil OMIS (pas de sessionId, `inbox` vide omis).
  assert.deepEqual(snapshot.running, {
    availability: "present",
    entries: [
      {
        id: RUN_ID,
        cwd: "/work/repo",
        label: "repo",
        phase: "impl",
        state: "running",
        phaseStartedAt: NOW - 5_000,
        updatedAt: NOW - 1_000,
        sessionFile: "/work/repo/session.jsonl",
        ownerPid: 4242,
        isStale: false,
      },
    ],
    discardedEntries: [],
  });
  assert.equal(snapshot.history.entries[0]?.finalState, "done");
  assert.equal("sessionFile" in (snapshot.history.entries[0] ?? {}), false);

  // lots : un illisible et un schéma incomplet sont NOMMÉS, triés par nom de fichier.
  assert.deepEqual(snapshot.lots.discardedEntries, [
    { file: "lots/eeeeeeeeeeeeeeee.json", reason: "schema" },
    { file: "lots/ffffffffffffffff.json", reason: "unparsable" },
  ]);
  const [lot] = snapshot.lots.lots;
  assert.ok(lot);
  assert.equal(lot.isStale, false);
  assert.equal(lot.slotCap, 4);
  assert.deepEqual(lot.owner, { pid: 4242, heartbeatAt: NOW - 1_000 });
  assert.equal("recapAt" in lot, false);
  const [feature] = lot.features;
  assert.ok(feature);
  assert.equal(feature.waitKind, "specs");
  assert.equal(feature.quotaBlocked, true);
  assert.equal(feature.fixes, 0);
  assert.deepEqual(feature.pendingTexts, []);
  assert.equal(feature.escalation?.kind, "jalon");
  assert.equal("endedAt" in feature, false);

  // Magasin absent ≠ magasin vide ; les enveloppes non écrites sont `absent`.
  assert.equal(snapshot.projects.availability, "absent");
  assert.equal(snapshot.audits.availability, "absent");
  assert.deepEqual(snapshot.audits.feed, []);
  assert.equal(readStoreSnapshot({ stateDir: path.join(stateDir, "nope"), now: () => NOW, pidAlive: alive }).root, "absent");

  // Péremption : pid mort (ESRCH), ou updatedAt plus vieux que LOT_OWNER_STALE_MS.
  const dead = readStoreSnapshot({ stateDir, now: () => NOW, pidAlive: () => false });
  assert.equal(dead.running.entries[0]?.isStale, true);
  assert.equal(dead.lots.lots[0]?.isStale, true);
  const late = readStoreSnapshot({ stateDir, now: () => NOW + 60_000, pidAlive: alive });
  assert.equal(late.running.entries[0]?.isStale, true);
});

test("remote-store-stream : les composants du VPS portent le binaire omp du PATH et le dossier personnel", () => {
  const bin = mktmp();
  fs.writeFileSync(path.join(bin, "omp"), "#!/bin/sh\n", { mode: 0o755 });
  const payload = componentsPayload({ PATH: bin, HOME: "/home/omp" });
  assert.deepEqual(payload, { ompInstalled: true, ompPath: path.join(bin, "omp"), homeDirectory: "/home/omp" });
  assert.equal("setupBanner" in payload, false);
});

type Frame = { event: string; data: unknown } | { ping: true };

/** Lit les trames d'un flux SSE à mesure qu'elles arrivent. */
function frameReader(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  const next = async (): Promise<Frame | null> => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block === ": ping") return { ping: true };
        const event = /^event: (.*)$/mu.exec(block)?.[1];
        const data = /^data: (.*)$/mu.exec(block)?.[1];
        assert.ok(event !== undefined && data !== undefined, `trame mal formée : ${block}`);
        return { event, data: JSON.parse(data) as unknown };
      }
      if (done) return null;
      const chunk = await reader.read();
      if (chunk.done) done = true;
      else buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return { next, cancel: () => reader.cancel() };
}

function feed(initial: unknown): Feed<unknown> & { set: (value: unknown) => void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    payload: () => value,
    onChange: listener => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set: next => {
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function streamStack(heartbeatMs = 15_000) {
  const stateDir = mktmp();
  minimalStore(stateDir);
  const devices = new DeviceRegistry({ file: devicesFilePath(stateDir), now: () => NOW });
  devices.load();
  const store = new StoreSource({ stateDir, now: () => NOW, pidAlive: alive, pollMs: 60_000 });
  const journal = new GestureJournal({ now: () => NOW });
  const conduite = feed({ state: "idle" });
  const pullRequestStates = feed({ facts: [], refreshing: false });
  const hub = new StreamHub({
    machine: { kind: "vps", name: "vps-test" },
    devices,
    store,
    journal,
    now: () => NOW,
    env: { PATH: "", HOME: "/home/omp" },
    pullRequestStates,
    conduite,
    heartbeatMs,
  });
  const pairDevice = (name: string): string => {
    const { code } = devices.generateCode();
    return devices.pair(code, name, undefined).device.id;
  };
  const close = () => {
    hub.closeAll();
    store.close();
  };
  return { stateDir, devices, store, journal, conduite, pullRequestStates, hub, pairDevice, close };
}

test("remote-store-stream : le flux s'ouvre par hello, store, conduite, devices, components, journal, pull-request-states", async () => {
  const stack = streamStack();
  try {
    const deviceId = stack.pairDevice("iPhone");
    const reader = frameReader(stack.hub.subscribe(deviceId));
    const frames: Frame[] = [];
    for (let i = 0; i < 7; i += 1) {
      const frame = await reader.next();
      assert.ok(frame !== null);
      frames.push(frame);
    }
    assert.deepEqual(
      frames.map(frame => ("event" in frame ? frame.event : "ping")),
      ["hello", "store", "conduite", "devices", "components", "journal", "pull-request-states"],
    );
    const [hello, store, conduite, devices, components, journal, pullRequests] = frames as Array<{ data: unknown }>;
    assert.deepEqual(hello?.data, { protocolVersion: 3, machine: { kind: "vps", name: "vps-test" } });
    // La trame `store` porte l'instantané NU (la route, elle, l'enveloppe dans `snapshot`).
    assert.deepEqual(store?.data, JSON.parse(JSON.stringify(stack.store.snapshot())));
    assert.deepEqual(conduite?.data, { state: "idle" });
    const rows = (devices?.data as { devices: Array<{ id: string; connected: boolean }> }).devices;
    assert.deepEqual(rows.map(row => [row.id, row.connected]), [[deviceId, true]]);
    assert.deepEqual(components?.data, { ompInstalled: true, homeDirectory: "/home/omp" });
    assert.deepEqual(journal?.data, { entries: [] });
    assert.deepEqual(pullRequests?.data, { facts: [], refreshing: false });
    await reader.cancel();
  } finally {
    stack.close();
  }
});

test("remote-store-stream : le battement de cœur `: ping` part à intervalle régulier", async () => {
  const stack = streamStack(15);
  try {
    const reader = frameReader(stack.hub.subscribe(stack.pairDevice("iPad")));
    for (let i = 0; i < 7; i += 1) await reader.next();
    assert.deepEqual(await reader.next(), { ping: true });
    assert.deepEqual(await reader.next(), { ping: true });
    await reader.cancel();
  } finally {
    stack.close();
  }
});

test("remote-store-stream : chaque changement rediffuse la charge COMPLÈTE de sa source", async () => {
  const stack = streamStack();
  try {
    const reader = frameReader(stack.hub.subscribe(stack.pairDevice("iPhone")));
    for (let i = 0; i < 7; i += 1) await reader.next();

    stack.journal.record({ id: "c1", kindLabel: "réponse", targetLabel: "alpha", state: { kind: "awaitingAck" } });
    stack.journal.settle("c1", { kind: "refused", reason: "non" });
    stack.conduite.set({ state: "running" });
    stack.pullRequestStates.set({ facts: [1], refreshing: true });
    put(stack.stateDir, `history/${LOT_ID}.json`, {
      version: 1,
      id: LOT_ID,
      cwd: "/work/other",
      label: "other",
      phase: "req",
      finalState: "failed",
      phaseStartedAt: 1,
      endedAt: 2,
    });
    const events: Array<{ event: string; data: unknown }> = [];
    while (events.length < 5) {
      const frame = await reader.next();
      assert.ok(frame !== null && "event" in frame);
      events.push(frame);
    }
    assert.deepEqual(
      events.map(frame => frame.event),
      ["journal", "journal", "conduite", "pull-request-states", "store"],
    );
    assert.deepEqual(events[0]?.data, {
      entries: [{ at: NOW, id: "c1", kindLabel: "réponse", state: { awaitingAck: {} }, targetLabel: "alpha" }],
    });
    assert.deepEqual((events[1]?.data as { entries: Array<{ state: unknown }> }).entries[0]?.state, {
      refused: { reason: "non" },
    });
    assert.deepEqual(events[2]?.data, { state: "running" });
    const store = events[4]?.data as { history: { entries: Array<{ id: string }> } };
    assert.equal(store.history.entries.length, 2);
    await reader.cancel();
  } finally {
    stack.close();
  }
});

test("remote-store-stream : la révocation ferme TOUS les flux de l'appareil, pas ceux des autres", async () => {
  const stack = streamStack();
  try {
    const revoked = stack.pairDevice("perdu");
    const kept = stack.pairDevice("garde");
    const first = frameReader(stack.hub.subscribe(revoked));
    const second = frameReader(stack.hub.subscribe(revoked));
    const other = frameReader(stack.hub.subscribe(kept));
    for (const reader of [first, second, other]) for (let i = 0; i < 7; i += 1) await reader.next();
    assert.deepEqual([...stack.hub.connectedDeviceIds()].sort(), [kept, revoked].sort());

    assert.equal(stack.devices.revoke(revoked), true);
    for (;;) {
      const frame = await first.next();
      if (frame === null) break;
    }
    for (;;) {
      const frame = await second.next();
      if (frame === null) break;
    }
    assert.deepEqual([...stack.hub.connectedDeviceIds()], [kept]);
    stack.journal.record({ id: "c2", kindLabel: "texte", targetLabel: "beta", state: { kind: "taken" } });
    let seen = "";
    for (;;) {
      const frame = await other.next();
      assert.ok(frame !== null && "event" in frame);
      if (frame.event === "journal") {
        seen = frame.event;
        break;
      }
    }
    assert.equal(seen, "journal");
    await other.cancel();
  } finally {
    stack.close();
  }
});

test("remote-store-stream : un client qui ne lit pas n'a jamais plus de 64 trames en attente", async () => {
  const stack = streamStack();
  try {
    const response = stack.hub.subscribe(stack.pairDevice("lent"));
    for (let i = 0; i < 200; i += 1) {
      stack.journal.record({ id: `g${i}`, kindLabel: "texte", targetLabel: "alpha", state: { kind: "taken" } });
    }
    const reader = frameReader(response);
    let frames = 0;
    // Les 64 trames en file se lisent ; les suivantes ont été abandonnées pour ce client.
    for (;;) {
      const frame = await Promise.race([reader.next(), new Promise<"idle">(resolve => setTimeout(() => resolve("idle"), 100))]);
      if (frame === "idle" || frame === null) break;
      frames += 1;
    }
    assert.equal(frames, 64);
    await reader.cancel();
  } finally {
    stack.close();
  }
});

test("remote-store-stream : le fichier de session d'un run vivant pousse ses ajouts en trames `sessions`", async () => {
  const stack = streamStack();
  try {
    const file = path.join(stack.stateDir, "session.jsonl");
    const header = '{"type":"session","id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/work/repo","version":3}\n';
    const user = (id: string, text: string): string =>
      `${JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
    fs.writeFileSync(file, header + user("e1", "salut"));
    put(stack.stateDir, `running/${RUN_ID}.json`, {
      version: 1,
      id: RUN_ID,
      cwd: "/work/repo",
      label: "repo",
      phase: "impl",
      state: "running",
      phaseStartedAt: NOW - 5_000,
      updatedAt: NOW - 1_000,
      sessionFile: file,
      owner: { pid: 4242 },
    });
    stack.store.refresh();
    assert.deepEqual(stack.store.liveSessionFiles(), [file]);
    const reader = frameReader(stack.hub.subscribe(stack.pairDevice("iPhone")));
    for (let i = 0; i < 7; i += 1) await reader.next();
    fs.appendFileSync(file, user("e2", "encore"));
    let frame: Frame | null;
    do {
      frame = await reader.next();
    } while (frame !== null && !("event" in frame && frame.event === "sessions"));
    assert.ok(frame !== null && "event" in frame);
    const data = frame.data as { file: string; added: Array<{ index: number; kind: string; text: string }> };
    assert.equal(data.file, file);
    // Le curseur part de 0 : la première lecture rend tout le fichier, les suivantes le seul delta.
    assert.deepEqual(data.added.map(entry => [entry.index, entry.kind, entry.text]), [
      [1, "user", "salut"],
      [2, "user", "encore"],
    ]);
    await reader.cancel();
  } finally {
    stack.close();
  }
});
