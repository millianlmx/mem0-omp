// Preuves de la bascule inter-répertoires (S-1/S-2/S-3) : la décision PURE, la
// lecture BORNÉE de l'en-tête de session, et le protocole complet de `joinEntry`
// (aménagement du cwd, bascule, adoption, restauration sur refus).
//
// La garde d'OMP — une bascule est refusée quand le cwd enregistré par le fichier
// cible diffère du cwd courant (`## Documentation` §1) — est MODÉLISÉE par le faux
// gestionnaire de session ci-dessous. Le paquet OMP n'est pas une dépendance du
// dépôt : un test qui importerait `AgentSession` ne serait pas installable ici. La
// surface réelle est prouvée par le smoke test TUI de BR-3.
//
// Répertoires et fichiers de session RÉELS sous `mkdtempSync` (comme
// pipelines.test.ts) : aucune horloge, aucun timer, aucune dépendance npm.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildPanelRows,
  diskProbe,
  joinEntry,
  readSessionHeader,
  switchDecision,
  type NavSessionManager,
  type PanelGlyphs,
  type PanelModel,
  type SessionProbe,
  type SwitchCtx,
} from "../omp-mem0-req/extension.ts";

const tmpDirs: string[] = [];

/** L'état interne du faux gestionnaire — ce que `captureState` copie et `restoreState` remet. */
type FakeState = { cwd: string; sessionDir: string; sessionFile: string; recordedCwd: string | null };

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

/** Un fichier de session RÉEL : créneau de titre, en-tête (validateur d'OMP), messages. */
function writeSession(file: string, cwd: string, messages: string[] = []): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ type: "title", v: 1, title: "session de test", updatedAt: 1 }),
    JSON.stringify({ type: "session", version: 3, id: path.basename(file), timestamp: "2026-09-19T00:00:00.000Z", cwd }),
    ...messages.map((content, i) => JSON.stringify({ type: "message", id: `m${i}`, role: "user", content })),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/**
 * Faux gestionnaire de session qui IMPLÉMENTE la garde documentée d'OMP :
 * `switchSession` refuse (`{cancelled: true}`, comme OMP) quand le cwd enregistré
 * par le fichier cible diffère du cwd courant, sans quoi il charge réellement le
 * fichier (messages lus, cwd enregistré adopté) — et, comme OMP, il laisse
 * `getSessionDir()` sur le bucket de la session quittée : seul `adoptRecordedCwd`
 * le re-pointe (`## Documentation` §2).
 */
function fakeSession(opts: { cwd: string; sessionDir: string; sessionFile: string }) {
  const calls: string[] = [];
  const loaded: string[] = [];
  let cwd = path.resolve(opts.cwd);
  let sessionDir = opts.sessionDir;
  let sessionFile = opts.sessionFile;
  let recordedCwd: string | null = null;

  const sessionManager: NavSessionManager = {
    getCwd: () => cwd,
    captureState: () => {
      calls.push("captureState");
      return { cwd, sessionDir, sessionFile, recordedCwd } satisfies FakeState;
    },
    setCwdWithoutRelocation: (next) => {
      calls.push(`setCwdWithoutRelocation:${next}`);
      cwd = path.resolve(next);
    },
    adoptRecordedCwd: () => {
      calls.push("adoptRecordedCwd");
      sessionDir = path.dirname(sessionFile);
      if (recordedCwd) cwd = path.resolve(recordedCwd);
    },
    restoreState: (snapshot) => {
      calls.push("restoreState");
      const s = snapshot as FakeState;
      cwd = s.cwd;
      sessionDir = s.sessionDir;
      sessionFile = s.sessionFile;
      recordedCwd = s.recordedCwd;
    },
  };

  const ctx: SwitchCtx = {
    sessionManager,
    switchSession: async (target) => {
      calls.push(`switchSession:${target}`);
      const header = readSessionHeader(target);
      const targetCwd = header?.cwd ?? null;
      if (targetCwd !== null && path.resolve(targetCwd) !== path.resolve(cwd)) return { cancelled: true };
      sessionFile = target;
      recordedCwd = targetCwd;
      loaded.length = 0;
      for (const line of fs.readFileSync(target, "utf8").split("\n")) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "message") {
          loaded.push(String((parsed as { content?: unknown }).content));
        }
      }
      if (targetCwd) cwd = path.resolve(targetCwd);
      return { cancelled: false };
    },
  };

  return { ctx, calls, loaded, cwd: () => cwd, sessionDir: () => sessionDir, sessionFile: () => sessionFile };
}

/** Un `joinEntry` enregistreur : les trois canaux de sortie sont capturés. */
function recorder() {
  const notices: string[] = [];
  const durable: string[] = [];
  let closed = 0;
  return {
    notices,
    durable,
    closed: () => closed,
    deps: (ctx?: SwitchCtx) => ({
      ctx,
      close: () => {
        closed += 1;
      },
      showNotice: (message: string) => notices.push(message),
      notify: (text: string) => durable.push(text),
    }),
  };
}

const GLYPHS: PanelGlyphs = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  teeLeft: "+",
  teeRight: "+",
  cursor: ">",
};

/** Le rang de notice du panneau à une largeur donnée (la troncature est un artefact de largeur). */
function noticeRow(notice: string, width: number): string {
  const model: PanelModel = { running: [], live: {}, history: [], selection: -1, notice, unreadable: 0 };
  return buildPanelRows(model, { width, budget: 18, glyphs: GLYPHS, now: 0 })
    .map((row) => row.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// S-1 — AC-1 : rejoindre l'entrée d'un worktree voisin
// ---------------------------------------------------------------------------

test("join/AC-1 : rejoindre l'entrée d'un worktree voisin charge sa session et adopte son cwd", async () => {
  // Disposition « worktree » : deux répertoires FRÈRES sous un même parent.
  const parent = mktmp("join-ac1-");
  const a = path.join(parent, "mem0-omp");
  const b = path.join(parent, "mem0-omp-feature");
  const dirA = path.join(a, "sessions");
  const dirB = path.join(b, "sessions");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const fileA = path.join(dirA, "session-a.jsonl");
  const fileB = path.join(dirB, "session-b.jsonl");
  writeSession(fileA, a, ["tour de la session A"]);
  writeSession(fileB, b, ["tour de la session B"]);
  const beforeA = fs.readFileSync(fileA, "utf8");
  const listA = fs.readdirSync(dirA);
  const listB = fs.readdirSync(dirB);

  const nav = fakeSession({ cwd: a, sessionDir: dirA, sessionFile: fileA });
  const rec = recorder();
  await joinEntry({ sessionFile: fileB }, rec.deps(nav.ctx));

  // La bascule est ACCEPTÉE : panneau refermé, aucune notice d'aucune sorte.
  assert.equal(rec.closed(), 1, "le panneau se referme avant la bascule");
  assert.deepEqual(rec.notices, [], "aucune notice de panneau");
  assert.deepEqual(rec.durable, [], "aucune bascule refusée");

  // L'aménagement a lieu AVANT l'appel, l'adoption APRÈS — c'est cet ordre qui
  // fait passer la garde d'OMP puis re-pointe le magasin de session.
  assert.deepEqual(nav.calls, [
    "captureState",
    `setCwdWithoutRelocation:${b}`,
    `switchSession:${fileB}`,
    "adoptRecordedCwd",
  ]);

  // Le cwd de la session est celui de la cible : les outils suivants partiront de B.
  assert.equal(nav.cwd(), b);
  assert.equal(nav.sessionFile(), fileB);
  assert.equal(nav.sessionDir(), dirB, "le magasin est re-pointé sur le bucket de la cible");
  assert.deepEqual(nav.loaded, ["tour de la session B"], "l'historique chargé est celui du fichier cible");

  // La session quittée est intacte, et rien n'a été créé dans les deux buckets.
  assert.equal(fs.readFileSync(fileA, "utf8"), beforeA, "le fichier de la session quittée n'est pas réécrit");
  assert.deepEqual(fs.readdirSync(dirA), listA, "aucun fichier créé côté session quittée");
  assert.deepEqual(fs.readdirSync(dirB), listB, "aucun fichier créé côté cible");
});

// ---------------------------------------------------------------------------
// S-1 — AC-2 : rejoindre l'entrée d'un dépôt entièrement différent
// ---------------------------------------------------------------------------

test("join/AC-2 : rejoindre l'entrée d'un dépôt entièrement différent charge sa session et adopte son cwd", async () => {
  // Le cas rapporté : une session de pdp-cyber-aithreat rejointe depuis mem0-omp.
  // Deux arborescences DISJOINTES (AC-1, au contraire, a deux répertoires frères
  // d'un même parent) — le protocole ne dépend que des cwd, jamais du dépôt.
  const rootA = mktmp("join-ac2-depot-a-");
  const rootB = mktmp("join-ac2-depot-b-");
  assert.equal(
    rootA.startsWith(rootB) || rootB.startsWith(rootA),
    false,
    "aucune des deux arborescences n'inclut l'autre",
  );
  const a = path.join(rootA, "pdp-cyber-aithreat");
  const b = path.join(rootB, "mem0-omp");

  const dirA = path.join(a, "sessions");
  const dirB = path.join(b, "sessions");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const fileA = path.join(dirA, "session-a.jsonl");
  const fileB = path.join(dirB, "session-b.jsonl");
  writeSession(fileA, a, []);
  writeSession(fileB, b, ["tour du dépôt B"]);
  const beforeA = fs.readFileSync(fileA, "utf8");
  const listA = fs.readdirSync(dirA);
  const listB = fs.readdirSync(dirB);

  const nav = fakeSession({ cwd: a, sessionDir: dirA, sessionFile: fileA });
  const rec = recorder();
  await joinEntry({ sessionFile: fileB }, rec.deps(nav.ctx));

  assert.equal(rec.closed(), 1);
  assert.deepEqual(rec.durable, []);
  assert.deepEqual(nav.calls, [
    "captureState",
    `setCwdWithoutRelocation:${b}`,
    `switchSession:${fileB}`,
    "adoptRecordedCwd",
  ]);
  assert.equal(nav.cwd(), b);
  assert.equal(nav.sessionDir(), dirB);
  assert.deepEqual(nav.loaded, ["tour du dépôt B"]);
  assert.equal(fs.readFileSync(fileA, "utf8"), beforeA);
  assert.deepEqual(fs.readdirSync(dirA), listA);
  assert.deepEqual(fs.readdirSync(dirB), listB);
});

// ---------------------------------------------------------------------------
// S-2 — AC-3 : une entrée non reprenable est refusée, jamais remplacée par une
// session vide
// ---------------------------------------------------------------------------

test("join/AC-3 : une entrée dont le fichier de session a disparu laisse la fenêtre en place", async () => {
  const root = mktmp("join-ac3-");
  const dirA = path.join(root, "sessions");
  fs.mkdirSync(dirA, { recursive: true });
  const fileA = path.join(dirA, "session-a.jsonl");
  writeSession(fileA, root, []);
  const target = path.join(dirA, "session-jamais-ecrite.jsonl"); // jamais écrit sur le disque
  const listBefore = fs.readdirSync(dirA);

  const nav = fakeSession({ cwd: root, sessionDir: dirA, sessionFile: fileA });
  const rec = recorder();
  await joinEntry({ sessionFile: target }, rec.deps(nav.ctx));

  // Rien n'est tenté, rien n'est muté : aucune bascule n'est possible vers une
  // session vide que la bascule créerait elle-même.
  assert.deepEqual(nav.calls, [], "aucun appel au gestionnaire de session");
  assert.equal(rec.closed(), 0, "le panneau reste ouvert");
  assert.deepEqual(rec.durable, [], "ce n'est pas une bascule refusée");
  assert.deepEqual(rec.notices, [`session introuvable — entrée non reprenable : ${target}`]);

  // Le rang de notice du panneau porte le message entier à 200 colonnes…
  assert.ok(
    noticeRow(rec.notices[0]!, 200).includes(`session introuvable — entrée non reprenable : ${target}`),
    `le panneau le dit explicitement, chemin compris :\n${noticeRow(rec.notices[0]!, 200)}`,
  );
  // …et à 64 colonnes, le rang de service se REPLIE (S-2, « les notices et les
  // refus sont inchangés ») : le message reste entier et le fichier visé reste
  // nommé — jamais une notice muette ni un chemin perdu.
  const narrow = noticeRow(rec.notices[0]!, 64);
  assert.match(narrow, /session introuvable — entrée non reprenable :/);
  assert.match(narrow, /session-jamais-ecrite\.jsonl/, "le fichier visé reste nommé");

  assert.equal(fs.existsSync(target), false, "aucun fichier de session créé au chemin cible");
  assert.deepEqual(fs.readdirSync(dirA), listBefore, "et rien d'autre n'est apparu dans le magasin");

  // Le même piège, en plus vicieux : un fichier EXISTANT mais VIDE. OMP le
  // convertit en session vide au moment de la bascule (vérifié, `## Documentation`
  // §4 point 6) — donc même refus, même promesse : pas de session vide.
  const blank = path.join(dirA, "session-vide.jsonl");
  fs.writeFileSync(blank, "");
  const rec2 = recorder();
  await joinEntry({ sessionFile: blank }, rec2.deps(nav.ctx));

  assert.deepEqual(nav.calls, [], "aucune bascule tentée vers un fichier de 0 octet");
  assert.equal(rec2.closed(), 0, "le panneau reste ouvert");
  assert.deepEqual(rec2.notices, [`session sans en-tête valide — entrée non reprenable : ${blank}`]);
  assert.equal(fs.readFileSync(blank, "utf8"), "", "le fichier vide n'est PAS devenu une session");
  assert.deepEqual(
    fs.readdirSync(dirA).sort(),
    [...listBefore, "session-vide.jsonl"].sort(),
    "rien n'a été créé au-delà du fichier vide lui-même",
  );
});

// ---------------------------------------------------------------------------
// S-3 — AC-4 : la cible dont le cwd a disparu est refusée AVEC sa cause
// ---------------------------------------------------------------------------

test("join/AC-4 : une entrée dont le répertoire de travail a disparu est refusée avec sa cause", async () => {
  const root = mktmp("join-ac4-");
  const gone = path.join(root, "worktree-archive");
  fs.mkdirSync(gone, { recursive: true });
  const dirA = path.join(root, "sessions");
  const fileA = path.join(dirA, "session-a.jsonl");
  const fileB = path.join(dirA, "session-b.jsonl");
  writeSession(fileA, root, []);
  writeSession(fileB, gone, ["tour du worktree"]);
  const beforeB = fs.readFileSync(fileB, "utf8");
  // Le worktree est archivé/supprimé : OMP accepterait la bascule, le panneau non.
  fs.rmSync(gone, { recursive: true, force: true });
  assert.equal(fs.existsSync(gone), false);

  const nav = fakeSession({ cwd: root, sessionDir: dirA, sessionFile: fileA });
  const rec = recorder();
  await joinEntry({ sessionFile: fileB }, rec.deps(nav.ctx));

  assert.deepEqual(nav.calls, [], "aucun appel au gestionnaire de session");
  assert.equal(rec.closed(), 0, "le panneau reste ouvert");
  assert.deepEqual(rec.durable, []);
  assert.deepEqual(rec.notices, [
    `répertoire de travail de la session cible disparu — entrée non reprenable : ${gone}`,
  ]);
  assert.ok(
    noticeRow(rec.notices[0]!, 200).includes(`entrée non reprenable : ${gone}`),
    "la cause ET le chemin disparu sont nommés",
  );
  assert.equal(fs.readFileSync(fileB, "utf8"), beforeB, "les octets de la cible sont inchangés");
});

// ---------------------------------------------------------------------------
// Non-AC — lecture bornée de l'en-tête et décision pure
// ---------------------------------------------------------------------------

test("readSessionHeader : en-tête en 2e ligne, hérité, sans cwd, vide, non-JSON, au-delà de la borne", () => {
  const dir = mktmp("join-header-");

  // Fichier COURANT : le créneau de titre occupe la 1re ligne, l'en-tête la 2e.
  const current = path.join(dir, "courant.jsonl");
  writeSession(current, "/depot/A", ["salut"]);
  assert.deepEqual(readSessionHeader(current), { cwd: "/depot/A" });

  // Fichier HÉRITÉ : l'en-tête est en 1re ligne.
  const legacy = path.join(dir, "herite.jsonl");
  fs.writeFileSync(legacy, '{"type":"session","version":3,"id":"b","cwd":"/depot/B"}\n');
  assert.deepEqual(readSessionHeader(legacy), { cwd: "/depot/B" });

  // En-tête sans cwd, et cwd vide : les deux valent « pas de cwd » (bascule simple,
  // OMP retombe sur le cwd courant) — jamais un refus.
  const noCwd = path.join(dir, "sans-cwd.jsonl");
  fs.writeFileSync(noCwd, '{"type":"session","version":3,"id":"c"}\n');
  assert.deepEqual(readSessionHeader(noCwd), { cwd: null });
  const emptyCwd = path.join(dir, "cwd-vide.jsonl");
  fs.writeFileSync(emptyCwd, '{"type":"session","version":3,"id":"d","cwd":""}\n');
  assert.deepEqual(readSessionHeader(emptyCwd), { cwd: null });

  // Fichier vide, contenu non-JSON, ou lignes sans en-tête de session : aucun en-tête.
  const empty = path.join(dir, "vide.jsonl");
  fs.writeFileSync(empty, "");
  assert.equal(readSessionHeader(empty), null);
  const garbage = path.join(dir, "non-json.jsonl");
  fs.writeFileSync(garbage, "ceci n'est pas du JSON\net n'en sera jamais\n");
  assert.equal(readSessionHeader(garbage), null);
  const chatter = path.join(dir, "sans-en-tete.jsonl");
  fs.writeFileSync(chatter, '{"type":"message","id":"m1","role":"user","content":"seul"}\n');
  assert.equal(readSessionHeader(chatter), null);

  // En-tête AU-DELÀ de la borne : illisible dans le préfixe (donc pas d'en-tête),
  // alors qu'une lecture plus large le trouve — la borne est bien respectée.
  const far = path.join(dir, "loin.jsonl");
  fs.writeFileSync(
    far,
    `${JSON.stringify({ type: "title", v: 1, title: "x", pad: "y".repeat(400) })}\n{"type":"session","id":"e","cwd":"/depot/E"}\n`,
  );
  assert.equal(readSessionHeader(far, 64), null);
  assert.deepEqual(readSessionHeader(far), { cwd: "/depot/E" });
});

test("switchDecision : les causes de refus, dont le fichier sans en-tête valide", () => {
  const dir = mktmp("join-decision-");
  const real = path.join(dir, "session.jsonl");
  writeSession(real, dir, []);
  const empty = path.join(dir, "vide.jsonl");
  fs.writeFileSync(empty, "");
  const garbage = path.join(dir, "non-json.jsonl");
  fs.writeFileSync(garbage, "pas du JSON\n");

  // 3e ligne du tableau S-2 : un fichier de 0 octet serait converti en session vide
  // par OMP à la bascule — donc refus, exactement comme un chemin absent.
  assert.deepEqual(switchDecision({ sessionFile: empty }, diskProbe), {
    kind: "unavailable",
    message: `session sans en-tête valide — entrée non reprenable : ${empty}`,
  });
  assert.deepEqual(switchDecision({ sessionFile: garbage }, diskProbe), {
    kind: "unavailable",
    message: `session sans en-tête valide — entrée non reprenable : ${garbage}`,
  });

  // 4e ligne : le cwd enregistré n'existe plus sur le disque.
  const disappeared = path.join(dir, "disparu");
  const orphan = path.join(dir, "orpheline.jsonl");
  writeSession(orphan, disappeared, []);
  assert.deepEqual(switchDecision({ sessionFile: orphan }, diskProbe), {
    kind: "unavailable",
    message: `répertoire de travail de la session cible disparu — entrée non reprenable : ${disappeared}`,
  });

  // Un cwd enregistré qui est un FICHIER n'est pas un répertoire : refus aussi.
  const asFile = path.join(dir, "pas-un-repertoire");
  fs.writeFileSync(asFile, "x");
  const odd = path.join(dir, "cwd-fichier.jsonl");
  writeSession(odd, asFile, []);
  assert.equal(switchDecision({ sessionFile: odd }, diskProbe).kind, "unavailable");

  // Sinon : bascule, avec le cwd enregistré (jamais deviné).
  assert.deepEqual(switchDecision({ sessionFile: real }, diskProbe), { kind: "switch", path: real, cwd: dir });

  // Sonde partielle : `isSessionFile` faux court-circuite tout le reste.
  const blind: SessionProbe = { isSessionFile: () => false, sessionHeader: () => null, isDirectory: () => true };
  assert.deepEqual(switchDecision({ sessionFile: real }, blind), {
    kind: "unavailable",
    message: `session introuvable — entrée non reprenable : ${real}`,
  });
});

// ---------------------------------------------------------------------------
// Non-AC — refus : restauration du snapshot et notice durable
// ---------------------------------------------------------------------------

test("joinEntry : une bascule refusée restaure l'état d'avant et le dit dans le transcript", async () => {
  const parent = mktmp("join-refus-");
  const a = path.join(parent, "depot");
  const b = path.join(parent, "worktree");
  const dirA = path.join(a, "sessions");
  const dirB = path.join(b, "sessions");
  const fileA = path.join(dirA, "session-a.jsonl");
  const fileB = path.join(dirB, "session-b.jsonl");
  writeSession(fileA, a, []);
  writeSession(fileB, b, []);

  const nav = fakeSession({ cwd: a, sessionDir: dirA, sessionFile: fileA });
  // Refus après coup : le hook `session_before_switch` d'OMP refuse la bascule que
  // la garde de cwd avait laissé passer.
  const refusing: SwitchCtx = {
    ...nav.ctx,
    switchSession: async (target) => {
      await nav.ctx.switchSession!(target);
      return { cancelled: true };
    },
  };
  const rec = recorder();
  await joinEntry({ sessionFile: fileB }, rec.deps(refusing));

  assert.equal(rec.closed(), 1, "le panneau est fermé avant la bascule");
  assert.deepEqual(rec.notices, [], "ce n'est pas une notice de panneau : le panneau est déjà fermé");
  assert.deepEqual(rec.durable, [
    `[pipeline] bascule refusée — la session cible n'a pas pu être ouverte : ${fileB}`,
  ]);
  // Le snapshot est restauré : cwd, bucket et fichier reviennent à l'état d'avant,
  // et l'adoption n'a pas lieu (il n'y a pas eu de bascule).
  assert.equal(nav.calls.at(-1), "restoreState", `l'annulation vient en dernier : ${nav.calls.join(" → ")}`);
  assert.equal(nav.calls.includes("adoptRecordedCwd"), false);
  assert.equal(nav.cwd(), a);
  assert.equal(nav.sessionDir(), dirA);
  assert.equal(nav.sessionFile(), fileA);

  // Une EXCEPTION de bascule vaut refus, jamais une exception qui remonte au tour.
  const throwing: SwitchCtx = {
    ...nav.ctx,
    switchSession: async () => {
      throw new Error("hook session_before_switch a refusé");
    },
  };
  const rec2 = recorder();
  await joinEntry({ sessionFile: fileB }, rec2.deps(throwing));
  assert.deepEqual(rec2.durable, [
    `[pipeline] bascule refusée — la session cible n'a pas pu être ouverte : ${fileB}`,
  ]);
  assert.equal(nav.cwd(), a, "l'état est celui d'avant l'appel");
});

// ---------------------------------------------------------------------------
// Non-AC — contexte dégradé et chemin nominal « cwd identiques »
// ---------------------------------------------------------------------------

test("joinEntry : contexte dégradé — bascule simple, aucune mutation, aucune exception", async () => {
  const parent = mktmp("join-degrade-");
  const a = path.join(parent, "depot");
  const other = path.join(parent, "autre");
  const dirA = path.join(a, "sessions");
  const fileA = path.join(dirA, "session-a.jsonl");
  const fileAway = path.join(other, "session-ailleurs.jsonl");
  const fileHere = path.join(dirA, "session-sur-place.jsonl");
  writeSession(fileA, a, []);
  writeSession(fileAway, other, []);
  writeSession(fileHere, a, []);

  // 1. Un OMP plus ancien, dont le contexte n'expose AUCUNE méthode de
  //    relocalisation : la bascule inter-cwd est alors refusée par OMP lui-même et
  //    la notice durable est le seul effet — surtout pas une exception.
  const legacy: SwitchCtx = {
    switchSession: async (target) => {
      const header = readSessionHeader(target);
      const targetCwd = header?.cwd ?? null;
      return { cancelled: targetCwd !== null && path.resolve(targetCwd) !== path.resolve(a) };
    },
  };
  const rec = recorder();
  await joinEntry({ sessionFile: fileAway }, rec.deps(legacy));
  assert.deepEqual(rec.notices, [], "rien à signaler DANS le panneau : il est fermé");
  assert.equal(rec.closed(), 1);
  assert.deepEqual(rec.durable, [
    `[pipeline] bascule refusée — la session cible n'a pas pu être ouverte : ${fileAway}`,
  ]);

  // 2. Un gestionnaire de session amputé de la relocalisation (`setCwdWithoutRelocation`
  //    et `restoreState` absents) : la dégradation est détectée AVANT toute mutation,
  //    donc rien n'est appelé dessus, pas même un snapshot.
  const touched: string[] = [];
  const crippled: SwitchCtx = {
    sessionManager: {
      getCwd: () => {
        touched.push("getCwd");
        return a;
      },
      captureState: () => {
        touched.push("captureState");
        return { cwd: a, sessionDir: dirA, sessionFile: fileA, recordedCwd: null } satisfies FakeState;
      },
    },
    switchSession: legacy.switchSession,
  };
  const rec2 = recorder();
  await joinEntry({ sessionFile: fileAway }, rec2.deps(crippled));
  assert.deepEqual(rec2.durable, [
    `[pipeline] bascule refusée — la session cible n'a pas pu être ouverte : ${fileAway}`,
  ]);
  assert.deepEqual(touched, [], "aucune méthode appelée sur le gestionnaire amputé");

  // 3. Chemin NOMINAL « cwd identiques » : la cible vit dans le répertoire courant,
  //    donc rien à aménager — la bascule d'OMP passe la garde seule, et l'aménagement
  //    (ainsi que l'adoption) restent absents.
  const nav = fakeSession({ cwd: a, sessionDir: dirA, sessionFile: fileA });
  const rec3 = recorder();
  await joinEntry({ sessionFile: fileHere }, rec3.deps(nav.ctx));
  assert.deepEqual(nav.calls, [`switchSession:${fileHere}`], "aucun snapshot, aucune adoption");
  assert.deepEqual(rec3.durable, []);
  assert.equal(rec3.closed(), 1);
  assert.equal(nav.sessionFile(), fileHere);
  assert.equal(nav.sessionDir(), dirA, "le bucket était déjà le bon");

  // 4. `getCwd` absent mais les trois méthodes de relocalisation présentes :
  //    l'aménagement est tenté (il est idempotent) et l'adoption suit.
  const blind = fakeSession({ cwd: a, sessionDir: dirA, sessionFile: fileA });
  const noGetter: SwitchCtx = {
    sessionManager: { ...blind.ctx.sessionManager, getCwd: undefined },
    switchSession: blind.ctx.switchSession,
  };
  const rec4 = recorder();
  await joinEntry({ sessionFile: fileAway }, rec4.deps(noGetter));
  assert.deepEqual(blind.calls, [
    "captureState",
    `setCwdWithoutRelocation:${other}`,
    `switchSession:${fileAway}`,
    "adoptRecordedCwd",
  ]);
  assert.deepEqual(rec4.durable, []);
  assert.equal(blind.cwd(), other);
});
