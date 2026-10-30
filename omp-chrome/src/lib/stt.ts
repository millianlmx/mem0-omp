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
 * L'adresse de l'oMLX normalisée (sans `/` ni `/v1` final), ou l'erreur qui la refuse :
 * l'audio brut ne quitte jamais le Mac, donc seule une adresse locale est acceptée. Le
 * tableau de bord d'oMLX copie la base OpenAI `http://127.0.0.1:8000/v1` ; les routes
 * (`/v1/…`) s'ajoutent ici à la racine, d'où le `/v1` retiré (sinon `/v1/v1/…` rend un
 * 404 qu'oMLX ne journalise même pas).
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
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return { ok: true, url: `${url.origin}${path}` };
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

/**
 * Vérifie, avant d'enregistrer un meeting, qu'oMLX répond à cette adresse, accepte la clé
 * et sert le modèle (`GET /v1/models`) ; lève une erreur française qui dit quoi corriger.
 * oMLX accepte aussi l'identifiant préfixé de l'organisation (`mlx-community/<modèle>`).
 */
export async function checkStt(settings: SttSettings, fetcher: typeof fetch = fetch): Promise<void> {
  const checked = validateSttUrl(settings.url);
  if (!checked.ok) throw new Error(`STT refusé : ${checked.error}`);
  const headers: Record<string, string> = {};
  if (settings.key.trim() !== "") headers.Authorization = `Bearer ${settings.key.trim()}`;
  let response: Response;
  try {
    response = await fetcher(`${checked.url}/v1/models`, { headers, signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`oMLX injoignable à ${checked.url} (${reason}) : est-il lancé ?`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`oMLX refuse la clé d'API (${response.status}) : recopiez celle de ses réglages`);
  }
  if (response.status === 404) {
    throw new Error(
      `pas d'API oMLX à ${checked.url} (404) : indiquez la racine du serveur, par exemple http://127.0.0.1:8000`,
    );
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`oMLX a répondu ${response.status}${detail ? ` : ${detail}` : ""}`);
  }
  const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
  const ids = Array.isArray(payload?.data)
    ? payload.data.flatMap((entry: unknown) =>
        typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string" ? [entry.id] : [],
      )
    : [];
  const model = settings.model.trim();
  if (ids.includes(model) || ids.includes(model.slice(model.lastIndexOf("/") + 1))) return;
  const whisper = ids.filter((id) => /whisper/i.test(id));
  const served = (whisper.length > 0 ? whisper : ids).slice(0, 8).join(", ");
  throw new Error(`oMLX ne sert pas le modèle « ${model} »${served ? ` ; modèles servis : ${served}` : ""}`);
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
