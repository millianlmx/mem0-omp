// Les règles du navigateur du poste sur le VPS (`browserId: "vps"`), sans E/S : l'identité du
// navigateur, ce qu'un cookie du mirroir de Chrome doit respecter, l'état d'un compte, et ce
// qui, dans une adresse, dit « page de connexion ».
import { HarnessError } from "../errors.ts";
import { hostListed } from "../workstation-guards.ts";

/** L'identifiant du navigateur serveur dans le mécanisme multi-navigateurs du poste. */
export const VPS_BROWSER = "vps";
export const VPS_LABEL = "VPS (Obscura)";

/** Les comptes dont l'état est suivi, et les seuls domaines où une connexion interactive peut démarrer. */
export const ACCOUNT_DOMAINS = ["slack.com", "google.com"] as const;
export type AccountDomain = (typeof ACCOUNT_DOMAINS)[number];

/** L'état d'un compte du navigateur `vps` : rien n'est dit de la session elle-même (ni cookie ni jeton). */
export const ACCOUNT_STATES = ["disconnected", "connected", "expired", "blocked"] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];
export type AccountView = { domain: AccountDomain; state: AccountState; changedAt: number | null };

/** Le compte d'un hôte : `app.slack.com` → `slack.com` ; `evil-slack.com` et `slack.com.evil.test` → `null`. */
export function accountOfHost(host: string): AccountDomain | null {
  const bare = host.toLowerCase();
  return ACCOUNT_DOMAINS.find((domain) => bare === domain || bare.endsWith(`.${domain}`)) ?? null;
}

/** Un cookie posé par `Network.setCookies` : `url` pour un cookie host-only, `domain` sinon. */
export type MirrorCookie = {
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
} & ({ url: string } | { domain: string });

/** Un cookie disparu du Chrome de l'utilisateur, réduit à ce que `Network.deleteCookies` consomme. */
export type MirrorRemoval = { name: string; domain: string; path: string };

/** Les cookies et suppressions d'un seul envoi du mirroir. */
export const MAX_MIRROR_ENTRIES = 1000;
const MAX_COOKIE_TEXT = 4096;
const DOMAIN = /^\.?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
const SAME_SITE: Record<string, MirrorCookie["sameSite"]> = {
  strict: "Strict",
  lax: "Lax",
  no_restriction: "None",
  none: "None",
  unspecified: undefined,
};

function bad(message: string): never {
  throw new HarnessError(400, message);
}

function entries(raw: unknown, key: string): Record<string, unknown>[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) bad(`${key} : liste attendue`);
  if (raw.length > MAX_MIRROR_ENTRIES) bad(`${key} : ${MAX_MIRROR_ENTRIES} au plus par envoi`);
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) bad(`${key}[${index}] : objet attendu`);
    return entry as Record<string, unknown>;
  });
}

/** Le nom, le domaine (sans point, en minuscules) et le chemin d'un cookie, validés. */
function identity(cookie: Record<string, unknown>, where: string): { name: string; domain: string; path: string } {
  for (const key of ["name", "domain", "path"] as const)
    if (typeof cookie[key] !== "string" || (cookie[key] as string).length > MAX_COOKIE_TEXT)
      bad(`${where}.${key} : chaîne de ${MAX_COOKIE_TEXT} caractères au plus attendue`);
  const name = cookie.name as string;
  if (name === "") bad(`${where}.name : non vide`);
  const raw = (cookie.domain as string).toLowerCase();
  if (!DOMAIN.test(raw)) bad(`${where}.domain : nom d'hôte attendu`);
  const path = cookie.path as string;
  if (path !== "" && !path.startsWith("/")) bad(`${where}.path : chemin absolu attendu`);
  return { name, domain: raw.replace(/^\./, ""), path: path === "" ? "/" : path };
}

/**
 * Les cookies du mirroir, tels que `chrome.cookies` les décrit : TOUS les domaines du profil
 * sont acceptés (décision de l'utilisateur), seule la forme est contrôlée. Un cookie host-only
 * part avec `url` et sans `domain` : Obscura traite un `domain` explicite comme un cookie de
 * domaine et rejette alors en silence les `__Host-…`. Les messages ne reprennent JAMAIS une valeur.
 */
export function parseMirrorCookies(raw: unknown): MirrorCookie[] {
  return entries(raw, "set").map((cookie, index) => {
    const where = `set[${index}]`;
    const { name, domain, path } = identity(cookie, where);
    if (typeof cookie.value !== "string" || cookie.value.length > MAX_COOKIE_TEXT)
      bad(`${where}.value : chaîne de ${MAX_COOKIE_TEXT} caractères au plus attendue`);
    const secure = cookie.secure === true;
    const scope =
      cookie.hostOnly === true ? { url: `${secure ? "https" : "http"}://${domain}${path}` } : { domain: `.${domain}` };
    const result: MirrorCookie = {
      name,
      value: cookie.value,
      path,
      secure,
      httpOnly: cookie.httpOnly === true,
      ...scope,
    };
    const sameSite = typeof cookie.sameSite === "string" ? SAME_SITE[cookie.sameSite.toLowerCase()] : undefined;
    if (sameSite !== undefined) result.sameSite = sameSite;
    // Chrome : `expirationDate` en secondes, fractionnaire (absent pour un cookie de session).
    if (typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate))
      result.expires = Math.floor(cookie.expirationDate);
    return result;
  });
}

/** Les cookies disparus du Chrome de l'utilisateur : `{name, domain, path}`. */
export function parseMirrorRemovals(raw: unknown): MirrorRemoval[] {
  return entries(raw, "removed").map((cookie, index) => identity(cookie, `removed[${index}]`));
}

/** Une adresse de page de connexion : une session qui renvoie ici n'est plus ouverte. */
export function isLoginUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hostname === "accounts.google.com") return true;
  return /(^|\/)(signin|sign-in|sign_in|login|log-in|workspace-signin|ssb)(\/|$)/i.test(url.pathname);
}

/** La navigation d'une connexion interactive : les domaines des comptes et les hôtes listés par l'approbateur (l'IdP). */
export function loginNavigationAllowed(host: string, allowedHosts: readonly string[]): boolean {
  return accountOfHost(host) !== null || hostListed(host, allowedHosts);
}
