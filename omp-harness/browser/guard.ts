// Le pré-contrôle du harness avant qu'une page ne soit ouverte : l'adresse demandée (et ses
// adresses résolues) puis l'URL finale d'une navigation. Il ne voit PAS les sous-ressources
// d'une page : l'autorité pour chaque requête est la garde intégrée de Moli
// (`--block-private-networks`, appliquée à l'adresse de chaque connexion directe), que le
// service `moli` active ; l'adresse publique de l'hôte relève de la règle pare-feu du README.
// Ce que ce module ajoute : le message clair, et le refus du tailnet même quand
// `allowPrivateNetwork` est levé.
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export type AddressCategory = "public" | "loopback" | "private" | "link-local" | "ula" | "unspecified" | "tailnet";

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

export type Lookup = (host: string, options: { all: true; verbatim: true }) => Promise<{ address: string }[]>;

/** Un pré-contrôle refusé : `reason` cite l'hôte de la page, c'est un contenu non fiable. */
export class GuardRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "GuardRefusal";
    this.reason = reason;
  }
}

const LABELS: Record<Exclude<AddressCategory, "public">, string> = {
  loopback: "boucle locale",
  private: "réseau privé",
  "link-local": "link-local",
  ula: "adresse locale IPv6",
  unspecified: "adresse non spécifiée",
  tailnet: "tailnet",
};

const LOOKUP_MS = 3000;

function ipv4Category([a, b]: number[]): AddressCategory {
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && (b as number) >= 16 && (b as number) <= 31) || (a === 192 && b === 168))
    return "private";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && (b as number) >= 64 && (b as number) <= 127) return "tailnet";
  return "public";
}

/** Les huit groupes de 16 bits d'une adresse IPv6 (forme `::` et queue IPv4 comprises). */
function ipv6Groups(ip: string): number[] {
  let text = ip.split("%")[0] as string;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [, a, b, c, d] = tail.map(Number) as [number, number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array.from({ length: fill }, () => "0"), ...right].map((group) => Number.parseInt(group, 16));
}

/** La catégorie d'une adresse IP (littéral IPv4 ou IPv6). */
export function addressCategory(ip: string): AddressCategory {
  if (isIP(ip) === 4) return ipv4Category(ip.split(".").map(Number));
  const g = ipv6Groups(ip) as [number, number, number, number, number, number, number, number];
  if (g.every((group) => group === 0)) return "unspecified";
  if (g.slice(0, 7).every((group) => group === 0) && g[7] === 1) return "loopback";
  if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff)
    return ipv4Category([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
  if (g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0) return "tailnet";
  if ((g[0] & 0xfe00) === 0xfc00) return "ula";
  return "public";
}

function verdictFor(
  host: string,
  address: string | null,
  category: AddressCategory,
  allowPrivate: boolean,
): GuardVerdict {
  if (category === "public") return { ok: true };
  if (allowPrivate && category !== "tailnet" && category !== "unspecified") return { ok: true };
  return { ok: false, reason: `${host}${address === null ? "" : ` → ${address}`} : ${LABELS[category]}` };
}

async function resolve(host: string, lookup: Lookup): Promise<string[] | null> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), LOOKUP_MS);
  });
  try {
    const found = await Promise.race([lookup(host, { all: true, verbatim: true }), expired]);
    return found === null || found.length === 0 ? null : found.map((entry) => entry.address);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Refuse une URL qui vise le tailnet ou (sauf `allowPrivateNetwork`) un réseau local ou privé. */
export async function checkUrl(
  raw: string,
  options: { allowPrivateNetwork: boolean; lookup?: Lookup },
): Promise<GuardVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "URL illisible" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, reason: `schéma refusé (${url.protocol.slice(0, -1)})` };
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const allow = options.allowPrivateNetwork;
  if (host === "localhost" || host.endsWith(".localhost")) return verdictFor(host, null, "loopback", allow);
  if (host.endsWith(".ts.net")) return verdictFor(host, null, "tailnet", allow);
  if (isIP(host) !== 0) return verdictFor(host, host, addressCategory(host), allow);
  const addresses = await resolve(host, options.lookup ?? ((name, opts) => dnsLookup(name, opts)));
  if (addresses === null) return { ok: false, reason: `hôte introuvable : ${host}` };
  for (const address of addresses) {
    const verdict = verdictFor(host, address, addressCategory(address), allow);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}
