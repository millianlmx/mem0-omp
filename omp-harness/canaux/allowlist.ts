// La liste blanche EXACTE des points d'API des canaux : la seule source. Aucun point
// d'envoi n'y figure (Google n'a pas de scope « brouillons seulement » : `gmail.compose`
// permet aussi l'envoi, d'où cette garde côté serveur). Une entrée = méthode + hôte +
// chemin complet + canal propriétaire ; `{id}` couvre exactement un segment.
//
// Règle du canal (toute entrée, sous-features comprises) : `gmail.googleapis.com` →
// `gmail` ; `www.googleapis.com` sous `/calendar/v3/` → `calendar` ; `slack.com` sous
// `/api/` → `slack` ; les deux points de jeton → `null` (échange et renouvellement de
// leur connexion seulement, jamais par `Channels.request`).
import { ChannelRefused } from "./errors.ts";

export type ChannelId = "gmail" | "calendar" | "slack";
export type Method = "GET" | "POST" | "PUT" | "DELETE";

export type Entry = { method: Method; host: string; path: string; channel: ChannelId | null };

export const ALLOWLIST: readonly Entry[] = [
  { method: "POST", host: "oauth2.googleapis.com", path: "/token", channel: null },
  { method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/profile", channel: "gmail" },
  { method: "POST", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/drafts", channel: "gmail" },
  { method: "PUT", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/drafts/{id}", channel: "gmail" },
  { method: "DELETE", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/drafts/{id}", channel: "gmail" },
  { method: "GET", host: "www.googleapis.com", path: "/calendar/v3/calendars/primary", channel: "calendar" },
  { method: "POST", host: "slack.com", path: "/api/oauth.v2.access", channel: null },
  { method: "GET", host: "slack.com", path: "/api/auth.test", channel: "slack" },
];

const SEGMENT = "[A-Za-z0-9_-]+";

const PATTERNS = ALLOWLIST.map((entry) => ({
  entry,
  path: new RegExp(`^${entry.path.split("{id}").map(escapeRegex).join(SEGMENT)}$`),
}));

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * L'entrée de la liste blanche qui couvre (méthode, URL), ou `ChannelRefused` : schéma autre
 * que https, port explicite, identifiants, chemin à double barre, `..`, `%2F` ou `%5C`, point
 * prolongé, méthode autre que celle de l'entrée, hôte inconnu, `/batch/…` et `/upload/…`.
 * Le contrôle porte sur le texte reçu (pas sur l'URL normalisée, qui masquerait un port ou un `..`).
 */
export function allowed(method: string, url: string): Entry {
  const refuse = (what: string): never => {
    throw new ChannelRefused(`point d'API hors liste blanche : ${method} ${what}`);
  };
  const match = /^https:\/\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/.exec(url);
  if (!match) return refuse("URL non https ou illisible");
  const host = match[1] as string;
  const path = match[2] ?? "/";
  if (/[:@]/.test(host)) return refuse(`${host.replace(/^.*@/, "")}${path}`);
  if (path.includes("//") || path.includes("..") || path.includes("\\") || /%2f|%5c/i.test(path))
    return refuse(`${host}${path}`);
  if (path.startsWith("/batch/") || path.startsWith("/upload/")) return refuse(`${host}${path}`);
  const found = PATTERNS.find((p) => p.entry.method === method && p.entry.host === host && p.path.test(path));
  if (!found) return refuse(`${host}${path}`);
  return found.entry;
}

/** Refuse un point permis mais d'un autre canal que celui qui l'appelle (`null` : points de jeton). */
export function ownedBy(entry: Entry, channel: ChannelId): void {
  if (entry.channel !== channel)
    throw new ChannelRefused(
      `point d'API d'un autre canal : ${entry.method} ${entry.host}${entry.path} n'est pas un point de ${channel}`,
    );
}
