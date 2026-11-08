// Lecture et écriture des réglages (`chrome.storage.local`, clé `settings`), partagées par
// le service worker, le popup et la page d'options ; et l'envoi d'un message au service
// worker avec sa réponse typée.

import type { HarnessTarget } from "./lib/harness.ts";
import type { Reply, Settings, ToBackground } from "./lib/messages.ts";
import { DEFAULT_STT } from "./lib/stt.ts";

const SETTINGS = "settings";
/** L'identifiant de ce navigateur, hors des réglages : un ré-appairage ne le change pas. */
const BROWSER_ID = "browserId";

export const DEFAULT_SETTINGS: Settings = {
  pairing: null,
  stt: DEFAULT_STT,
  excluded: [],
  observationPaused: false,
  browserLabel: "",
};

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(SETTINGS))[SETTINGS];
  // Écrit par saveSettings seulement : la forme est celle de Settings, champs neufs absents compris.
  const saved = (typeof stored === "object" && stored !== null ? stored : {}) as Partial<Settings>;
  return {
    pairing: saved.pairing ?? null,
    stt: { ...DEFAULT_STT, ...saved.stt },
    excluded: Array.isArray(saved.excluded) ? saved.excluded : [],
    observationPaused: saved.observationPaused === true,
    browserLabel: typeof saved.browserLabel === "string" ? saved.browserLabel : "",
  };
}

/** L'identifiant stable de ce navigateur (ce profil Chrome) : créé une fois, gardé dans chrome.storage.local. */
export async function browserId(): Promise<string> {
  const stored = (await chrome.storage.local.get(BROWSER_ID))[BROWSER_ID];
  if (typeof stored === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(stored)) return stored;
  const created = crypto.randomUUID();
  await chrome.storage.local.set({ [BROWSER_ID]: created });
  return created;
}

/** La cible du harness pour les appels de ce navigateur : l'appairage, présenté avec l'identité du navigateur. */
export async function identified(pairing: HarnessTarget, label: string): Promise<HarnessTarget> {
  return { ...pairing, browser: { id: await browserId(), label } };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS]: next });
  return next;
}

/** Envoie au service worker ; une absence de réponse devient une erreur française. */
export async function ask<T>(message: ToBackground): Promise<Reply<T>> {
  try {
    // Réponse du service worker de cette extension (background.ts), toujours une Reply.
    const reply = (await chrome.runtime.sendMessage(message)) as Reply<T> | undefined;
    return reply ?? { ok: false, error: "le service worker n'a pas répondu" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
