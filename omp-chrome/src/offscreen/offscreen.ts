// Le document offscreen : il survit à l'endormissement du service worker et tient
// (1) le long-poll des actions `GET /v1/workstation/next?wait=25`, chaque action étant
// remise au service worker qui l'exécute et rend le résultat ;
// (2) la capture d'un meeting : audio de l'onglet (« autres », rejoué aux haut-parleurs)
// et micro (« moi ») enregistrés séparément en segments webm/opus autonomes de ~15 s,
// transcrits par oMLX en local, dont seul le texte part au harness.
//
// Un document offscreen n'a que `chrome.runtime` : la configuration lui vient du service
// worker (message `config`).

import { HarnessError, harnessCall } from "../lib/harness.ts";
import type { WorkstationAction } from "../lib/actions.ts";
import type { LinkState, OffscreenConfig, Reply, ToBackground, ToOffscreen } from "../lib/messages.ts";
import { transcribe } from "../lib/stt.ts";

const POLL_WAIT_S = 25;
const SEGMENT_MS = 15_000;
/** En dessous de ce niveau RMS de crête, le segment est un silence : il ne part pas à oMLX. */
const SILENCE_RMS = 0.01;

let config: OffscreenConfig | null = null;
let pollAbort: AbortController | null = null;
let wakeConfig: (() => void) | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function tell(message: ToBackground): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

// ── Long-poll des actions ─────────────────────────────────────────────────

let reported: { state: LinkState["state"]; detail: string; at: number } = { state: "connecting", detail: "", at: 0 };

/** Remonte l'état de la liaison au service worker, seulement s'il change (ou toutes les 5 min). */
function report(state: LinkState["state"], detail = ""): void {
  const now = Date.now();
  if (state === reported.state && detail === reported.detail && now - reported.at < 300_000) return;
  reported = { state, detail, at: now };
  void tell({ to: "background", type: "poll-state", state, detail });
}

async function pollLoop(): Promise<never> {
  let backoff = 0;
  for (;;) {
    const current = config;
    if (!current?.pairing) {
      report("unpaired");
      await new Promise<void>((resolve) => {
        wakeConfig = resolve;
      });
      continue;
    }
    const abort = new AbortController();
    pollAbort = abort;
    const timeout = setTimeout(() => abort.abort(), (POLL_WAIT_S + 15) * 1000);
    try {
      const reply = await harnessCall<{ action?: WorkstationAction }>(
        current.pairing,
        "GET",
        `/v1/workstation/next?wait=${POLL_WAIT_S}`,
        undefined,
        { headers: { "X-OMP-Extension": current.version }, signal: abort.signal },
      );
      backoff = 0;
      report("online");
      if (reply?.action) await tell({ to: "background", type: "execute", action: reply.action });
    } catch (error) {
      if (abort.signal.aborted && config !== current) continue; // appairage changé : on repart aussitôt
      if (error instanceof HarnessError && (error.status === 401 || error.status === 403)) {
        report("unauthorized", error.message);
        backoff = 60_000;
      } else if (error instanceof HarnessError && error.status === 409) {
        report("paused", error.message);
        backoff = 15_000;
      } else {
        report("offline", error instanceof Error ? error.message : String(error));
        backoff = Math.min(Math.max(backoff * 2, 2_000), 60_000);
      }
      await sleep(backoff);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Capture d'un meeting ──────────────────────────────────────────────────

type Speaker = "moi" | "autres";

type Lane = {
  speaker: Speaker;
  stream: MediaStream;
  recorder: MediaRecorder | null;
  timer: number | undefined;
  peak: number;
  meter: number | undefined;
};

type Capture = { meetingId: string; context: AudioContext; lanes: Lane[]; queue: Promise<void>; stopping: boolean };

let capture: Capture | null = null;

function mimeType(): string {
  return MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
}

/** Un segment terminé : transcrit en local, puis le texte (s'il y en a) part au harness. */
function enqueue(current: Capture, speaker: Speaker, at: number, audio: Blob, peak: number): void {
  if (audio.size === 0 || peak < SILENCE_RMS) return;
  current.queue = current.queue.then(async () => {
    const settings = config;
    if (!settings?.pairing) return;
    try {
      const text = await transcribe(settings.stt, audio, `segment-${speaker}-${at}.webm`);
      if (text === "") return;
      await harnessCall(
        settings.pairing,
        "POST",
        `/v1/workstation/meetings/${encodeURIComponent(current.meetingId)}/segments`,
        {
          segments: [{ at, speaker, text }],
        },
      );
    } catch (error) {
      void tell({
        to: "background",
        type: "meeting-error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/** Lance un enregistreur neuf : chaque segment est un fichier webm autonome (en-tête compris). */
function record(current: Capture, lane: Lane): void {
  if (current.stopping) return;
  const recorder = new MediaRecorder(lane.stream, { mimeType: mimeType() });
  const chunks: Blob[] = [];
  const at = Date.now();
  lane.peak = 0;
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => {
    const peak = lane.peak;
    record(current, lane);
    enqueue(current, lane.speaker, at, new Blob(chunks, { type: recorder.mimeType }), peak);
  };
  lane.recorder = recorder;
  recorder.start();
  lane.timer = setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, SEGMENT_MS);
}

function lane(context: AudioContext, stream: MediaStream, speaker: Speaker, playback: boolean): Lane {
  const source = context.createMediaStreamSource(stream);
  // Capturer l'onglet le rend muet : on le rejoue aux haut-parleurs.
  if (playback) source.connect(context.destination);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const result: Lane = { speaker, stream, recorder: null, timer: undefined, peak: 0, meter: undefined };
  result.meter = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    result.peak = Math.max(result.peak, Math.sqrt(sum / samples.length));
  }, 250);
  return result;
}

async function startCapture(streamId: string, meetingId: string): Promise<Reply<{ micro: "on" | "refused" }>> {
  if (capture !== null) return { ok: false, error: "une transcription est déjà en cours" };
  // Contraintes propres à Chrome pour un flux d'onglet (chrome.tabCapture.getMediaStreamId).
  const tabConstraints = {
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  } as unknown as MediaStreamConstraints;
  let tabStream: MediaStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia(tabConstraints);
  } catch (error) {
    return {
      ok: false,
      error: `capture de l'onglet impossible : ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let micro: "on" | "refused" = "on";
  let micStream: MediaStream | null = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    micro = "refused";
  }
  const context = new AudioContext();
  const lanes = [lane(context, tabStream, "autres", true)];
  if (micStream !== null) lanes.push(lane(context, micStream, "moi", false));
  const current: Capture = { meetingId, context, lanes, queue: Promise.resolve(), stopping: false };
  capture = current;
  for (const track of tabStream.getAudioTracks()) {
    track.addEventListener("ended", () => {
      void tell({ to: "background", type: "meeting-ended", reason: "l'onglet du meeting n'est plus capturé" });
    });
  }
  for (const each of lanes) record(current, each);
  return { ok: true, value: { micro } };
}

/** Arrête les enregistreurs, attend que les derniers segments soient transcrits et postés. */
async function stopCapture(): Promise<Reply> {
  const current = capture;
  if (current === null) return { ok: true, value: undefined };
  current.stopping = true;
  const stopped = current.lanes.map(
    (each) =>
      new Promise<void>((resolve) => {
        clearTimeout(each.timer);
        clearInterval(each.meter);
        const recorder = each.recorder;
        if (recorder === null || recorder.state === "inactive") {
          resolve();
          return;
        }
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      }),
  );
  await Promise.all(stopped);
  await current.queue;
  for (const each of current.lanes) for (const track of each.stream.getTracks()) track.stop();
  await current.context.close().catch(() => undefined);
  capture = null;
  return { ok: true, value: undefined };
}

// ── Messages ──────────────────────────────────────────────────────────────

function isToOffscreen(message: unknown): message is ToOffscreen {
  return typeof message === "object" && message !== null && "to" in message && message.to === "offscreen";
}

function applyConfig(next: OffscreenConfig): void {
  const previous = config;
  config = next;
  if (previous?.pairing?.url !== next.pairing?.url || previous?.pairing?.token !== next.pairing?.token) {
    pollAbort?.abort();
  }
  wakeConfig?.();
  wakeConfig = null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isToOffscreen(message)) return undefined;
  switch (message.type) {
    case "config":
      applyConfig(message.config);
      sendResponse({ ok: true, value: undefined });
      return undefined;
    case "capture-start":
      void startCapture(message.streamId, message.meetingId).then(sendResponse);
      return true;
    case "capture-stop":
      void stopCapture().then(sendResponse);
      return true;
  }
});

void (async () => {
  // Réponse du service worker de cette même extension (background.ts, message `offscreen-ready`).
  const ready = (await tell({ to: "background", type: "offscreen-ready" })) as Reply<OffscreenConfig> | undefined;
  if (ready?.ok) applyConfig(ready.value);
  await pollLoop();
})();
