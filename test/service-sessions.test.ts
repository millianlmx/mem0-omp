// Tests de l'HÔTE DE SESSIONS (S-6) : création, unicité, dialogues, trames et
// libération. L'hôte est exercé avec une SESSION DE DOUBLURE (aucun modèle, aucun
// réseau) : ce qui est vérifié, c'est le contrat de l'API — les codes, les formes,
// et le fait qu'une réponse de dialogue fait bien poursuivre le tour.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createSessionHost, maillonIdentityOf } from "../omp-mem0-req/serviceSessions.ts";
import { ServiceError } from "../omp-mem0-req/serviceApi.ts";
import type { DialogAnswer, ServiceFrame } from "../omp-mem0-req/serviceApi.ts";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";

const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* déjà retiré */
    }
  }
});

/** Une session de doublure : la boucle, les évènements, et rien d'autre. */
function fakeSession(id: string, file: string) {
  const runStateListeners = new Set<(state: "running" | "idle") => void>();
  const eventListeners = new Set<(event: unknown) => void>();
  const prompts: string[] = [];
  const followUps: string[] = [];
  const aborts: string[] = [];
  const session = {
    isStreaming: false,
    extensionRunner: null,
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => file,
      getCwd: () => path.dirname(file),
    },
    subscribeRunState: (listener: (state: "running" | "idle") => void) => {
      runStateListeners.add(listener);
      return () => runStateListeners.delete(listener);
    },
    subscribe: (listener: (event: unknown) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    prompt: async (text: string) => {
      prompts.push(text);
      session.isStreaming = true;
      for (const listener of runStateListeners) listener("running");
      return true;
    },
    followUp: async (text: string) => {
      followUps.push(text);
    },
    abort: async (options?: { reason?: string }) => {
      aborts.push(options?.reason ?? "");
      session.isStreaming = false;
      for (const listener of runStateListeners) listener("idle");
    },
    dispose: () => {},
    end: (status: "completed" | "aborted") => {
      session.isStreaming = false;
      for (const listener of runStateListeners) listener("idle");
      for (const listener of eventListeners) listener({ type: "agent_end", yielded: true, status });
    },
  };
  return {
    session,
    prompts,
    followUps,
    aborts,
    /** Le contexte UI que le service a posé sur la session (les dialogues). */
    ui: null as ExtensionUIContext | null,
    toolUi: null as ExtensionUIContext | null,
  };
}

type FakeSession = ReturnType<typeof fakeSession>;

/** Une API de doublure qui rend des sessions factices, une par création. */
function fakePi() {
  const created: FakeSession[] = [];
  let seq = 0;
  const pi = {
    pi: {
      Settings: { isolated: () => ({}) },
      AgentRegistry: class {},
      SessionManager: {
        create: (cwd: string) => {
          seq += 1;
          const file = path.join(cwd, `session-${seq}.jsonl`);
          return {
            getSessionId: () => `sess-${seq}`,
            getSessionFile: () => file,
            getCwd: () => cwd,
          };
        },
        open: async (file: string) => ({
          getSessionId: () => `resume-${path.basename(file)}`,
          getSessionFile: () => file,
          getCwd: () => path.dirname(file),
        }),
      },
      createAgentSession: async (options: { cwd: string }) => {
        const fake = fakeSession(`sess-${seq + 1}`, path.join(options.cwd, `session-${seq + 1}.jsonl`));
        created.push(fake);
        return {
          session: fake.session,
          setToolUIContext: (ui: ExtensionUIContext) => {
            fake.toolUi = ui;
          },
        };
      },
    },
  };
  return { pi, created };
}

/** Le contexte UI du runner : le service le pose via `setToolUIContext`. */
function uiOf(fake: FakeSession): ExtensionUIContext {
  const ui = fake.toolUi;
  assert.ok(ui, "le service pose un contexte UI servi par l'API (S-6)");
  return ui;
}

/** Les trames reçues par un abonné, dans l'ordre. */
function framesOf(host: ReturnType<typeof createSessionHost>, id: string): ServiceFrame[] {
  const frames: ServiceFrame[] = [];
  const subscription = host.subscribe(id);
  assert.ok(subscription, `la session ${id} est abonnable`);
  subscription.subscribe(frame => frames.push(frame));
  return frames;
}

function refusalOf(err: unknown): ServiceError {
  assert.ok(err instanceof ServiceError, `erreur d'API attendue, reçu ${String(err)}`);
  return err;
}

test("service-sessions/AC-1 : une session naît, s'abonne, se libère, et un cwd en double est refusé", async () => {
  const stateDir = mktmp("sessions-state-");
  const cwd = mktmp("sessions-cwd-");
  const { pi, created } = fakePi();
  const host = createSessionHost({ pi: pi as never, stateDir, selfPath: null, log: () => {} });

  const created1 = await host.open({ cwd, purpose: "session" });
  assert.equal(created1.cwd, cwd);
  assert.equal(created1.purpose, "session");
  assert.equal(created1.state, "idle");
  assert.deepEqual(host.list().map(session => session.id), [created1.id]);
  assert.equal(host.view(created1.id)?.dialogs.length, 0);

  // Deuxième session sur le même cwd : 409, avec le motif.
  await assert.rejects(
    () => host.open({ cwd, purpose: "session" }),
    (err: unknown) => {
      const refusal = refusalOf(err);
      assert.equal(refusal.status, 409);
      assert.match(refusal.reason, /une session vit déjà pour/);
      return true;
    },
  );
  // Un cwd inexistant ou relatif : 400, jamais une session ailleurs.
  await assert.rejects(() => host.open({ cwd: "relatif", purpose: "session" }), (err: unknown) => {
    assert.equal(refusalOf(err).status, 400);
    return true;
  });
  await assert.rejects(
    () => host.open({ cwd: path.join(cwd, "absent"), purpose: "session" }),
    (err: unknown) => {
      assert.equal(refusalOf(err).status, 400);
      return true;
    },
  );
  // Une conduite (`project`) sur le MÊME cwd vit à côté de la session (S-7).
  const conduite = await host.open({ cwd, purpose: "project" });
  assert.equal(conduite.purpose, "project");
  assert.equal(host.conduiteFor(cwd)?.id, conduite.id);
  // ... mais UNE SEULE par dépôt, même par cette porte : `POST /v1/sessions
  // {purpose:"project"}` ne contourne pas l'unicité de la route `/conduite`
  // (S-6, cas limites) — deux conduites vivantes rendraient `conduiteFor` menteur.
  await assert.rejects(
    () => host.open({ cwd, purpose: "project" }),
    (err: unknown) => {
      const refusal = refusalOf(err);
      assert.equal(refusal.status, 409);
      assert.match(refusal.reason, /une conduite vit déjà pour/);
      return true;
    },
  );

  await host.close(conduite.id);
  assert.equal(host.view(conduite.id), null, "après DELETE, la session n'existe plus");
  await assert.rejects(() => host.close(conduite.id), (err: unknown) => {
    assert.equal(refusalOf(err).status, 404);
    return true;
  });
  await host.disposeAll();
  assert.deepEqual(host.list(), []);
  assert.equal(created.length, 2);
});

test("service-sessions/AC-2 : un tour publie son état et sa fin, et un prompt en vol part en file", async () => {
  const stateDir = mktmp("sessions-state-");
  const cwd = mktmp("sessions-cwd-");
  const { pi, created } = fakePi();
  const host = createSessionHost({ pi: pi as never, stateDir, selfPath: null, log: () => {} });
  const session = await host.open({ cwd, purpose: "session" });
  const frames = framesOf(host, session.id);

  assert.deepEqual(await host.prompt(session.id, { text: "bonjour" }), { accepted: true, state: "running" });
  const fake = created[0]!;
  assert.deepEqual(fake.prompts, ["bonjour"]);
  assert.deepEqual(
    frames.map(frame => frame.event),
    ["state"],
    "le passage à `running` est publié",
  );

  // Un second prompt pendant le tour est MIS EN FILE (`followUp`), jamais perdu.
  assert.deepEqual(await host.prompt(session.id, { text: "et ensuite" }), { accepted: true, state: "running" });
  assert.deepEqual(fake.followUps, ["et ensuite"]);

  fake.session.end("completed");
  assert.deepEqual(
    frames.map(frame => frame.event),
    ["state", "state", "prompt_end"],
    "le passage à `running`, le retour au repos, puis la fin du tour",
  );
  assert.deepEqual(frames[1], { event: "state", data: { state: "idle" } });
  assert.deepEqual(frames.at(-1), { event: "prompt_end", data: { status: "completed" } });

  // `abort` coupe le tour en vol et laisse la session VIVANTE (S-6).
  assert.deepEqual(await host.abort(session.id), { state: "idle" });
  assert.deepEqual(fake.aborts, ["arrêt demandé depuis l'app"]);
  assert.equal(host.view(session.id)?.state, "idle");

  // Un prompt vide est un 400 ; un prompt sur une session inconnue, un 404.
  await assert.rejects(() => host.prompt(session.id, { text: "   " }), (err: unknown) => {
    assert.equal(refusalOf(err).status, 400);
    assert.equal(refusalOf(err).reason, "prompt vide");
    return true;
  });
  await assert.rejects(() => host.prompt("inconnue", { text: "x" }), (err: unknown) => {
    assert.equal(refusalOf(err).status, 404);
    return true;
  });
  await host.disposeAll();
});

test("service-sessions/AC-3 : un dialogue select puis confirm fait poursuivre le tour, et son annulation est publiée", async () => {
  const stateDir = mktmp("sessions-state-");
  const cwd = mktmp("sessions-cwd-");
  const { pi, created } = fakePi();
  const host = createSessionHost({ pi: pi as never, stateDir, selfPath: null, log: () => {} });
  const session = await host.open({ cwd, purpose: "session" });
  const fake = created[0]!;
  const frames = framesOf(host, session.id);

  // Le dialogue part par le contexte UI du service : c'est le chemin qu'emprunte
  // une extension qui appelle `ctx.ui.select` (Doc-1 §6).
  const ui = uiOf(fake);
  const pending: Promise<string | undefined> = ui.select("Choisis une option", [
    "alpha",
    { label: "beta", description: "la seconde" },
  ]);
  const dialogFrame = frames.find(frame => frame.event === "dialog");
  assert.ok(dialogFrame && dialogFrame.event === "dialog");
  assert.deepEqual(dialogFrame.data, {
    id: dialogFrame.data.id,
    method: "select",
    title: "Choisis une option",
    options: ["alpha", "beta"],
    optionDescriptions: [null, "la seconde"],
  });
  // La session reste `running` pendant qu'un dialogue est en vol (S-6).
  assert.equal(host.view(session.id)?.dialogs.length, 1);

  await host.answer(session.id, dialogFrame.data.id, { value: "beta" });
  assert.equal(await pending, "beta", "la réponse saisie revient à la session, qui poursuit son tour");
  assert.equal(host.view(session.id)?.dialogs.length, 0);

  // Un dialogue DÉJÀ répondu n'est plus répondable : 404.
  await assert.rejects(() => host.answer(session.id, dialogFrame.data.id, { value: "beta" }), (err: unknown) => {
    assert.equal(refusalOf(err).status, 404);
    return true;
  });
  // Une réponse hors forme est un 400, et le dialogue reste en vol.
  const confirm: Promise<boolean> = ui.confirm("Livrer ?", "la revue est propre");
  const confirmFrame = frames.filter(frame => frame.event === "dialog").at(-1);
  assert.ok(confirmFrame && confirmFrame.event === "dialog");
  await assert.rejects(() => host.answer(session.id, confirmFrame.data.id, { value: "oui" }), (err: unknown) => {
    assert.equal(refusalOf(err).status, 400);
    assert.match(refusalOf(err).reason, /confirmed/);
    return true;
  });
  await host.answer(session.id, confirmFrame.data.id, { confirmed: true });
  assert.equal(await confirm, true);

  // Un dialogue annulé par le client rend `{cancelled}` et publie sa trame.
  const third: Promise<string | undefined> = ui.input("Un texte", "placeholder");
  const thirdFrame = frames.filter(frame => frame.event === "dialog").at(-1);
  assert.ok(thirdFrame && thirdFrame.event === "dialog");
  await host.answer(session.id, thirdFrame.data.id, { cancelled: true });
  assert.equal(await third, undefined);
  assert.deepEqual(frames.at(-1), { event: "dialog_cancelled", data: { id: thirdFrame.data.id } });

  // Un dialogue encore en vol à la FERMETURE est annulé, jamais laissé pendant.
  const fourth: Promise<string | undefined> = ui.editor("Édite", "pré-rempli");
  await host.close(session.id);
  assert.equal(await fourth, undefined, "aucune promesse ne reste suspendue à la fermeture");
  await host.disposeAll();
});

test("service-sessions/AC-4 : l'abonnement donne l'instantané (dialogue en vol) puis les trames vivantes", async () => {
  const stateDir = mktmp("sessions-state-");
  const cwd = mktmp("sessions-cwd-");
  const { pi, created } = fakePi();
  const host = createSessionHost({ pi: pi as never, stateDir, selfPath: null, log: () => {} });
  const session = await host.open({ cwd, purpose: "session" });
  const fake = created[0]!;
  const ui = uiOf(fake);

  const pending: Promise<string | undefined> = ui.input("Une question");

  // Le nouvel abonné reçoit le dialogue EN VOL dans son instantané : une app qui
  // se reconnecte retrouve la question, sans attendre un évènement (S-6).
  const late: ServiceFrame[] = [];
  const subscription = host.subscribe(session.id);
  assert.ok(subscription);
  assert.equal(subscription.snapshot.length, 1);
  assert.equal(subscription.snapshot[0]!.event, "dialog");
  subscription.subscribe(frame => late.push(frame));

  const answer: DialogAnswer = { value: "texte" };
  const dialogId = subscription.snapshot[0]!.event === "dialog" ? subscription.snapshot[0]!.data.id : "";
  await host.answer(session.id, dialogId, answer);
  assert.equal(await pending, "texte");

  // Les notices d'un contexte UI sortent par le flux, avec leur niveau.
  ui.notify("un avertissement", "warning");
  assert.deepEqual(late.at(-1), { event: "notice", data: { level: "warning", message: "un avertissement" } });

  // Un sous-agent n'a pas de session servie : `view` rend `null` (404 côté route).
  assert.equal(host.view("inconnue"), null);
  assert.equal(host.subscribe("inconnue"), null);
  await host.disposeAll();
});

test("service-sessions/AC-5 : une session de maillon porte son identité, et n'est pas listée", async () => {
  const stateDir = mktmp("sessions-state-");
  const cwd = mktmp("sessions-cwd-");
  const { pi, created } = fakePi();
  const host = createSessionHost({ pi: pi as never, stateDir, selfPath: null, log: () => {} });
  const run = await host.open({
    cwd,
    purpose: "run",
    identity: {
      lotId: "abc",
      slug: "iso",
      phase: "specs",
      stateDir,
      worktree: cwd,
      inbox: path.join(stateDir, "inbox", "iso"),
      deadlineAt: null,
    },
  });
  // L'identité est inscrite AVANT le prompt : c'est elle que la branche de session
  // du plugin lit pour publier l'entrée du run (S-3).
  const registered = maillonIdentityOf(run.id);
  assert.equal(registered?.slug, "iso");
  assert.equal(registered?.phase, "specs");
  // Un maillon n'est PAS une session servie : l'app ne le voit pas dans sa liste.
  assert.deepEqual(host.list(), []);
  assert.equal(host.view(run.id), null);
  await host.close(run.id);
  assert.equal(maillonIdentityOf(run.id), null, "l'identité est oubliée avec la session");
  assert.equal(created.length, 1);
  await host.disposeAll();
});
