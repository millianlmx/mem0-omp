// Le flux d'événements du harness (`GET /v1/events`, Server-Sent Events) lu depuis le
// plugin : `harness_events` en lit le rejeu d'un coup, `/harness-follow` le tient ouvert.
//
// Une trame porte `id:` (le curseur de reprise, absent sur un éphémère), `event:` (le
// type) et `data:` (l'événement en JSON). Les commentaires `: ping` tiennent la connexion.
import { HarnessCallError } from "./harness.ts";
import type { HarnessTarget } from "./harness.ts";
import { isRecord } from "./wire.ts";

export type HarnessEvent = {
  /** Le curseur du journal ; `null` pour un éphémère (activité d'un runner). */
  id: number | null;
  type: string;
  at: number | null;
  runId: string | null;
  repo: string | null;
  payload: Record<string, unknown>;
};

export type EventsQuery = { run?: string; after?: number; live?: boolean };

/** Une trame SSE complète (sans sa ligne vide finale) → l'événement, ou `null` si illisible. */
export function parseFrame(frame: string): HarnessEvent | null {
  let id: number | null = null;
  let type = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = Number.isInteger(Number(value)) ? Number(value) : null;
    else if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const payload = isRecord(parsed.payload) ? parsed.payload : {};
  return {
    id,
    type: type !== "" ? type : typeof parsed.type === "string" ? parsed.type : "",
    at: typeof parsed.at === "number" ? parsed.at : null,
    runId: typeof parsed.runId === "string" ? parsed.runId : null,
    repo: typeof parsed.repo === "string" ? parsed.repo : null,
    payload,
  };
}

/** Découpe `buffer` en trames complètes ; le reste (trame incomplète) est rendu tel quel. */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  return { frames: parts.filter((part) => part.trim() !== ""), rest };
}

/** L'itérable des événements d'un corps de réponse SSE, jusqu'à sa fermeture ou l'abandon. */
async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<HarnessEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = splitFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        const event = parseFrame(frame);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type OpenedEvents = { status: number; events: AsyncIterable<HarnessEvent> };

/**
 * Ouvre le flux : résout dès les en-têtes reçus (le rejeu est alors déjà écrit par le
 * serveur). `after` devient `Last-Event-ID`. Lève une `HarnessCallError` si le serveur
 * refuse ou est injoignable.
 */
export async function openEvents(
  target: HarnessTarget,
  query: EventsQuery,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<OpenedEvents> {
  const fetcher = options.fetcher ?? fetch;
  const params = new URLSearchParams();
  if (query.run) params.set("run", query.run);
  if (query.live) params.set("live", "1");
  const search = params.toString();
  let response: Response;
  try {
    response = await fetcher(`${target.url}/v1/events${search ? `?${search}` : ""}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: "text/event-stream",
        ...(query.after !== undefined ? { "Last-Event-ID": String(query.after) } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    throw new HarnessCallError(
      `harness injoignable (${target.url}) : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok || response.body === null) {
    const payload: unknown = await response.json().catch(() => ({}));
    const error = isRecord(payload) && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new HarnessCallError(`harness : ${error}`, response.status);
  }
  return { status: response.status, events: readBody(response.body) };
}

/**
 * Le rejeu du journal, d'un coup : les événements déjà écrits, puis l'arrêt dès que le
 * serveur ne pousse plus rien pendant `idleMs` (il ne ferme jamais le flux lui-même).
 */
export async function readEvents(
  target: HarnessTarget,
  query: EventsQuery,
  options: { fetcher?: typeof fetch; idleMs?: number } = {},
): Promise<HarnessEvent[]> {
  const idleMs = options.idleMs ?? 400;
  const controller = new AbortController();
  const opened = await openEvents(target, query, { signal: controller.signal, fetcher: options.fetcher });
  const events: HarnessEvent[] = [];
  let timer = setTimeout(() => controller.abort(), idleMs);
  try {
    for await (const event of opened.events) {
      events.push(event);
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), idleMs);
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}
