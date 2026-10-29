// La page d'options : appairage (code `omp1:`), transcription locale (oMLX), sites exclus,
// autorisation du micro, et l'état lisible de l'extension.

import { element } from "../dom.ts";
import { harnessCall } from "../lib/harness.ts";
import type { PopupStatus } from "../lib/messages.ts";
import { decodePairing } from "../lib/pairing.ts";
import { validateSttUrl } from "../lib/stt.ts";
import { parseExcludedSites } from "../lib/url.ts";
import { ask, loadSettings, saveSettings } from "../store.ts";

const pairingCode = element("pairing-code", HTMLTextAreaElement);
const pairingCurrent = element("pairing-current", HTMLParagraphElement);
const sttUrl = element("stt-url", HTMLInputElement);
const sttKey = element("stt-key", HTMLInputElement);
const sttModel = element("stt-model", HTMLInputElement);
const excluded = element("excluded", HTMLTextAreaElement);

function say(id: string, text: string, kind: "error" | "success" | "" = ""): void {
  const target = element(id, HTMLParagraphElement);
  target.textContent = text;
  target.className = `message ${kind}`;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STATE_TITLES: Record<string, string> = {
  unpaired: "Non appairée : collez le code d'appairage ci-dessous.",
  connecting: "Connexion au serveur…",
  online: "En ligne : l'extension reçoit les actions du serveur.",
  offline: "Hors ligne : le serveur est injoignable.",
  unauthorized: "Jeton refusé : collez un code d'appairage neuf.",
  paused: "En pause depuis OMP Console : aucune action ne part, l'observation est refusée.",
};

async function renderState(): Promise<void> {
  const reply = await ask<PopupStatus>({ to: "background", type: "status" });
  const stateEl = element("state", HTMLDivElement);
  if (!reply.ok) {
    stateEl.className = "state offline";
    stateEl.textContent = `Extension indisponible : ${reply.error}`;
    return;
  }
  const status = reply.value;
  const state = status.serverPaused === true ? "paused" : status.link.state;
  stateEl.className = `state ${state}`;
  stateEl.textContent = STATE_TITLES[state] ?? state;
  const parts = [
    status.observationPaused ? "Observation en pause sur ce navigateur." : "Observation active.",
    status.meeting ? `Transcription en cours : « ${status.meeting.title} ».` : "",
    status.link.detail && (state === "offline" || state === "unauthorized") ? `Détail : ${status.link.detail}` : "",
  ];
  element("state-detail", HTMLParagraphElement).textContent = parts.filter(Boolean).join(" ");
  element("version", HTMLSpanElement).textContent = `v${status.version}`;
}

async function renderSettings(): Promise<void> {
  const settings = await loadSettings();
  pairingCurrent.textContent = settings.pairing
    ? `Appairée avec ${settings.pairing.url}.`
    : "Non appairée : collez le code que donne harness.sh pair sur le serveur.";
  sttUrl.value = settings.stt.url;
  sttKey.value = settings.stt.key;
  sttModel.value = settings.stt.model;
  excluded.value = settings.excluded.join("\n");
}

async function changed(): Promise<void> {
  await ask({ to: "background", type: "settings-changed" });
  await renderSettings();
  await renderState();
}

element("pair", HTMLButtonElement).addEventListener("click", () => {
  const pairing = decodePairing(pairingCode.value);
  if (pairing === null) {
    say("pairing-message", "Code illisible : attendu omp1: suivi du code que donne harness.sh pair.", "error");
    return;
  }
  if ("refusal" in pairing) {
    say("pairing-message", `Code refusé : ${pairing.refusal}.`, "error");
    return;
  }
  void (async () => {
    await saveSettings({ pairing: { url: pairing.url, token: pairing.token } });
    pairingCode.value = "";
    say("pairing-message", `Appairée avec ${pairing.url}.`, "success");
    await changed();
  })();
});

element("unpair", HTMLButtonElement).addEventListener("click", () => {
  void (async () => {
    await saveSettings({ pairing: null });
    say("pairing-message", "Appairage oublié : l'extension n'observe plus et ne reçoit plus d'actions.", "success");
    await changed();
  })();
});

element("test", HTMLButtonElement).addEventListener("click", () => {
  void (async () => {
    const { pairing } = await loadSettings();
    if (pairing === null) {
      say("pairing-message", "Aucun appairage à tester.", "error");
      return;
    }
    say("pairing-message", "Test en cours…");
    try {
      const status = await harnessCall<{ online?: unknown; paused?: unknown; autonomy?: { effective?: unknown } }>(
        pairing,
        "GET",
        "/v1/workstation",
        undefined,
        { signal: AbortSignal.timeout(10_000) },
      );
      const autonomy = typeof status?.autonomy?.effective === "string" ? status.autonomy.effective : "inconnue";
      say(
        "pairing-message",
        `Serveur joint. Autonomie appliquée : ${autonomy}.${status?.paused === true ? " Le poste est en pause." : ""}`,
        "success",
      );
    } catch (error) {
      say("pairing-message", `Échec : ${errorText(error)}`, "error");
    }
    await renderState();
  })();
});

element("stt-save", HTMLButtonElement).addEventListener("click", () => {
  const checked = validateSttUrl(sttUrl.value);
  if (!checked.ok) {
    say("stt-message", `Adresse refusée : ${checked.error}.`, "error");
    return;
  }
  const model = sttModel.value.trim();
  if (model === "") {
    say("stt-message", "Le modèle est requis (celui que sert oMLX pour la transcription).", "error");
    return;
  }
  void (async () => {
    await saveSettings({ stt: { url: checked.url, key: sttKey.value.trim(), model } });
    say("stt-message", "Transcription enregistrée.", "success");
    await changed();
  })();
});

element("micro", HTMLButtonElement).addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("micro/micro.html") });
});

element("excluded-save", HTMLButtonElement).addEventListener("click", () => {
  const sites = parseExcludedSites(excluded.value);
  void (async () => {
    await saveSettings({ excluded: sites });
    say("excluded-message", sites.length === 0 ? "Aucun site exclu." : `${sites.length} site(s) exclu(s).`, "success");
    await changed();
  })();
});

void renderSettings().then(renderState);
