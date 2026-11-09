// La réponse de l'extension à un import de cookies : l'appareil approbateur ouvre, côté serveur,
// l'import d'UN domaine (slack.com ou google.com) ; l'extension lit alors les cookies de ce
// domaine dans le Chrome de l'utilisateur (`chrome.cookies`) et les envoie UNE fois au harness
// (TLS du tailnet), qui les pose dans le navigateur du poste sur le VPS. Sans import ouvert,
// elle ne lit ni n'envoie aucun cookie. Les valeurs ne sont ni journalisées ni gardées ici.

import type { HarnessTarget } from "./harness.ts";
import { harnessCall } from "./harness.ts";

/** Un cookie tel que `chrome.cookies.getAll` le rend (ce qui sert à l'import). */
export type ChromeCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expirationDate?: number;
};

export type CookieSource = { getAll(filter: { domain: string }): Promise<ChromeCookie[]> };

/** Le domaine d'un import ouvert, ou `null` ; le nombre de cookies envoyés sinon. */
export async function answerCookieImport(
  target: HarnessTarget,
  source: CookieSource,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<{ domain: string; sent: number } | null> {
  const status = await harnessCall<{ open: { domain: string } | null }>(
    target,
    "GET",
    "/v1/workstation/vps/cookie-import",
    undefined,
    options,
  );
  const domain = status?.open?.domain;
  if (typeof domain !== "string") return null;
  const cookies = (await source.getAll({ domain })).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
  }));
  if (cookies.length === 0) return { domain, sent: 0 };
  await harnessCall(target, "POST", "/v1/workstation/vps/cookies", { domain, cookies }, options);
  return { domain, sent: cookies.length };
}
