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
// Le fichier (`clientsFile`, 0600) est relu à chaque changement de date : un client
// ajouté ou révoqué par la ligne de commande vaut tout de suite, sans redémarrage.
// Un fichier illisible (édité à la main, JSON cassé) ne casse pas l'API : le dernier
// jeu de clients lu reste en vigueur et l'erreur est journalisée une fois par version
// du fichier.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type Role = "viewer" | "operator" | "admin";

export const ROLES: readonly Role[] = ["viewer", "operator", "admin"];

/** Un client tel que l'API le montre (jamais son jeton). `approver` : il tranche les envois du poste. */
export type Client = { name: string; role: Role; repos: string[] | "*"; createdAt: number; approver: boolean };

type StoredClient = Client & { tokenSha256: string };

type ClientsFile = { clients: StoredClient[] };

/** Le nom du client du jeton historique. */
export const LEGACY_CLIENT = "admin";

const LEGACY: Client = { name: LEGACY_CLIENT, role: "admin", repos: "*", createdAt: 0, approver: false };

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
  readonly #log: (line: string) => void;
  #clients: StoredClient[] = [];
  /** L'erreur de lecture de la version courante du fichier (`null` : lue) : aucune écriture par-dessus. */
  #broken: string | null = null;
  /** La signature du fichier lu (date et taille) : relu dès qu'elle change. */
  #seen = "";

  /**
   * `file` : le fichier des clients (`null` : seul le jeton historique) ; `legacyToken` : le
   * client `admin` ; `log` : où dire qu'un fichier illisible a été ignoré.
   */
  constructor(
    file: string | null,
    legacyToken: string | null = null,
    log: (line: string) => void = (line) => console.error(`[omp-harness] ${line}`),
  ) {
    this.#file = file;
    this.#legacy = legacyToken ? digest(legacyToken) : null;
    this.#log = log;
    this.#reload();
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
          // Un fichier d'avant les approbateurs : aucun client ne l'est.
          .map((entry) => ({ ...entry, approver: entry.approver === true }))
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
      if (timingSafeEqual(given, Buffer.from(client.tokenSha256, "hex")) && found === null) found = publicOf(client);
    }
    return found;
  }

  list(): Client[] {
    this.#reload();
    return [...(this.#legacy ? [{ ...LEGACY }] : []), ...this.#clients.map(publicOf)];
  }

  /**
   * Crée un client et rend son jeton, montré UNE fois (seule son empreinte est gardée).
   * `approver` : réservé à la ligne de commande du serveur, admin sur tous les dépôts.
   */
  add(name: string, role: Role, repos: string[] | "*", approver = false): { client: Client; token: string } {
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
    const token = randomBytes(32).toString("hex");
    const client: StoredClient = {
      name,
      role,
      repos,
      createdAt: Date.now(),
      approver,
      tokenSha256: digest(token).toString("hex"),
    };
    this.#clients = [...this.#clients, client];
    this.#write();
    return { client: publicOf(client), token };
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

function publicOf(client: StoredClient): Client {
  return {
    name: client.name,
    role: client.role,
    repos: client.repos,
    createdAt: client.createdAt,
    approver: client.approver,
  };
}
