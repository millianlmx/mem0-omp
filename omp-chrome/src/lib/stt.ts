// La transcription locale : chaque segment audio (webm/opus autonome) part à oMLX sur le
// Mac (`POST {sttUrl}/v1/audio/transcriptions`, multipart OpenAI-compatible : file,
// model, response_format=json), jamais ailleurs. Seul le texte rendu quitte ensuite le
// navigateur, vers le harness.

export type SttSettings = { url: string; key: string; model: string };

export const DEFAULT_STT: SttSettings = {
  url: "http://127.0.0.1:8000",
  key: "",
  model: "mlx-community/whisper-large-v3-turbo",
};

/** Hôtes où l'audio brut peut aller : la machine elle-même, rien d'autre. */
const LOOPBACK: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };

/**
 * L'adresse de l'oMLX normalisée (sans `/` final), ou l'erreur qui la refuse : l'audio
 * brut ne quitte jamais le Mac, donc seule une adresse locale est acceptée.
 */
export function validateSttUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "adresse illisible (exemple : http://127.0.0.1:8000)" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "adresse http(s) attendue" };
  }
  if (LOOPBACK[url.hostname.toLowerCase()] !== true) {
    return {
      ok: false,
      error: `l'audio ne quitte jamais le Mac : ${url.hostname} n'est pas une adresse locale (127.0.0.1, localhost)`,
    };
  }
  return { ok: true, url: `${url.origin}${url.pathname}`.replace(/\/+$/, "") };
}

/** La requête multipart d'un segment. */
export function transcriptionRequest(
  settings: SttSettings,
  audio: Blob,
  filename: string,
): { url: string; init: { method: "POST"; headers: Record<string, string>; body: FormData } } {
  const checked = validateSttUrl(settings.url);
  if (!checked.ok) throw new Error(`STT refusé : ${checked.error}`);
  const body = new FormData();
  body.append("file", audio, filename);
  body.append("model", settings.model);
  body.append("response_format", "json");
  const headers: Record<string, string> = {};
  if (settings.key.trim() !== "") headers.Authorization = `Bearer ${settings.key.trim()}`;
  return { url: `${checked.url}/v1/audio/transcriptions`, init: { method: "POST", headers, body } };
}

/** Le texte d'un segment (`""` si rien n'a été dit) ; une réponse non 2xx lève une erreur française. */
export async function transcribe(
  settings: SttSettings,
  audio: Blob,
  filename: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const { url, init } = transcriptionRequest(settings, audio, filename);
  const response = await fetcher(url, init);
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`oMLX a répondu ${response.status}${detail ? ` : ${detail}` : ""}`);
  }
  const payload = (await response.json()) as { text?: unknown };
  return typeof payload.text === "string" ? payload.text.trim() : "";
}
