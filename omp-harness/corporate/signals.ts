// Le pont corpo ↔ usine, côté serveur : le signalement d'un collègue (un bug, une demande de
// feature) devient une proposition « ouvrir une issue et lancer un correctif dans <dépôt> »,
// puis, sur le geste de l'appareil approbateur, une issue sur la forge et un run lié qui porte
// son origine.
//
// - `reportSignal` est LE point d'entrée : les observations d'omp-chrome et les demandes du
//   poste (outil `workstation_signal`) l'appellent, et les canaux Gmail et Slack du chantier 4/6
//   l'appelleront. Il enregistre le signal (une ligne par fil) ; le job `poste-signal`
//   (workstation-agent.ts) le juge et ne peut que proposer ou écarter.
// - `preview`, `confirm`, `dismiss` sont les gestes de l'humain : la création de l'issue et du
//   run n'a lieu que par `confirm`, jamais par l'agent, quelle que soit l'autonomie du poste.
// - L'origine (personne, fil, extrait) reste dans la base du harness : ni l'issue publique, ni
//   le dépôt, ni le prompt d'un runner, ni un outil MCP, ni un journal ne la portent. Les
//   raisons et les erreurs levées ici ne citent donc que des identifiants, des états et des
//   noms de champs.
import type { Client } from "../auth.ts";
import type { CorporatePolicy, RepoConfig } from "../config.ts";
import { corporatePolicy } from "../config.ts";
import type { Actor, HarnessContext } from "../context.ts";
import type { RunRow, SignalChannel, SignalKind, SignalPatch, SignalRow, SignalState } from "../db.ts";
import { SIGNAL_CHANNELS } from "../db.ts";
import { HarnessError } from "../errors.ts";
import type { Forge } from "../forge.ts";
import { text } from "../input.ts";
import type { FixOutcome, IssueDesk } from "../issues.ts";
import { newId } from "../ids.ts";
import type { HostToolResult } from "../rpc.ts";
import { redactSecrets } from "../vigie/redact.ts";
import { APPROVER_ONLY } from "../workstation.ts";
import type { Workstation } from "../workstation.ts";
import {
  FIELD_MAX,
  PERSON_MAX,
  SENT_BODY_MAX,
  TITLE_MAX,
  BODY_MAX,
  cut,
  excerptOf,
  identity,
  joinExcerpt,
  needlesOf,
  originRequest,
  originSection,
  redactIssueText,
  safeUrl,
  threadKey,
} from "./text.ts";

/** Les tentatives d'une détection qui finit sans verdict, avant que le signal soit jugé sans objet. */
export const DETECTION_ATTEMPTS = 3;
const ERROR_MAX = 500;
const REASON_MAX = 500;

export type SignalInput = {
  channel: string;
  threadRef: string;
  url: string;
  /** Une référence opaque de la personne, telle que l'appelant la donne (adresse, pseudo, identifiant). */
  personRef?: string | null;
  text: string;
};

/** Un signal tel que l'API le montre : ni la demande du run, ni les tentatives, ni la politique appliquée. */
export type Signal = {
  id: string;
  createdAt: number;
  updatedAt: number;
  channel: SignalChannel;
  threadRef: string;
  url: string;
  personRef: string | null;
  excerpt: string;
  state: SignalState;
  reason: string | null;
  error: string | null;
  repo: string | null;
  kind: SignalKind | null;
  title: string | null;
  body: string | null;
  issue: { repo: string; number: number; url: string } | null;
  runId: string | null;
  confirmedBy: string | null;
  confirmedAt: number | null;
};

export type ReportResult = {
  status: "received" | "duplicate" | "dismissed" | "refused";
  signal: Signal | null;
  reason?: string;
};

/** L'origine d'un run : ce que `GET /v1/runs/{id}/origin` rend (lisible par REST seulement). */
export type RunOrigin = {
  signalId: string;
  channel: SignalChannel;
  threadRef: string;
  url: string;
  personRef: string | null;
  excerpt: string;
  issue: { repo: string; number: number; url: string };
  confirmedBy: string | null;
  confirmedAt: number | null;
};

export type PolicyView = { declared: CorporatePolicy; applied: "redacted" | "full"; note: string | null };

export type SignalPreview = {
  repo: string;
  policy: PolicyView;
  title: string;
  body: string;
  /** L'issue déjà créée pour ce signalement : le texte n'est alors pas renvoyé à la forge. */
  issue: { repo: string; number: number; url: string } | null;
};

export type ConfirmResult = {
  signal: Signal;
  issue: { repo: string; number: number; url: string };
  run: RunRow;
  policy: PolicyView;
};

export type Candidate = { name: string; preferred: boolean };

const FULL_NOTE =
  "dépôt privé : l'issue porte le texte confirmé ; le run lié reçoit le titre et le corps proposés, caviardés";
const NOT_PRIVATE_NOTE = "dépôt non confirmé privé par la forge : texte caviardé";
const SENT_ONCE_NOTE = (repo: string): string =>
  `l'issue est déjà créée dans ${repo} : le texte reçu n'est pas renvoyé à la forge`;

function issueOf(row: SignalRow): Signal["issue"] {
  return row.issueRepo !== null && row.issueNumber !== null && row.issueUrl !== null
    ? { repo: row.issueRepo, number: row.issueNumber, url: row.issueUrl }
    : null;
}

export function signalView(row: SignalRow): Signal {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    channel: row.channel,
    threadRef: row.threadRef,
    url: row.url,
    personRef: row.personRef,
    excerpt: row.excerpt,
    state: row.state,
    reason: row.reason,
    error: row.error,
    repo: row.repo,
    kind: row.kind,
    title: row.title,
    body: row.body,
    issue: issueOf(row),
    runId: row.runId,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt,
  };
}

function isChannel(value: unknown): value is SignalChannel {
  return (SIGNAL_CHANNELS as readonly unknown[]).includes(value);
}

/** Un argument de texte d'un outil : une chaîne non vide, sinon le nom du champ. */
function toolText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new HarnessError(400, `${key} : texte non vide attendu`);
  return value;
}

export class SignalDesk {
  readonly #ctx: HarnessContext;
  readonly #workstation: Workstation;
  readonly #issues: IssueDesk;
  /** Les confirmations en cours par signalement : deux gestes simultanés n'en font qu'un. */
  readonly #confirming = new Map<string, Promise<ConfirmResult>>();

  constructor(ctx: HarnessContext, hooks: { workstation: Workstation; issues: IssueDesk }) {
    this.#ctx = ctx;
    this.#workstation = hooks.workstation;
    this.#issues = hooks.issues;
  }

  #emit(row: SignalRow): void {
    this.#ctx.event("signal", null, { id: row.id, state: row.state }, null);
  }

  #update(id: string, patch: SignalPatch): SignalRow {
    const row = this.#ctx.store.updateSignal(id, patch) as SignalRow;
    this.#emit(row);
    return row;
  }

  // -- le point d'entrée des signalements ---------------------------------------------

  /**
   * Enregistre un signalement : une ligne par fil (`channel` + `threadRef`). Ne lève pas : un
   * refus rend sa raison (jamais la valeur reçue). Le poste en pause enregistre aussi : la
   * détection attend la reprise.
   */
  reportSignal(input: SignalInput): ReportResult {
    const refused = (reason: string): ReportResult => ({ status: "refused", signal: null, reason });
    if (!this.#workstation.enabled) return refused("le poste de travail est désactivé (workstation.enabled)");
    if (!isChannel(input.channel)) return refused(`channel : ${SIGNAL_CHANNELS.join(" | ")}`);
    const channel = input.channel;
    if (typeof input.threadRef !== "string" || typeof input.url !== "string" || typeof input.text !== "string")
      return refused("threadRef, url et text : chaînes attendues");
    const threadRef = threadKey(input.threadRef);
    if (threadRef === "" || threadRef.length > FIELD_MAX) return refused(`threadRef : 1 à ${FIELD_MAX} caractères`);
    const url = safeUrl(input.url);
    if (url.length > FIELD_MAX || (url === "" && channel !== "manual"))
      return refused(`url : ${channel === "manual" ? "0" : "1"} à ${FIELD_MAX} caractères`);
    const personRef = typeof input.personRef === "string" ? input.personRef.trim() || null : null;
    if (personRef !== null && personRef.length > PERSON_MAX)
      return refused(`personRef : ${PERSON_MAX} caractères au plus`);
    const clean = redactSecrets(input.text).trim();
    if (clean === "") return refused("text : texte non vide attendu");
    if (channel !== "manual" && personRef !== null) {
      const self = this.#workstation.settings().selfIdentities.map(identity);
      if (self.includes(identity(personRef))) return refused("signal envoyé par l'utilisateur lui-même");
    }
    const { store } = this.#ctx;
    const known = store.signalOfThread(channel, threadRef);
    if (known === null) {
      const row = store.insertSignal({
        id: newId("sg"),
        channel,
        threadRef,
        url,
        personRef,
        excerpt: excerptOf(clean),
      });
      this.#emit(row);
      return { status: "received", signal: signalView(row) };
    }
    switch (known.state) {
      case "received": {
        const row = store.updateSignal(known.id, { excerpt: joinExcerpt(known.excerpt, clean) }) as SignalRow;
        return { status: "received", signal: signalView(row) };
      }
      case "ignored": {
        const row = this.#update(known.id, {
          excerpt: excerptOf(clean),
          personRef,
          url,
          state: "received",
          reason: null,
          attempts: 0,
        });
        return { status: "received", signal: signalView(row) };
      }
      case "dismissed":
        return { status: "dismissed", signal: signalView(known) };
      default:
        return { status: "duplicate", signal: signalView(known) };
    }
  }

  // -- la détection (job `poste-signal`) -------------------------------------------------

  /** Le plus ancien signal qui attend sa détection. */
  nextReceived(): SignalRow | null {
    return this.#ctx.store.oldestReceivedSignal();
  }

  /** Pour chaque dépôt déclaré : `null` s'il peut recevoir une proposition, sinon pourquoi non. */
  async #repoStates(): Promise<Map<string, string | null>> {
    const states = new Map<string, string | null>();
    for (const repo of this.#ctx.config.repos) {
      if (corporatePolicy(repo) === "forbid") {
        states.set(repo.name, "issues.corporate: forbid");
        continue;
      }
      const forge = await this.#issues.forge(repo).catch(() => null);
      states.set(repo.name, forge === null || forge.kind === "none" ? "sans forge" : null);
    }
    return states;
  }

  /** Les dépôts candidats d'une proposition, et le préféré (le dernier confirmé pour cette personne). */
  async candidates(signal: SignalRow): Promise<Candidate[]> {
    const names = [...(await this.#repoStates())].filter(([, why]) => why === null).map(([name]) => name);
    const preferred = signal.personRef === null ? null : this.#ctx.store.preferredSignalRepo(signal.personRef);
    return names.map((name) => ({ name, preferred: name === preferred }));
  }

  /** Aucun dépôt candidat : le signal est jugé sans objet, sans runner. */
  ignoreWithoutCandidate(id: string): void {
    this.#update(id, { state: "ignored", reason: "aucun dépôt candidat" });
  }

  /**
   * Une détection qui a fini sans verdict, ou dont le runner a échoué : une tentative de plus ;
   * à `DETECTION_ATTEMPTS`, le signal est jugé sans objet. Rien si le signal a déjà son verdict.
   */
  recordAttempt(id: string): void {
    const signal = this.#ctx.store.getSignal(id);
    if (signal === null || signal.state !== "received") return;
    const attempts = signal.attempts + 1;
    if (attempts >= DETECTION_ATTEMPTS)
      this.#update(id, { attempts, state: "ignored", reason: "la détection n'a rendu aucun verdict" });
    else this.#ctx.store.updateSignal(id, { attempts });
  }

  /** Le signal que le job juge, tel qu'il peut encore recevoir un verdict (`HarnessError` sinon). */
  #judgeable(jobSignalId: string, args: Record<string, unknown>): SignalRow {
    const given = args.signalId;
    if (typeof given !== "string" || given !== jobSignalId)
      throw new HarnessError(404, `signal inconnu : ${String(given).slice(0, 40)}`);
    const signal = this.#ctx.store.getSignal(given);
    if (signal === null) throw new HarnessError(404, `signal inconnu : ${given}`);
    if (signal.state !== "received") throw new HarnessError(409, `le signal est déjà ${signal.state}`);
    if (this.#workstation.settings().paused) throw new HarnessError(409, "le poste est en pause");
    return signal;
  }

  /** Les textes que le serveur retire d'une issue de ce signalement. */
  #needles(signal: SignalRow): string[] {
    return needlesOf(signal, this.#workstation.settings().selfIdentities, this.#ctx.store.workstationTexts(0));
  }

  /**
   * Le verdict « à proposer » du job : le dépôt (le préféré s'il est encore candidat, sinon celui
   * du modèle s'il est candidat), le genre, le titre et le corps, caviardés avant d'être gardés.
   */
  async propose(jobSignalId: string, args: Record<string, unknown>): Promise<HostToolResult> {
    const signal = this.#judgeable(jobSignalId, args);
    const kind = args.kind;
    if (kind !== "bug" && kind !== "feature") throw new HarnessError(400, "kind : bug | feature");
    const asked = toolText(args, "repo");
    const states = await this.#repoStates();
    const preferred = signal.personRef === null ? null : this.#ctx.store.preferredSignalRepo(signal.personRef);
    const repo = preferred !== null && states.get(preferred) === null ? preferred : asked;
    if (states.get(repo) !== null)
      throw new HarnessError(400, `dépôt non candidat : ${repo} (${states.get(repo) ?? "non déclaré"})`);
    const needles = this.#needles(signal);
    const title = cut(redactIssueText(toolText(args, "title"), needles).trim(), TITLE_MAX);
    const body = cut(redactIssueText(toolText(args, "body"), needles).trim(), BODY_MAX);
    if (title === "" || body === "") throw new HarnessError(400, "title et body : texte non vide attendu");
    this.#update(signal.id, { state: "proposed", repo, kind, title, body, reason: null });
    return { text: "proposition enregistrée. Termine ton tour." };
  }

  /** Le verdict « sans objet » du job. `excerpt` : celui que le job a lu (un message arrivé depuis demande un nouveau jugement). */
  ignore(jobSignalId: string, excerpt: string, args: Record<string, unknown>): HostToolResult {
    const signal = this.#judgeable(jobSignalId, args);
    const reason = toolText(args, "reason").trim();
    if (reason.length > REASON_MAX) throw new HarnessError(400, `reason : ${REASON_MAX} caractères au plus`);
    if (signal.excerpt !== excerpt)
      throw new HarnessError(409, "le signalement a reçu un nouveau message : il sera rejugé");
    this.#update(signal.id, { state: "ignored", reason: redactSecrets(reason) });
    return { text: "signalement écarté. Termine ton tour." };
  }

  // -- lectures ------------------------------------------------------------------------

  list(options: { states: readonly SignalState[]; limit: number }): Signal[] {
    return this.#ctx.store.listSignals(options).map(signalView);
  }

  get(id: string): Signal {
    return signalView(this.#row(id));
  }

  #row(id: string): SignalRow {
    const row = this.#ctx.store.getSignal(id);
    if (row === null) throw new HarnessError(404, `signalement inconnu : ${id}`);
    return row;
  }

  /** L'origine d'un run (`null` : le run ne vient pas d'un signalement). */
  originOf(runId: string): RunOrigin | null {
    const row = this.#ctx.store.signalOfRun(runId);
    const issue = row === null ? null : issueOf(row);
    if (row === null || issue === null) return null;
    return {
      signalId: row.id,
      channel: row.channel,
      threadRef: row.threadRef,
      url: row.url,
      personRef: row.personRef,
      excerpt: row.excerpt,
      issue,
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt,
    };
  }

  // -- les gestes de l'humain ---------------------------------------------------------------

  /** Le dépôt visé d'une confirmation ou d'un aperçu : déclaré, ouvert aux issues d'origine corpo, avec une forge. */
  async #target(name: string): Promise<{ repo: RepoConfig; forge: Forge }> {
    const repo = this.#ctx.config.repos.find((entry) => entry.name === name);
    if (!repo) throw new HarnessError(404, `dépôt inconnu : ${name}`);
    if (corporatePolicy(repo) === "forbid")
      throw new HarnessError(409, `le dépôt ${name} refuse les issues d'origine corpo (issues.corporate: forbid)`);
    const forge = await this.#issues.forge(repo);
    if (forge.kind === "none") throw new HarnessError(409, (await forge.auth()).detail);
    return { repo, forge };
  }

  /** La politique appliquée : `full` seulement si la forge confirme le dépôt privé, sinon `redacted` (décision #1). */
  async #policy(declared: CorporatePolicy, forge: Forge): Promise<PolicyView> {
    if (declared !== "full") return { declared, applied: "redacted", note: null };
    return (await forge.visibility()) === "private"
      ? { declared, applied: "full", note: FULL_NOTE }
      : { declared, applied: "redacted", note: NOT_PRIVATE_NOTE };
  }

  /** Le texte qui part à la forge : caviardé par le serveur (`redacted`), ou les secrets seulement (`full` appliqué). */
  #sent(policy: PolicyView, signal: SignalRow, title: string, body: string): { title: string; body: string } {
    if (policy.applied === "full")
      return { title: cut(redactSecrets(title), TITLE_MAX), body: cut(redactSecrets(body), SENT_BODY_MAX) };
    const needles = this.#needles(signal);
    return {
      title: cut(redactIssueText(title, needles), TITLE_MAX),
      body: cut(redactIssueText(body, needles), SENT_BODY_MAX),
    };
  }

  #proposed(id: string): SignalRow {
    const signal = this.#row(id);
    if (signal.state !== "proposed") throw new HarnessError(409, `le signalement est déjà ${signal.state}`);
    return signal;
  }

  /** Le texte EXACT que `confirm` enverrait avec les mêmes entrées ; ne change rien. */
  async preview(id: string, input: Record<string, unknown>): Promise<SignalPreview> {
    const signal = this.#proposed(id);
    const name = input.repo === undefined ? signal.repo : text(input, "repo");
    if (name === null) throw new HarnessError(400, "repo : chaîne attendue");
    const { repo, forge } = await this.#target(name);
    const issue = issueOf(signal);
    if (issue !== null && issue.repo !== name)
      throw new HarnessError(409, `l'issue est déjà créée dans ${issue.repo} : confirmer sans changer de dépôt`);
    const policy = await this.#policy(corporatePolicy(repo), forge);
    const title = input.title === undefined ? (signal.title ?? "") : text(input, "title");
    const body =
      input.body === undefined
        ? `${signal.body ?? ""}${policy.applied === "full" ? originSection(signal) : ""}`
        : text(input, "body");
    const sent = this.#sent(policy, signal, title, body);
    return { repo: name, policy: issue === null ? policy : { ...policy, note: SENT_ONCE_NOTE(name) }, ...sent, issue };
  }

  /** Écarte la proposition ; elle n'est plus reproposée pour ce fil. */
  dismiss(id: string, input: Record<string, unknown>, client: Client): Signal {
    this.#row(id);
    if (!client.approver) throw new HarnessError(403, APPROVER_ONLY);
    this.#proposed(id);
    const reason = text(input, "reason", false).trim();
    if (reason.length > REASON_MAX) throw new HarnessError(400, `reason : ${REASON_MAX} caractères au plus`);
    return signalView(this.#update(id, { state: "dismissed", reason: reason === "" ? null : redactSecrets(reason) }));
  }

  /**
   * Crée l'issue sur la forge puis le run lié, au geste de l'approbateur. Rejouable : l'issue créée
   * est écrite dès la réponse de la forge, une nouvelle confirmation ne la recrée pas.
   */
  confirm(id: string, input: Record<string, unknown>, client: Client, actor: Actor): Promise<ConfirmResult> {
    const pending = this.#confirming.get(id);
    if (pending) return pending;
    const run = this.#confirm(id, input, client, actor).finally(() => this.#confirming.delete(id));
    this.#confirming.set(id, run);
    return run;
  }

  async #confirm(id: string, input: Record<string, unknown>, client: Client, actor: Actor): Promise<ConfirmResult> {
    this.#row(id);
    if (!client.approver) throw new HarnessError(403, APPROVER_ONLY);
    const signal = this.#proposed(id);
    const name = text(input, "repo");
    const title = text(input, "title");
    const body = text(input, "body");
    if (title.trim() === "" || body.trim() === "") throw new HarnessError(400, "title et body sont requis");
    const { repo, forge } = await this.#target(name);
    const declared = corporatePolicy(repo);
    let current = signal;
    let policy: PolicyView;
    if (signal.issueNumber !== null) {
      if (signal.issueRepo !== name)
        throw new HarnessError(
          409,
          `l'issue est déjà créée dans ${signal.issueRepo} : confirmer sans changer de dépôt`,
        );
      policy = { declared, applied: signal.policy === "full" ? "full" : "redacted", note: SENT_ONCE_NOTE(name) };
    } else {
      policy = await this.#policy(declared, forge);
      const sent = this.#sent(policy, signal, title, body);
      let created: { number: number; url: string };
      try {
        created = await forge.createIssue({ title: sent.title, body: sent.body, labels: [] });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#update(id, { error: cut(message, ERROR_MAX) });
        throw err instanceof HarnessError ? err : new HarnessError(502, message);
      }
      // Sous `full`, le run est construit du texte PROPOSÉ (caviardé à l'enregistrement) : ce que
      // l'humain ajoute à l'issue privée n'atteint ni le prompt ni les sorties du harness.
      const kept = policy.applied === "full" ? { title: signal.title ?? "", body: signal.body ?? "" } : sent;
      current = this.#update(id, {
        repo: name,
        issueRepo: name,
        issueNumber: created.number,
        issueUrl: created.url,
        policy: policy.applied,
        title: kept.title,
        body: kept.body,
        runTitle: `Issue #${created.number} : ${kept.title}`,
        runRequest: originRequest(forge, created.number, created.url, kept.title, kept.body),
        error: null,
      });
    }
    const issue = issueOf(current) as NonNullable<Signal["issue"]>;
    let outcome: FixOutcome;
    try {
      outcome = await this.#issues.fix(repo, issue.number, actor, { origin: true });
    } catch (err) {
      const message =
        err instanceof HarnessError && err.status === 409
          ? `l'issue #${issue.number} est fermée sur la forge : la rouvrir puis confirmer de nouveau, ou écarter la proposition`
          : err instanceof Error
            ? err.message
            : String(err);
      this.#update(id, { error: cut(message, ERROR_MAX) });
      throw err instanceof HarnessError ? new HarnessError(err.status, message) : new HarnessError(500, message);
    }
    const confirmed = this.#update(id, {
      state: "confirmed",
      runId: outcome.run.id,
      confirmedBy: actor.by,
      confirmedAt: Date.now(),
      error: null,
    });
    return { signal: signalView(confirmed), issue, run: outcome.run, policy };
  }
}
