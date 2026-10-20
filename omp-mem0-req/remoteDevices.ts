// L'appairage et le registre des appareils du protocole distant du VPS (S-2).
//
// Calqué sur `PairingCode.swift` et `DeviceRegistry.swift` du Mac, à UNE
// différence près : le Mac range les jetons dans le trousseau, le VPS n'en a pas.
// Le registre `<état>/remote/devices.json` ne porte donc que l'EMPREINTE sha256
// du jeton — le jeton en clair n'est rendu qu'une fois, à l'appareil qui s'appaire,
// et n'est JAMAIS écrit.
//
// Module SANS `Bun` (tests sous `node --test`) et SANS horloge implicite : `now`
// est injectable, un test fait expirer ou verrouiller un code sans dormir.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";


/** Le fichier du registre, relatif à `<état>` (S-2). */
export const DEVICES_FILE_RELATIVE = path.join("remote", "devices.json");

export const DEVICES_FILE_VERSION = 1;

/** Crockford base32 sans `I` `L` `O` `U` : 32 symboles (`ConsoleAPI.Service`). */
export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 120_000;
/** Le code se verrouille au-delà de ce nombre d'échecs : le 6e le ferme. */
export const PAIRING_ATTEMPT_LIMIT = 5;

/** Bornes de `name` et de `deviceKey` d'un appairage (`RemoteRouter.pair`). */
export const DEVICE_NAME_MAX = 64;

export function devicesFilePath(stateDir: string): string {
  return path.join(stateDir, DEVICES_FILE_RELATIVE);
}


// --- le code d'appairage ------------------------------------------------------

/** Les séparateurs ignorés d'un code saisi : blancs et tous les tirets (`PairingCodeFormat`). */
const CODE_SEPARATORS = /[\s\u002D\u2010\u2011\u2012\u2013\u2014\u2212]/gu;

/** Un code saisi, ramené à sa forme canonique : sans séparateurs, majuscules, `I`/`L` → `1`, `O` → `0`. */
export function normalizePairingCode(raw: string): string {
  return raw
    .replace(CODE_SEPARATORS, "")
    .toUpperCase()
    .replace(/[IL]/gu, "1")
    .replace(/O/gu, "0");
}

/** Un code normalisé est bien formé : exactement 8 symboles de l'alphabet. */
export function isWellFormedPairingCode(normalized: string): boolean {
  if (normalized.length !== PAIRING_CODE_LENGTH) return false;
  for (const symbol of normalized) if (!PAIRING_CODE_ALPHABET.includes(symbol)) return false;
  return true;
}

/** `XXXX-XXXX` : le groupement qui rend le code lisible à voix haute. */
export function groupPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Le verdict d'une tentative : indiscernables pour le client, distincts ici. */
export type PairingOutcome = "paired" | "refused" | "locked" | "expired";

type ActiveCode = { value: string; expiresAtMs: number; failedAttempts: number };

/** Le code actif (ou aucun) et son compteur d'échecs ; il ne vit qu'en mémoire. */
export class PairingState {
  private active: ActiveCode | null = null;

  /** Un code neuf REMPLACE l'ancien et remet le compteur à zéro (seul déverrouillage). */
  generate(nowMs: number): { code: string; expiresAtMs: number } {
    let value = "";
    for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
      value += PAIRING_CODE_ALPHABET[crypto.randomInt(PAIRING_CODE_ALPHABET.length)];
    }
    const expiresAtMs = nowMs + PAIRING_CODE_TTL_MS;
    this.active = { value, expiresAtMs, failedAttempts: 0 };
    return { code: value, expiresAtMs };
  }

  /** Une tentative : un succès CONSOMME le code ; un échec compte, au-delà du seuil le code se verrouille. */
  attempt(presented: string, nowMs: number): PairingOutcome {
    const code = this.active;
    if (code === null) return "refused";
    if (code.failedAttempts > PAIRING_ATTEMPT_LIMIT) return "refused";
    if (nowMs >= code.expiresAtMs) return "expired";
    if (constantTimeEqual(presented, code.value)) {
      this.active = null;
      return "paired";
    }
    code.failedAttempts += 1;
    return code.failedAttempts > PAIRING_ATTEMPT_LIMIT ? "locked" : "refused";
  }
}

/** Égalité de deux chaînes en temps constant (longueurs différentes ⇒ faux, sans fuite du contenu). */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}


// --- le registre --------------------------------------------------------------

/** Un appareil appairé — jamais son jeton, ni son empreinte. */
export type DeviceRecord = {
  id: string;
  name: string;
  /** L'identité de l'installation cliente : un réappairage de la même clé remplace la ligne. */
  deviceKey?: string;
  pairedAtMs: number;
  lastSeenAtMs: number;
};

type StoredDevice = DeviceRecord & { tokenSha256: string };

/** Une ligne du flux `devices` et de `GET /v1/devices`. */
export type DeviceRow = {
  id: string;
  name: string;
  pairedAtMs: number;
  lastSeenAtMs: number;
  connected: boolean;
};

export type DeviceRegistryErrorKind = "unavailable" | "unauthorized";

/** Un refus du registre : `unavailable` (fichier illisible) ou `unauthorized` (code faux, expiré, verrouillé). */
export class DeviceRegistryError extends Error {
  readonly kind: DeviceRegistryErrorKind;

  constructor(kind: DeviceRegistryErrorKind, message: string) {
    super(message);
    this.name = "DeviceRegistryError";
    this.kind = kind;
  }
}

function sha256Hex(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** 32 octets aléatoires en base64url sans remplissage : 43 caractères. */
function newDeviceToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function asStoredDevice(raw: unknown): StoredDevice | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "") return null;
  if (typeof row.name !== "string") return null;
  if (typeof row.pairedAtMs !== "number" || !Number.isFinite(row.pairedAtMs)) return null;
  if (typeof row.lastSeenAtMs !== "number" || !Number.isFinite(row.lastSeenAtMs)) return null;
  if (typeof row.tokenSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(row.tokenSha256)) return null;
  if (row.deviceKey !== undefined && typeof row.deviceKey !== "string") return null;
  const device: StoredDevice = {
    id: row.id,
    name: row.name,
    pairedAtMs: row.pairedAtMs,
    lastSeenAtMs: row.lastSeenAtMs,
    tokenSha256: row.tokenSha256,
  };
  if (row.deviceKey !== undefined) device.deviceKey = row.deviceKey;
  return device;
}

export type DeviceRegistryOptions = {
  /** `<état>/remote/devices.json`. */
  file: string;
  now?: () => number;
};

export class DeviceRegistry {
  /** Appelé par `revoke`/un réappairage AVANT de rendre la main : il coupe les flux de l'appareil. */
  revokeHandler: ((id: string) => void) | null = null;
  /** Appelé quand ce que le flux `devices` publie change. */
  changeHandler: (() => void) | null = null;

  private devices: StoredDevice[] = [];
  private loadError: string | null = null;
  private readonly pairing = new PairingState();
  private readonly connected = new Set<string>();
  private lastSavedMinute: number | null = null;
  private readonly file: string;
  private readonly now: () => number;

  constructor(options: DeviceRegistryOptions) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
  }

  /**
   * Lit le fichier. Absent ⇒ registre vide. ILLISIBLE ⇒ registre vide et une raison :
   * le service refuse alors d'appairer et d'authentifier, et n'écrase JAMAIS le
   * fichier (le seul `persist` d'un registre en panne est refusé).
   */
  load(): void {
    this.loadError = null;
    this.devices = [];
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      this.loadError = `fichier illisible (${path.basename(this.file)})`;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object") throw new Error("forme");
      const file = parsed as Record<string, unknown>;
      if (file.version !== DEVICES_FILE_VERSION || !Array.isArray(file.devices)) throw new Error("forme");
      const devices: StoredDevice[] = [];
      for (const raw of file.devices) {
        const device = asStoredDevice(raw);
        if (device === null) throw new Error("ligne");
        devices.push(device);
      }
      this.devices = devices.sort((a, b) => b.pairedAtMs - a.pairedAtMs);
    } catch {
      this.loadError = `fichier illisible (${path.basename(this.file)})`;
    }
  }

  /** La raison d'un registre en panne (illisible, écriture impossible), ou `null`. */
  get unavailableReason(): string | null {
    return this.loadError === null ? null : `Le registre des appareils est illisible : ${this.loadError}`;
  }

  /** Génère un code neuf. Un registre en panne refuse de générer. */
  generateCode(): { code: string; expiresAtMs: number } {
    this.requireReadable();
    return this.pairing.generate(this.now());
  }

  /**
   * Présente un code : succès ⇒ l'appareil inscrit, son jeton (rendu UNE fois) et le
   * code consommé. Tout refus est un `unauthorized` indiscernable. Avec une
   * `deviceKey`, les lignes de la MÊME clé sont remplacées : leur jeton est refusé
   * dès cet instant et leurs flux fermés. Si le fichier ne peut être écrit, rien ne change.
   */
  pair(presented: string, name: string, deviceKey: string | undefined): { device: DeviceRecord; token: string } {
    this.requireReadable();
    const nowMs = this.now();
    if (this.pairing.attempt(presented, nowMs) !== "paired") {
      throw new DeviceRegistryError("unauthorized", "code d'appairage refusé");
    }
    const token = newDeviceToken();
    const stored: StoredDevice = {
      id: crypto.randomUUID(),
      name,
      pairedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      tokenSha256: sha256Hex(token),
    };
    if (deviceKey !== undefined) stored.deviceKey = deviceKey;
    const replaced = deviceKey === undefined ? [] : this.devices.filter(d => d.deviceKey === deviceKey).map(d => d.id);
    const next = [stored, ...this.devices.filter(d => !replaced.includes(d.id))];
    if (!this.persist(next)) throw new DeviceRegistryError("unavailable", this.unavailableReason ?? "écriture impossible");
    this.devices = next;
    for (const id of replaced) this.connected.delete(id);
    this.changeHandler?.();
    for (const id of replaced) this.revokeHandler?.(id);
    return { device: publicRecord(stored), token };
  }

  /**
   * L'appareil d'un jeton, ou `null`. Les empreintes sont comparées en temps
   * constant, et TOUTES les lignes sont parcourues : la durée ne dit pas où le jeton tombe.
   */
  authenticate(token: string): DeviceRecord | null {
    const presented = Buffer.from(sha256Hex(token), "hex");
    let match: StoredDevice | null = null;
    for (const device of this.devices) {
      if (crypto.timingSafeEqual(presented, Buffer.from(device.tokenSha256, "hex"))) match = device;
    }
    return match === null ? null : publicRecord(match);
  }

  /** La dernière activité, en mémoire ; le fichier n'est réécrit que quand la minute change. */
  touch(id: string): void {
    const device = this.devices.find(d => d.id === id);
    if (device === undefined) return;
    const nowMs = this.now();
    device.lastSeenAtMs = nowMs;
    const minute = Math.floor(nowMs / 60_000);
    if (minute !== this.lastSavedMinute) {
      this.lastSavedMinute = minute;
      this.persist(this.devices);
    }
    this.changeHandler?.();
  }

  markConnected(id: string, isConnected: boolean): void {
    if (isConnected) this.connected.add(id);
    else this.connected.delete(id);
    this.changeHandler?.();
  }

  list(): DeviceRow[] {
    return this.devices.map(d => ({
      id: d.id,
      name: d.name,
      pairedAtMs: d.pairedAtMs,
      lastSeenAtMs: d.lastSeenAtMs,
      connected: this.connected.has(d.id),
    }));
  }

  /** Révoque : jeton, ligne du fichier, PUIS les flux ouverts. `false` pour un appareil inconnu. */
  revoke(id: string): boolean {
    if (!this.devices.some(d => d.id === id)) return false;
    this.devices = this.devices.filter(d => d.id !== id);
    this.connected.delete(id);
    this.persist(this.devices);
    this.changeHandler?.();
    this.revokeHandler?.(id);
    return true;
  }

  private requireReadable(): void {
    const reason = this.unavailableReason;
    if (reason !== null) throw new DeviceRegistryError("unavailable", reason);
  }

  /**
   * Écrit le registre (0600, dossier 0700) : temporaire voisin créé en 0600, puis
   * `rename`. Un registre déjà en panne n'est JAMAIS écrit. Un échec met le registre
   * en panne : les appels suivants répondent 503 plutôt que de mentir.
   */
  private persist(devices: StoredDevice[]): boolean {
    if (this.loadError !== null) return false;
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const payload = { version: DEVICES_FILE_VERSION, devices };
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, this.file);
      fs.chmodSync(this.file, 0o600);
      return true;
    } catch {
      fs.rmSync(tmp, { force: true });
      this.loadError = `écriture impossible (${path.basename(this.file)})`;
      return false;
    }
  }
}

function publicRecord(device: StoredDevice): DeviceRecord {
  const record: DeviceRecord = {
    id: device.id,
    name: device.name,
    pairedAtMs: device.pairedAtMs,
    lastSeenAtMs: device.lastSeenAtMs,
  };
  if (device.deviceKey !== undefined) record.deviceKey = device.deviceKey;
  return record;
}
