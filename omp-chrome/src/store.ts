// Lecture et écriture des réglages (`chrome.storage.local`, clé `settings`), partagées par
// le service worker, le popup et la page d'options ; et l'envoi d'un message au service
// worker avec sa réponse typée.

import type { Reply, Settings, ToBackground } from "./lib/messages.ts";
import { DEFAULT_STT } from "./lib/stt.ts";

const SETTINGS = "settings";

export const DEFAULT_SETTINGS: Settings = { pairing: null, stt: DEFAULT_STT, excluded: [], observationPaused: false };

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(SETTINGS))[SETTINGS];
  // Écrit par saveSettings seulement : la forme est celle de Settings, champs neufs absents compris.
  const saved = (typeof stored === "object" && stored !== null ? stored : {}) as Partial<Settings>;
  return {
    pairing: saved.pairing ?? null,
    stt: { ...DEFAULT_STT, ...saved.stt },
    excluded: Array.isArray(saved.excluded) ? saved.excluded : [],
    observationPaused: saved.observationPaused === true,
  };
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
