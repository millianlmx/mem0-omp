// Les clients du harness : qui appelle l'API, avec quels droits, sur quels dépôts.
//
// Un client est un NOM, un jeton (seule son empreinte SHA-256 est gardée), un rôle
// et la liste des dépôts qu'il voit :
// - `viewer`   lit (boîte, runs, flux) ;
// - `operator` lit, crée du travail et fait les gestes de la boucle humaine ;
// - `admin`    tout, plus la gestion des clients.
// Le jeton historique (`tokenFile`, `HARNESS_TOKEN`) reste le client `admin` sur tous
// les dépôts : le code d'appairage déjà distribué continue de marcher.
//
// Un client `approver` (admin sur tous les dépôts) est le seul qui approuve, refuse ou
// règle le poste de travail : le jeton du code d'appairage ordinaire est lisible par
// toute session omp du Mac (`~/.omp/harness.json`) et par l'extension, qui ne doivent
// pas pouvoir s'approuver elles-mêmes. Il ne se crée qu'en ligne de commande sur le
// serveur (`main.ts --add-client <nom> --approver`, `harness.sh approver`), jamais par
// l'API. Le jeton historique n'est jamais approbateur.
//
// Un client `pilot` (la vigie, vigie/) est un agent, pas un humain : operator, jamais
// approbateur, et la boucle humaine lui refuse en 403 les gestes réservés à l'humain
// (gestures.ts : geste irréversible, budget, escalades, envois du poste).
//
// Un client peut être borné à des ESPACES plutôt qu'à une liste de dépôts (`spaces`, exclusif d'une
// liste `repos`) : ses dépôts sont alors ceux de ces espaces, relus À CHAQUE lecture du registre — un
// dépôt ajouté à l'espace lui devient visible sans toucher au client. Pour tout le reste du service il
// est un client borné comme un autre (`repos` : une liste, jamais `"*"`) : jamais propriétaire — ni
// admin non plus : les routes d'administration (clients, fournisseurs, modèles) ne regardent que le
// rôle, et lui donneraient de quoi sortir de son espace. Sans résolveur branché (`useSpaces`), ou si
// l'espace n'existe plus, il ne voit rien.
//
// Le fichier (`clientsFile`, 0600) est relu à chaque changement de date : un client
// ajouté ou révoqué par la ligne de commande vaut tout de suite, sans redémarrage.
// Un fichier illisible (édité à la main, JSON cassé) ne casse pas l'API : le dernier
// jeu de clients lu reste en vigueur et l'erreur est journalisée une fois par version
// du fichier.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LogLine } from "./logger.ts";

export type Role = "viewer" | "operator" | "admin";

export const ROLES: readonly Role[] = ["viewer", "operator", "admin"];

/**
 * Un client tel que l'API le montre (jamais son jeton). `approver` : il tranche les envois du poste ;
 * `pilot` : un agent (la vigie), à qui les gestes réservés à l'humain sont refusés. `spaces` : les
 * espaces auxquels il est borné (leurs identifiants) — `repos` porte alors leurs dépôts du moment.
 */
export type Client = {
  name: string;
  role: Role;
  repos: string[] | "*";
  createdAt: number;
  approver: boolean;
  pilot: boolean;
  spaces?: string[];
};

/** Les dépôts d'une liste d'espaces (leurs identifiants), au moment de l'appel. */
export type SpaceRepos = (spaces: readonly string[]) => string[];

type StoredClient = Client & { tokenSha256: string };

type ClientsFile = { clients: StoredClient[] };

/** Le nom du client du jeton historique. */
export const LEGACY_CLIENT = "admin";

const LEGACY: Client = { name: LEGACY_CLIENT, role: "admin", repos: "*", createdAt: 0, approver: false, pilot: false };

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Le rôle `role` permet-il ce que `needed` exige ? (viewer < operator < admin) */
export function allows(role: Role, needed: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(needed);
}

/** Les dépôts qu'un client voit : `null` pour tous. */
export function repoFilter(client: Client): string[] | null {
  return client.repos === "*" ? null : client.repos;
}

export function canSeeRepo(client: Client, repo: string): boolean {
  return client.repos === "*" || client.repos.includes(repo);
}

export class ClientRegistry {
  readonly #file: string | null;
  readonly #legacy: Buffer | null;
  readonly #log: LogLine;
  #clients: StoredClient[] = [];
  /** L'erreur de lecture de la version courante du fichier (`null` : lue) : aucune écriture par-dessus. */
  #broken: string | null = null;
  /** La signature du fichier lu (date et taille) : relu dès qu'elle change. */
  #seen = "";
  /** D'où viennent les dépôts d'un client borné à des espaces ; sans lui, un tel client ne voit rien. */
  #spaceRepos: SpaceRepos = () => [];

  /**
   * `file` : le fichier des clients (`null` : seul le jeton historique) ; `legacyToken` : le
   * client `admin` ; `log` : où dire qu'un fichier illisible a été ignoré.
   */
  constructor(
    file: string | null,
    legacyToken: string | null = null,
    log: LogLine = (line) => console.error(`[omp-harness] ${line}`),
  ) {
    this.#file = file;
    this.#legacy = legacyToken ? digest(legacyToken) : null;
    this.#log = log;
    this.#reload();
  }

  /** Branche la lecture des espaces (`SpaceDesk.reposOf`) : les dépôts d'un client borné à des espaces en viennent. */
  useSpaces(resolve: SpaceRepos): void {
    this.#spaceRepos = resolve;
  }

  /**
   * Le client tel que le service le lit. Borné à des espaces, ses dépôts sont ceux de ces espaces
   * MAINTENANT — quoi que dise son `repos` enregistré, jamais `"*"` — et il n'est jamais admin
   * (un fichier édité à la main qui le dirait le rend operator).
   */
  #public(client: StoredClient): Client {
    const { spaces } = client;
    return {
      name: client.name,
      role: spaces !== undefined && client.role === "admin" ? "operator" : client.role,
      repos: spaces === undefined ? client.repos : this.#spaceRepos(spaces),
      createdAt: client.createdAt,
      approver: client.approver,
      pilot: client.pilot,
      ...(spaces === undefined ? {} : { spaces }),
    };
  }

  #reload(): void {
    if (this.#file === null) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.#file);
    } catch {
      this.#clients = [];
      this.#seen = "";
      this.#broken = null;
      return;
    }
    const seen = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    if (seen === this.#seen) return;
    // Cette version du fichier est jugée une fois : lue, ou ignorée (et dite) jusqu'à la suivante.
    this.#seen = seen;
    let parsed: Partial<ClientsFile>;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#file, "utf8")) as Partial<ClientsFile>;
      if (parsed === null || typeof parsed !== "object") throw new Error("la racine doit être un objet");
    } catch (err) {
      this.#broken = err instanceof Error ? err.message : String(err);
      this.#log(
        `clients : ${this.#file} illisible, ${this.#clients.length} client(s) de la dernière lecture gardé(s) — ${this.#broken}`,
        { level: "error" },
      );
      return;
    }
    this.#broken = null;
    this.#clients = Array.isArray(parsed.clients)
      ? parsed.clients
          .filter(
            (entry) =>
              typeof entry?.name === "string" &&
              typeof entry.tokenSha256 === "string" &&
              /^[0-9a-f]{64}$/.test(entry.tokenSha256) &&
              ROLES.includes(entry.role),
          )
          // Un fichier d'avant les approbateurs (ou les pilotes) : aucun client ne l'est. `spaces` présent
          // mais illisible : aucun espace (le client ne voit rien), jamais le repli sur `repos`.
          .map(({ spaces, ...entry }) => ({
            ...entry,
            approver: entry.approver === true,
            pilot: entry.pilot === true,
            ...(spaces === undefined
              ? {}
              : { spaces: Array.isArray(spaces) ? spaces.filter((id) => typeof id === "string") : [] }),
          }))
      : [];
  }

  /** Relu, et réécrivable : réécrire un fichier illisible effacerait les clients qu'il déclare. */
  #reloadForWrite(): void {
    this.#reload();
    if (this.#broken !== null) throw new Error(`${this.#file} illisible, corrige-le d'abord : ${this.#broken}`);
  }

  #write(): void {
    if (this.#file === null) throw new Error("aucun fichier de clients configuré (clientsFile)");
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ clients: this.#clients } satisfies ClientsFile, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temp, this.#file);
    this.#seen = "";
    this.#reload();
  }

  /** Le client d'un jeton, ou `null`. Comparaison en temps constant sur les empreintes. */
  authenticate(token: string): Client | null {
    if (token === "") return null;
    this.#reload();
    const given = digest(token);
    let found: Client | null = null;
    if (this.#legacy && timingSafeEqual(given, this.#legacy)) found = { ...LEGACY };
    for (const client of this.#clients) {
      // Pas de sortie anticipée : chaque empreinte est comparée.
      if (timingSafeEqual(given, Buffer.from(client.tokenSha256, "hex")) && found === null)
        found = this.#public(client);
    }
    return found;
  }

  list(): Client[] {
    this.#reload();
    return [...(this.#legacy ? [{ ...LEGACY }] : []), ...this.#clients.map((client) => this.#public(client))];
  }

  /**
   * Crée un client et rend son jeton, montré UNE fois (seule son empreinte est gardée).
   * `approver` : réservé à la ligne de commande du serveur, admin sur tous les dépôts.
   * `pilot` : un agent (la vigie), operator ou viewer, jamais approbateur.
   * `spaces` : les identifiants des espaces auxquels il est borné, à la place d'une liste de dépôts
   * (`repos` vaut alors `"*"` : les deux bornes ne se combinent pas) ; ni admin ni approbateur.
   */
  add(
    name: string,
    role: Role,
    repos: string[] | "*",
    approver = false,
    pilot = false,
    spaces: string[] | null = null,
  ): { client: Client; token: string } {
    this.#reloadForWrite();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name))
      throw new Error(`nom de client invalide : ${name} (lettres, chiffres, . _ -)`);
    if (name === LEGACY_CLIENT || this.#clients.some((client) => client.name === name))
      throw new Error(`client déjà déclaré : ${name}`);
    if (!ROLES.includes(role)) throw new Error(`rôle inconnu : ${role} (${ROLES.join(" | ")})`);
    if (repos !== "*" && (repos.length === 0 || repos.some((repo) => !/^[a-z0-9][a-z0-9._-]*$/i.test(repo))))
      throw new Error("repos : « * » ou une liste de noms de dépôts");
    if (approver && (role !== "admin" || repos !== "*"))
      throw new Error("un approbateur est admin sur tous les dépôts");
    if (pilot && (approver || role === "admin"))
      throw new Error("un client pilote n'est ni admin ni approbateur : c'est un agent, pas l'humain");
    if (spaces !== null && (spaces.length === 0 || spaces.some((id) => !/^[\w.-]+$/.test(id))))
      throw new Error("spaces : une liste d'identifiants d'espaces");
    if (spaces !== null && repos !== "*")
      throw new Error("spaces et repos : un client est borné à des espaces OU à des dépôts, pas aux deux");
    if (spaces !== null && role === "admin")
      throw new Error(
        "un client borné à des espaces n'est ni admin ni approbateur : l'administration du serveur reste au propriétaire",
      );
    const token = randomBytes(32).toString("hex");
    const client: StoredClient = {
      name,
      role,
      // Borné à des espaces : aucun dépôt enregistré (une version d'avant les espaces ne lui montrerait rien).
      repos: spaces === null ? repos : [],
      createdAt: Date.now(),
      approver,
      pilot,
      ...(spaces === null ? {} : { spaces: [...new Set(spaces)] }),
      tokenSha256: digest(token).toString("hex"),
    };
    this.#clients = [...this.#clients, client];
    this.#write();
    return { client: this.#public(client), token };
  }

  /** Révoque un client : son jeton cesse de valoir à la requête suivante. */
  revoke(name: string): boolean {
    this.#reloadForWrite();
    const before = this.#clients.length;
    this.#clients = this.#clients.filter((client) => client.name !== name);
    if (this.#clients.length === before) return false;
    this.#write();
    return true;
  }
}
