// Le connecteur Atlassian du harness : Jira et Confluence par le serveur Atlassian Rovo MCP, en
// OAuth 2.1 (oauth.ts), avec son client MCP (mcp.ts) et les outils des agents (tools.ts).
//
// - Branchement : l'approbateur lance le consentement depuis l'app ; le retour arrive sur la
//   route publique `GET /v1/atlassian/callback` (redirection tailnet) ou est collé dans l'app
//   (boucle locale). Le site et le compte sont découverts à l'échange, jamais codés en dur.
// - Écritures : un agent fait avancer SEUL les tickets de l'utilisateur (transitions) ; un
//   commentaire n'est qu'une proposition, publiée quand l'approbateur l'approuve (texte édité ou non).
// - Le plan du jour (job `poste-plan`) et la passe de savoir (job `poste-savoir`, mémoire `corpo`)
//   sont posés ici : leurs demandes depuis l'app, leurs résultats, leurs dates.
//
// Multi-client : UNE connexion par espace, plus la connexion par défaut (hors espace). Un `AtlassianDesk`
// est une connexion ; celui de l'orchestrateur est la connexion par défaut et prête les autres
// (`forSpace`, `forRepo`, `all`, `connections`). Chaque connexion a son fichier de jetons, son site, sa
// portée mémoire (`corpo`, ou `corpo:<espaceId>`), ses écritures, ses plans et ses dates ; rien ne passe
// de l'une à l'autre. Un dépôt d'un espace ne lit QUE la connexion de son espace : sans elle, il n'a rien.
//
// Tout est réservé au propriétaire (repo null des événements). Les jetons ne quittent jamais leur
// fichier (`atlassian.tokenFile`, `atlassian-<espaceId>.json` à côté pour un espace).
import * as fs from "node:fs";
import type { AtlassianConfig, HarnessConfig } from "../config.ts";
import { isRecord, repoByName } from "../config.ts";
import type { HarnessContext } from "../context.ts";
import type {
  AtlassianPlan,
  AtlassianWrite,
  AtlassianWriteState,
  NewAtlassianWrite,
  PlanItem,
  PlanTrigger,
} from "../db.ts";
import { ATLASSIAN_WRITE_STATES, PLAN_SOURCES } from "../db.ts";
import { HarnessError } from "../errors.ts";
import { newId } from "../ids.ts";
import { renderMemories } from "../oracle.ts";
import type { HostToolResult } from "../rpc.ts";
import { McpClient } from "./mcp.ts";
import type { McpToolResult } from "./mcp.ts";
import type { AtlassianFetch, AtlassianTokens } from "./oauth.ts";
import {
  AtlassianAuth,
  AtlassianNotConnected,
  isPasteBack,
  redirectUriOf,
  spaceOfState,
  spaceTokenFile,
  storedTokens,
} from "./oauth.ts";
import type { AtlassianToolHost } from "./tools.ts";
import { JIRA_KEY, JIRA_PROJECT, NOT_CONNECTED, outsideProjects, runAtlassianTool } from "./tools.ts";

export {
  ATLASSIAN_READ_TOOLS,
  ATLASSIAN_WRITE_TOOLS,
  isAtlassianTool,
} from "./tools.ts";
export type { AtlassianToolName } from "./tools.ts";
export type { AtlassianFetch } from "./oauth.ts";
export type { AtlassianPlan, AtlassianWrite, PlanItem, PlanSource, PlanTrigger } from "../db.ts";

/** La portée mémoire du savoir de la boîte : étanche, jamais celle d'un dépôt. */
export const CORPO_SCOPE = "corpo";

/** La portée mémoire du savoir d'une connexion : `corpo` par défaut, `corpo:<espaceId>` pour un espace. */
export function corpoScopeOf(space: string | null): string {
  return space === null ? CORPO_SCOPE : `${CORPO_SCOPE}:${space}`;
}

/** Le réglage de la dernière passe de savoir : `{summary, at}` (suffixé `:<espaceId>` pour un espace). */
const KNOWLEDGE_SETTING = "atlassian.knowledge";
/** Le refus d'un retour de consentement : jamais l'écho de ses paramètres. */
export const INVALID_LINK = "Lien de connexion invalide ou expiré.";

export type AtlassianStatus = {
  enabled: boolean;
  /** L'espace de cette connexion ; `null` : la connexion par défaut (hors espace). */
  space: string | null;
  /** La portée mémoire de son savoir (`corpo`, ou `corpo:<espaceId>`). */
  scope: string;
  connected: boolean;
  site: { cloudId: string; url: string } | null;
  accountId: string | null;
  connectedAt: number | null;
  connectedBy: string | null;
  expiresAt: number | null;
  lastError: string | null;
  redirectUri: string;
  /** La redirection est une boucle locale : l'app propose de coller l'adresse de retour. */
  pasteBack: boolean;
  pending: { authorizeUrl: string; expiresAt: number } | null;
  plan: { hour: number | null; weekdaysOnly: boolean; lastAt: number | null };
  knowledge: { everyHours: number | null; lastAt: number | null; lastSummary: string | null };
  /** Les écritures en attente de l'approbateur. */
  proposed: number;
};

export type AtlassianConnect = { authorizeUrl: string; redirectUri: string; expiresAt: number; pasteBack: boolean };

/** L'état de la connexion d'un espace, tel que `GET /v1/spaces` le montre. */
export type SpaceAtlassian = { connected: boolean; site: string | null };

/**
 * L'état de la connexion Atlassian d'un espace, lu dans son fichier de jetons (aucun appel réseau) :
 * `connected` quand des jetons sont rangés ET le site connu ; `null` quand Atlassian est désactivé sur le
 * serveur (`atlassian.enabled: false`).
 */
export function spaceAtlassian(config: HarnessConfig, spaceId: string): SpaceAtlassian | null {
  if (!config.atlassian.enabled) return null;
  const tokens = storedTokens(spaceTokenFile(config.atlassian, spaceId));
  const site = tokens?.cloudId && tokens.siteUrl ? tokens.siteUrl : null;
  return { connected: site !== null, site };
}

/**
 * Les connexions vivantes qui lisent le MÊME site Atlassian (`cloudId`) : pour chaque espace branché,
 * les autres connexions de son site — un identifiant d'espace, ou `null` pour la connexion par défaut.
 * Lu dans les fichiers de jetons, sans réseau ; vide sans espace ou quand Atlassian est désactivé. Rien
 * ne sépare deux connexions d'un même site : chacune y lit les tickets et les pages de l'autre.
 */
export function sharedSites(config: HarnessConfig, spaceIds: readonly string[]): Map<string, (string | null)[]> {
  const shared = new Map<string, (string | null)[]>();
  if (!config.atlassian.enabled || spaceIds.length === 0) return shared;
  const sites = [null, ...spaceIds].map((space) => {
    const file = space === null ? config.atlassian.tokenFile : spaceTokenFile(config.atlassian, space);
    const tokens = storedTokens(file);
    return { space, cloudId: tokens?.cloudId && tokens.siteUrl ? tokens.cloudId : null };
  });
  for (const own of sites) {
    if (own.space === null || own.cloudId === null) continue;
    const others = sites.filter((other) => other.space !== own.space && other.cloudId === own.cloudId);
    if (others.length > 0)
      shared.set(
        own.space,
        others.map((other) => other.space),
      );
  }
  return shared;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Un texte borné, rogné (absent : vide, refusé si `min` > 0) ; 400 sinon. */
function planText(value: unknown, what: string, min: number, max: number): string {
  const text = value === undefined || value === null ? "" : typeof value === "string" ? value.trim() : null;
  if (text === null || text.length < min || text.length > max)
    throw new HarnessError(400, `${what} : texte de ${min} à ${max} caractères attendu`);
  return text;
}

/** Le premier site Jira (sinon le premier) de `getAccessibleAtlassianResources`. */
function siteOf(text: string): { cloudId: string; url: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const top = isRecord(parsed) ? parsed : {};
  const data = isRecord(top.data) ? top.data : {};
  const list = Array.isArray(parsed) ? parsed : Array.isArray(data.resources) ? data.resources : top.resources;
  const sites = (Array.isArray(list) ? list : [])
    .filter(isRecord)
    .map((site) => ({
      cloudId: typeof site.cloudId === "string" ? site.cloudId : typeof site.id === "string" ? site.id : "",
      url: typeof site.url === "string" ? site.url : "",
      jira: JSON.stringify(site.products ?? site.scopes ?? []).includes("jira"),
    }))
    .filter((site) => site.cloudId !== "" && /^https:\/\//.test(site.url));
  const chosen = sites.find((site) => site.jira) ?? sites[0];
  return chosen ? { cloudId: chosen.cloudId, url: chosen.url.replace(/\/+$/, "") } : null;
}

/** L'`accountId` de `atlassianUserInfo` (`{data:{accountId}}` ou à plat). */
function accountOf(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    const data = isRecord(parsed.data) ? parsed.data : parsed;
    const id = data.accountId ?? data.account_id ?? parsed.accountId ?? parsed.account_id;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

export class AtlassianDesk {
  readonly #ctx: HarnessContext;
  readonly #fetch: AtlassianFetch;
  readonly #auth: AtlassianAuth;
  readonly #mcp: McpClient;
  readonly #tools: AtlassianToolHost;
  /** L'espace de cette connexion ; `null` : la connexion par défaut (hors espace). */
  readonly space: string | null;
  /** La connexion par défaut, qui garde celles des espaces (elle-même pour la connexion par défaut). */
  readonly #home: AtlassianDesk;
  /** Les connexions des espaces, créées à la demande (sur la connexion par défaut seulement). */
  readonly #desks = new Map<string, AtlassianDesk>();
  #lastError: string | null = null;
  #planRequested = false;
  #knowledgeRequested = false;
  /** Les écritures en cours d'approbation : un second geste sur la même attend la fin du premier (409). */
  readonly #deciding = new Set<string>();

  /** `of` : la connexion d'un espace, créée par la connexion par défaut (`forSpace`) ; absent : celle par défaut. */
  constructor(ctx: HarnessContext, deps: { fetch: AtlassianFetch; of?: { space: string; home: AtlassianDesk } }) {
    this.#ctx = ctx;
    this.#fetch = deps.fetch;
    this.space = deps.of?.space ?? null;
    this.#home = deps.of?.home ?? this;
    this.#auth = new AtlassianAuth({
      fetch: deps.fetch,
      config: () => this.#config(),
      space: this.space,
      onRevoked: (reason) => {
        this.#lastError = `jeton refusé par Atlassian (${reason}) : rebranche Atlassian depuis l'app`;
        this.#mcp.reset();
        this.#ctx.log(`${this.#name()} : jetons oubliés — ${reason}`, { level: "warn" });
        this.#event("atlassian", { connected: false });
      },
    });
    this.#mcp = new McpClient({ fetch: deps.fetch, url: () => this.#config().mcpUrl, auth: this.#auth });
    this.#tools = {
      enabled: () => this.enabled(),
      site: () => this.#site(),
      call: (tool, args, signal) => this.#call(tool, args, signal),
      recall: async (query) => renderMemories(await this.#ctx.oracle.recall(this.scope, query)),
      record: (input) => this.#record(input),
      proposed: (issueKey, body) => this.#ctx.store.proposedAtlassianComment(issueKey, body, this.space),
      projects: () => this.projects(),
    };
  }

  /** La configuration du connecteur, avec le fichier de jetons de CETTE connexion. */
  #config(): AtlassianConfig {
    const config = this.#ctx.config.atlassian;
    return this.space === null ? config : { ...config, tokenFile: spaceTokenFile(config, this.space) };
  }

  /** Le nom de la connexion dans le journal. */
  #name(): string {
    return this.space === null ? "Atlassian" : `Atlassian (espace ${this.space})`;
  }

  /** Un événement du connecteur ; celui d'un espace le dit (`space`), celui par défaut est inchangé. */
  #event(type: "atlassian" | "atlassian_write" | "atlassian_plan", payload: Record<string, unknown>): void {
    this.#ctx.event(type, null, this.space === null ? payload : { ...payload, space: this.space }, null);
  }

  enabled(): boolean {
    return this.#ctx.config.atlassian.enabled;
  }

  /** La portée mémoire du savoir de cette connexion. */
  get scope(): string {
    return corpoScopeOf(this.space);
  }

  // -- les connexions (multi-client) --------------------------------------------------

  /** La connexion de cet espace, créée à la demande ; 404 si l'espace n'existe pas. */
  forSpace(id: string): AtlassianDesk {
    if (this.#ctx.store.getSpace(id) === null) throw new HarnessError(404, `espace inconnu : ${id}`);
    const home = this.#home;
    let desk = home.#desks.get(id);
    if (desk === undefined) {
      desk = new AtlassianDesk(this.#ctx, { fetch: home.#fetch, of: { space: id, home } });
      home.#desks.set(id, desk);
    }
    return desk;
  }

  /**
   * Oublie la connexion d'un espace retiré : ses jetons (le fichier est supprimé), sa session MCP, son
   * consentement en attente, ses demandes de plan et de savoir, le compte rendu de sa dernière passe.
   * Un espace recréé repart d'une connexion neuve.
   */
  forgetSpace(id: string): void {
    const home = this.#home;
    const desk = home.#desks.get(id);
    if (desk !== undefined) desk.#mcp.reset();
    home.#desks.delete(id);
    fs.rmSync(spaceTokenFile(this.#ctx.config.atlassian, id), { force: true });
    this.#ctx.store.deleteSetting(`${KNOWLEDGE_SETTING}:${id}`);
  }

  /**
   * La connexion qu'un dépôt lit : celle de SON espace — même sans jetons, jamais de repli sur la
   * connexion par défaut — ; la connexion par défaut pour un dépôt hors de tout espace.
   */
  forRepo(repo: string): AtlassianDesk {
    const space = this.#ctx.store.listSpaces().find((entry) => entry.repos.includes(repo));
    return space ? this.forSpace(space.id) : this.#home;
  }

  /** Toutes les connexions : celle par défaut, puis celle de chaque espace (branchée ou non). */
  all(): AtlassianDesk[] {
    return [this.#home, ...this.#ctx.store.listSpaces().map((space) => this.forSpace(space.id))];
  }

  /** Les connexions vivantes (Atlassian activé, jetons rangés, site connu) : celles dont les jobs du poste tournent. */
  connections(): AtlassianDesk[] {
    return this.enabled() ? this.all().filter((desk) => desk.connected()) : [];
  }

  /**
   * La connexion à laquelle appartient cette écriture : depuis la connexion par défaut, la sienne (celle
   * d'un espace comprise) ; depuis celle d'un espace, seulement une écriture de cet espace. 404 sinon.
   */
  ofWrite(id: string): AtlassianDesk {
    const write = this.#ctx.store.getAtlassianWrite(id);
    const owner = write?.space ?? null;
    const known =
      write !== null &&
      (owner === this.space || (this.space === null && owner !== null && this.#ctx.store.getSpace(owner) !== null));
    if (!known) throw new HarnessError(404, `écriture Atlassian inconnue : ${id}`);
    return owner === null ? this.#home : this.forSpace(owner);
  }

  /**
   * Les dépôts qu'un plan de cette connexion peut viser : ceux de son espace ; pour la connexion par
   * défaut, les dépôts déclarés qui n'appartiennent à aucun espace (tous, sur un serveur sans espace).
   */
  repos(): string[] {
    const spaces = this.#ctx.store.listSpaces();
    const declared = this.#ctx.config.repos.map((repo) => repo.name);
    if (this.space === null) {
      const taken = new Set(spaces.flatMap((space) => space.repos));
      return declared.filter((name) => !taken.has(name));
    }
    const own = spaces.find((space) => space.id === this.space)?.repos ?? [];
    return declared.filter((name) => own.includes(name));
  }

  /**
   * Les projets Jira auxquels cette connexion est bornée (clés en majuscules) : ceux que son espace
   * déclare (`jiraProjects`) ; `null` : aucune borne (connexion par défaut, ou espace qui n'en déclare pas).
   * Un espace disparu, ou dont aucune clé n'est lisible, ne permet rien (liste vide).
   */
  projects(): string[] | null {
    if (this.space === null) return null;
    const declared = this.#ctx.store.getSpace(this.space)?.jiraProjects;
    if (declared === undefined) return [];
    if (declared.length === 0) return null;
    return [...new Set(declared.map((key) => key.trim().toUpperCase()).filter((key) => JIRA_PROJECT.test(key)))];
  }

  // -- l'état et le branchement --------------------------------------------------------

  /** Jetons rangés ET site connu. */
  connected(): boolean {
    return this.#site() !== null;
  }

  #site(): { cloudId: string; url: string } | null {
    const tokens = this.#auth.tokens();
    return tokens?.cloudId && tokens.siteUrl ? { cloudId: tokens.cloudId, url: tokens.siteUrl } : null;
  }

  status(): AtlassianStatus {
    const config = this.#config();
    const tokens = this.#auth.tokens();
    const site = this.#site();
    const redirectUri = redirectUriOf(config);
    const pending = this.#auth.pending();
    const knowledge = this.#knowledge();
    return {
      enabled: config.enabled,
      space: this.space,
      scope: this.scope,
      connected: site !== null,
      site,
      accountId: tokens?.accountId ?? null,
      connectedAt: tokens?.connectedAt ?? null,
      connectedBy: tokens?.connectedBy ?? null,
      expiresAt: tokens?.expiresAt ?? null,
      lastError: this.#lastError,
      redirectUri,
      pasteBack: isPasteBack(redirectUri),
      pending: pending === null ? null : { authorizeUrl: pending.authorizeUrl, expiresAt: pending.expiresAt },
      plan: { hour: config.planHour, weekdaysOnly: config.planWeekdaysOnly, lastAt: this.lastPlanAt() },
      knowledge: {
        everyHours: config.knowledgeEveryHours,
        lastAt: knowledge?.at ?? null,
        lastSummary: knowledge?.summary ?? null,
      },
      proposed: this.#ctx.store.countAtlassianWrites("proposed", this.space),
    };
  }

  /** Un nouveau consentement : l'adresse à ouvrir dans le navigateur de l'humain (502 si Atlassian ne répond pas). */
  async connect(by: string): Promise<AtlassianConnect> {
    try {
      const pending = await this.#auth.begin(by);
      return {
        authorizeUrl: pending.authorizeUrl,
        redirectUri: pending.redirectUri,
        expiresAt: pending.expiresAt,
        pasteBack: isPasteBack(pending.redirectUri),
      };
    } catch (error) {
      this.#lastError = `branchement impossible : ${messageOf(error)}`;
      throw new HarnessError(502, this.#lastError);
    }
  }

  /**
   * Le retour du consentement (`code`, `state`) : 400 s'il est inconnu, expiré ou déjà servi ;
   * 502 si Atlassian refuse l'échange ou ne rend pas de site. Le site et le compte sont rangés
   * avec les jetons.
   *
   * Le `state` porte l'espace : la connexion par défaut rend le retour à celle de cet espace, qui le
   * compare EN ENTIER à son propre consentement en attente. Un `state` au préfixe changé ne trouve donc
   * rien (400) : on ne branche jamais l'espace d'un autre avec le consentement du sien. La connexion
   * d'un espace refuse tout `state` qui n'est pas le sien.
   */
  async complete(input: { code: unknown; state: unknown }): Promise<AtlassianStatus> {
    const owner = spaceOfState(input.state);
    if (owner !== this.space) {
      const desk =
        this.space === null && owner !== null && this.#ctx.store.getSpace(owner) !== null
          ? this.#desks.get(owner)
          : undefined;
      if (desk === undefined) throw new HarnessError(400, INVALID_LINK);
      return desk.complete(input);
    }
    const pending = this.#auth.take(input.state);
    if (pending === null || typeof input.code !== "string" || input.code === "")
      throw new HarnessError(400, INVALID_LINK);
    let tokens: AtlassianTokens;
    try {
      const grant = await this.#auth.exchange(pending, input.code);
      tokens = {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresAt: grant.expiresAt,
        scope: grant.scope ?? "",
        cloudId: null,
        siteUrl: null,
        accountId: null,
        connectedAt: Date.now(),
        connectedBy: pending.by,
      };
    } catch (error) {
      this.#lastError = `échange du code refusé : ${messageOf(error)}`;
      throw new HarnessError(502, this.#lastError);
    }
    // Les jetons d'abord (le client MCP les lit), le site ensuite ; sans site, rien ne reste.
    this.#auth.save(tokens);
    this.#mcp.reset();
    try {
      const signal = new AbortController().signal;
      const resources = await this.#mcp.callTool("getAccessibleAtlassianResources", {}, signal);
      const site = resources.isError ? null : siteOf(resources.text);
      if (site === null) throw new Error("aucun site Jira ou Confluence accessible pour ce compte");
      const user = await this.#mcp.callTool("atlassianUserInfo", {}, signal);
      const accountId = user.isError ? null : accountOf(user.text);
      this.#auth.save({ ...(this.#auth.tokens() ?? tokens), cloudId: site.cloudId, siteUrl: site.url, accountId });
      this.#ctx.log(`${this.#name()} branché : ${site.url} (par ${pending.by})`);
    } catch (error) {
      this.#auth.forget();
      this.#mcp.reset();
      this.#lastError = `site Atlassian introuvable : ${messageOf(error)}`;
      throw new HarnessError(502, this.#lastError);
    }
    this.#lastError = null;
    this.#event("atlassian", { connected: true });
    return this.status();
  }

  /** Le retour collé dans l'app : l'adresse complète, qui porte `code` et `state`. */
  async completeFromUrl(raw: unknown): Promise<AtlassianStatus> {
    let url: URL;
    try {
      url = new URL(typeof raw === "string" ? raw.trim() : "");
    } catch {
      throw new HarnessError(400, INVALID_LINK);
    }
    return this.complete({ code: url.searchParams.get("code"), state: url.searchParams.get("state") });
  }

  /** Débranche : le fichier de jetons est supprimé. */
  disconnect(by: string): AtlassianStatus {
    const was = this.connected();
    this.#auth.forget();
    this.#mcp.reset();
    this.#lastError = null;
    if (was) {
      this.#ctx.log(`${this.#name()} débranché par ${by}`);
      this.#event("atlassian", { connected: false });
    }
    return this.status();
  }

  // -- les outils des agents et les écritures ------------------------------------------

  /** Un outil Atlassian d'un agent. Ne lève jamais : toute erreur rend `{ isError: true }`. */
  async runTool(
    name: string,
    args: Record<string, unknown>,
    opts: { by: string; writes: boolean },
    signal: AbortSignal,
  ): Promise<HostToolResult> {
    try {
      return await runAtlassianTool(this.#tools, name, args, opts, signal);
    } catch (error) {
      if (error instanceof AtlassianNotConnected) return { text: NOT_CONNECTED, isError: true };
      return { text: `${name} : ${messageOf(error)}`, isError: true };
    }
  }

  async #call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpToolResult> {
    const site = this.#site();
    if (site === null) throw new AtlassianNotConnected(NOT_CONNECTED);
    return this.#mcp.callTool(tool, { cloudId: site.cloudId, ...args }, signal);
  }

  #record(input: Omit<NewAtlassianWrite, "id">): AtlassianWrite {
    const write = this.#ctx.store.insertAtlassianWrite({ ...input, id: newId("aw"), space: this.space });
    this.#emit(write);
    return write;
  }

  #emit(write: AtlassianWrite): void {
    this.#event("atlassian_write", { id: write.id, state: write.state, kind: write.kind });
  }

  /** Les écritures d'un état de cette connexion, les plus récentes d'abord. */
  listWrites(state: AtlassianWriteState, limit: number): AtlassianWrite[] {
    return this.#ctx.store.listAtlassianWrites({ state, limit, space: this.space });
  }

  /** L'écriture proposée de CETTE connexion : celle d'une autre est inconnue ici (404). */
  #proposed(id: string): AtlassianWrite {
    const write = this.#ctx.store.getAtlassianWrite(id);
    if (!write || write.space !== this.space) throw new HarnessError(404, `écriture Atlassian inconnue : ${id}`);
    if (write.state !== "proposed" || this.#deciding.has(id))
      throw new HarnessError(409, `écriture ${id} déjà tranchée (${write.state})`);
    return write;
  }

  /**
   * Publie un commentaire proposé, avec le texte édité par l'humain s'il en donne un. 409 s'il
   * n'est plus proposé, ou si son ticket n'est plus dans les projets Jira de l'espace ; 502 si
   * Atlassian refuse (l'écriture passe `failed`, avec la raison).
   */
  async approve(id: string, input: Record<string, unknown>, by: string): Promise<AtlassianWrite> {
    const write = this.#proposed(id);
    const body = input.body === undefined ? write.body : planText(input.body, "body", 1, 4000);
    if (!this.connected()) throw new HarnessError(409, NOT_CONNECTED);
    const outside = outsideProjects(this.projects(), write.issueKey);
    if (outside !== null) throw new HarnessError(409, `${outside} — écarte ce commentaire`);
    this.#deciding.add(id);
    try {
      let result: McpToolResult;
      try {
        result = await this.#call(
          "addOrEditJiraIssueComment",
          { issueIdOrKey: write.issueKey, commentBody: body },
          new AbortController().signal,
        );
      } catch (error) {
        result = { text: error instanceof AtlassianNotConnected ? NOT_CONNECTED : messageOf(error), isError: true };
      }
      const error = result.isError ? (result.text.trim() || "refus sans raison").slice(0, 500) : null;
      const next = this.#ctx.store.updateAtlassianWriteIf(id, ["proposed"], {
        state: error === null ? "sent" : "failed",
        body,
        error,
        decidedBy: by,
      });
      if (!next) throw new HarnessError(409, `écriture ${id} déjà tranchée`);
      this.#emit(next);
      if (error !== null) throw new HarnessError(502, `Atlassian a refusé le commentaire : ${error}`);
      return next;
    } finally {
      this.#deciding.delete(id);
    }
  }

  /** Écarte un commentaire proposé : rien ne part. 409 s'il n'est plus proposé. */
  dismiss(id: string, by: string): AtlassianWrite {
    this.#proposed(id);
    const next = this.#ctx.store.updateAtlassianWriteIf(id, ["proposed"], { state: "dismissed", decidedBy: by });
    if (!next) throw new HarnessError(409, `écriture ${id} déjà tranchée`);
    this.#emit(next);
    return next;
  }

  // -- le plan du jour et le savoir ---------------------------------------------------------

  /**
   * Range un plan du jour (outil `atlassian_plan_write` du job `poste-plan`). 400 si invalide ;
   * une adresse non http(s) ou une clé illisible deviennent `null`. Le dépôt d'un élément est l'un de
   * ceux que cette connexion peut viser (`repos`) : la connexion d'un espace REFUSE (400) tout autre nom,
   * déclaré ou non — le ticket d'un client ne devient pas la demande d'un dépôt d'un autre ; la
   * connexion par défaut l'efface (`null`), comme un dépôt non déclaré.
   */
  savePlan(input: { summary: unknown; items: unknown; trigger: PlanTrigger }, by: string): AtlassianPlan {
    const summary = planText(input.summary, "summary", 1, 4000);
    if (!Array.isArray(input.items) || input.items.length > 30)
      throw new HarnessError(400, "items : liste de 0 à 30 éléments attendue");
    const allowed = this.repos();
    const items = input.items.map((item: unknown, index): PlanItem => {
      if (!isRecord(item)) throw new HarnessError(400, `items[${index}] : objet attendu`);
      const at = `items[${index}]`;
      const asked = item.source ?? "autre";
      const source = PLAN_SOURCES.find((known) => known === asked);
      if (source === undefined) throw new HarnessError(400, `${at}.source : ${PLAN_SOURCES.join(" | ")}`);
      const key = typeof item.key === "string" ? item.key.trim().toUpperCase() : "";
      const url = typeof item.url === "string" ? item.url.trim() : "";
      const named = typeof item.repo === "string" ? item.repo.trim() : "";
      const declared = named === "" ? null : (repoByName(this.#ctx.config, named)?.name ?? null);
      const repo = declared !== null && allowed.includes(declared) ? declared : null;
      if (repo === null && named !== "" && this.space !== null)
        throw new HarnessError(
          400,
          `${at}.repo : dépôt hors de l'espace — seuls ses dépôts peuvent porter une demande (${allowed.join(", ") || "aucun"}) ; sinon, omets \`repo\` et \`request\``,
        );
      const request = repo === null ? "" : planText(item.request, `${at}.request`, 0, 4000);
      return {
        title: planText(item.title, `${at}.title`, 1, 200),
        why: planText(item.why, `${at}.why`, 0, 500),
        next: planText(item.next, `${at}.next`, 0, 500),
        source,
        key: JIRA_KEY.test(key) ? key : null,
        url: /^https?:\/\/[^\s]+$/i.test(url) && URL.canParse(url) ? url : null,
        repo,
        request: request === "" ? null : request,
      };
    });
    const plan = this.#ctx.store.insertAtlassianPlan({
      id: newId("ap"),
      space: this.space,
      trigger: input.trigger,
      by,
      summary,
      items,
    });
    this.#event("atlassian_plan", { id: plan.id });
    return plan;
  }

  /** Le dernier plan de cette connexion. */
  latestPlan(): AtlassianPlan | null {
    return this.#ctx.store.latestAtlassianPlan(this.space);
  }

  lastPlanAt(): number | null {
    return this.latestPlan()?.createdAt ?? null;
  }

  /** Demande un plan au prochain tour (`poste-plan`) ; 409 si Atlassian n'est pas connecté. */
  requestPlan(by: string): void {
    if (!this.connected()) throw new HarnessError(409, NOT_CONNECTED);
    this.#planRequested = true;
    this.#ctx.log(`${this.#name()} : plan du jour demandé par ${by}`);
  }

  /** Lit ET efface la demande de plan. */
  takePlanRequest(): boolean {
    const asked = this.#planRequested;
    this.#planRequested = false;
    return asked;
  }

  /** Demande une passe de savoir au prochain tour (`poste-savoir`) ; 409 si Atlassian n'est pas connecté. */
  requestKnowledge(by: string): void {
    if (!this.connected()) throw new HarnessError(409, NOT_CONNECTED);
    this.#knowledgeRequested = true;
    this.#ctx.log(`${this.#name()} : passe de savoir demandée par ${by}`);
  }

  /** Lit ET efface la demande de passe de savoir. */
  takeKnowledgeRequest(): boolean {
    const asked = this.#knowledgeRequested;
    this.#knowledgeRequested = false;
    return asked;
  }

  /** Le réglage de la dernière passe de savoir de cette connexion. */
  #knowledgeKey(): string {
    return this.space === null ? KNOWLEDGE_SETTING : `${KNOWLEDGE_SETTING}:${this.space}`;
  }

  /** Le compte rendu d'une passe de savoir (réglage `atlassian.knowledge`, `atlassian.knowledge:<espaceId>`). */
  recordKnowledge(input: { summary: string; at: number }): void {
    this.#ctx.store.setSetting(
      this.#knowledgeKey(),
      { summary: input.summary.trim().slice(0, 4000), at: input.at },
      null,
    );
  }

  lastKnowledgeAt(): number | null {
    return this.#knowledge()?.at ?? null;
  }

  #knowledge(): { summary: string; at: number } | null {
    const value = this.#ctx.store.getSetting<{ summary?: unknown; at?: unknown }>(this.#knowledgeKey());
    if (value === null || typeof value.at !== "number") return null;
    return { summary: typeof value.summary === "string" ? value.summary : "", at: value.at };
  }
}

/** Un état d'écriture lu dans une requête (`?state=`), `proposed` par défaut. */
export function writeStateOf(raw: string | null): AtlassianWriteState {
  if (raw === null || raw === "") return "proposed";
  const state = ATLASSIAN_WRITE_STATES.find((known) => known === raw);
  if (state === undefined) throw new HarnessError(400, `state : ${ATLASSIAN_WRITE_STATES.join(" | ")}`);
  return state;
}
