// Les règles du navigateur du poste sur le VPS (`browserId: "vps"`), sans E/S : l'identité du
// navigateur, les domaines dont on importe les cookies, ce qu'un cookie importé doit respecter,
// l'état d'un compte, et ce qui, dans une adresse, dit « page de connexion ».
import { HarnessError } from "../errors.ts";
import { hostListed } from "../workstation-guards.ts";

/** L'identifiant du navigateur serveur dans le mécanisme multi-navigateurs du poste. */
export const VPS_BROWSER = "vps";
export const VPS_LABEL = "VPS (Obscura)";

/** Les seuls domaines dont l'approbateur peut ouvrir un import de cookies, ou démarrer une connexion. */
export const ACCOUNT_DOMAINS = ["slack.com", "google.com"] as const;
export type AccountDomain = (typeof ACCOUNT_DOMAINS)[number];

/** L'état d'un compte du navigateur `vps` : rien n'est dit de la session elle-même (ni cookie ni jeton). */
export const ACCOUNT_STATES = ["disconnected", "connected", "expired", "blocked"] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];
export type AccountView = { domain: AccountDomain; state: AccountState; changedAt: number | null };

/** Le domaine d'un compte : exactement `slack.com` ou `google.com` (casse ignorée), sinon `null`. */
export function accountDomain(raw: unknown): AccountDomain | null {
  if (typeof raw !== "string") return null;
  const domain = raw.trim().toLowerCase();
  return ACCOUNT_DOMAINS.find((entry) => entry === domain) ?? null;
}

/** Le compte d'un hôte : `app.slack.com` → `slack.com` ; `evil-slack.com` et `slack.com.evil.test` → `null`. */
export function accountOfHost(host: string): AccountDomain | null {
  const bare = host.toLowerCase();
  return ACCOUNT_DOMAINS.find((domain) => bare === domain || bare.endsWith(`.${domain}`)) ?? null;
}

/** Un cookie tel que `chrome.cookies` le décrit, réduit à ce que `Network.setCookies` consomme. */
export type CookieInput = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
};

const MAX_COOKIES = 300;
const MAX_COOKIE_TEXT = 4096;
const SAME_SITE: Record<string, CookieInput["sameSite"]> = {
  strict: "Strict",
  lax: "Lax",
  no_restriction: "None",
  none: "None",
  unspecified: undefined,
};

function bad(message: string): never {
  throw new HarnessError(400, message);
}

/**
 * Les cookies envoyés pour l'import de `domain` : chacun doit appartenir à ce domaine ou à l'un
 * de ses sous-domaines (jamais un autre, même au nom voisin), sinon tout l'envoi est refusé et
 * rien n'est posé. Les messages ne reprennent JAMAIS une valeur de cookie.
 */
export function parseCookies(domain: AccountDomain, raw: unknown): CookieInput[] {
  if (!Array.isArray(raw) || raw.length === 0) bad("cookies : liste non vide attendue");
  if (raw.length > MAX_COOKIES) bad(`cookies : ${MAX_COOKIES} au plus`);
  return raw.map((entry, index) => {
    const where = `cookies[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) bad(`${where} : objet attendu`);
    const cookie = entry as Record<string, unknown>;
    for (const key of ["name", "value", "domain", "path"] as const)
      if (typeof cookie[key] !== "string" || (cookie[key] as string).length > MAX_COOKIE_TEXT)
        bad(`${where}.${key} : chaîne de ${MAX_COOKIE_TEXT} caractères au plus attendue`);
    const name = cookie.name as string;
    const cookieDomain = (cookie.domain as string).replace(/^\./, "").toLowerCase();
    if (name === "") bad(`${where}.name : non vide`);
    if (accountOfHost(cookieDomain) !== domain) bad(`${where}.domain : hors du domaine de l'import (${domain})`);
    const result: CookieInput = {
      name,
      value: cookie.value as string,
      domain: (cookie.domain as string).startsWith(".") ? `.${cookieDomain}` : cookieDomain,
      path: (cookie.path as string) === "" ? "/" : (cookie.path as string),
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
    };
    const sameSite = typeof cookie.sameSite === "string" ? SAME_SITE[cookie.sameSite.toLowerCase()] : undefined;
    if (sameSite !== undefined) result.sameSite = sameSite;
    // Chrome : `expirationDate` en secondes (absent pour un cookie de session).
    if (typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate))
      result.expires = cookie.expirationDate;
    return result;
  });
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
