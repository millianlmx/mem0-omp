// Faux serveur OpenAI-compatible du contrat boîte noire mem0-http (spec S-2).
//
// Remplace oMLX pendant le contrat : embeddings DÉTERMINISTES de 1024 dimensions
// (sac de mots haché par sha256, identique d'un processus à l'autre) et réponses
// chat SCRIPTÉES, choisies par un marqueur `[script:<nom>]` présent dans les
// messages. Écoute sur 127.0.0.1 seulement ; aucun état partagé hors compteurs.
import { createHash } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export const DIMENSIONS = 1024;

/** Réponses chat scriptées, par nom de marqueur `[script:<nom>]`. */
export const SCRIPTS_CHAT: Readonly<Record<string, string>> = Object.freeze({
  "deux-faits":
    '{"memory":[{"id":"0","text":"Le dépôt cible bash 3.2"},{"id":"1","text":"La CI tourne sur ubuntu-latest"}]}',
  vide: '{"memory":[]}',
});

/**
 * Embedding déterministe : chaque jeton (lettres et chiffres Unicode, minuscules ;
 * `_` sépare) ajoute 1 à la composante `sha256(jeton)[0..4] % 1024`, puis le
 * vecteur est normalisé en L2. Sans jeton, c'est le vecteur unitaire e0.
 */
export function plonger(texte: string): number[] {
  const vecteur = new Array<number>(DIMENSIONS).fill(0);
  const jetons = texte.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const jeton of jetons) {
    vecteur[createHash("sha256").update(jeton, "utf8").digest().readUInt32BE(0) % DIMENSIONS] += 1;
  }
  if (jetons.length === 0) vecteur[0] = 1;
  const norme = Math.hypot(...vecteur);
  return vecteur.map((composante) => composante / norme);
}

export type FauxOpenAI = {
  url: string;
  compteurs(): { embeddings: number; chat: number };
  fermer(): Promise<void>;
};

class RequeteInvalide extends Error {}

function repondre(res: http.ServerResponse, statut: number, corps: unknown): void {
  const texte = JSON.stringify(corps);
  res.writeHead(statut, { "content-type": "application/json", "content-length": Buffer.byteLength(texte) });
  res.end(texte);
}

function erreur(message: string): unknown {
  return { error: { message, type: "invalid_request_error" } };
}

function lireJson(texte: string): Record<string, unknown> {
  let valeur: unknown;
  try {
    valeur = JSON.parse(texte);
  } catch {
    throw new RequeteInvalide("faux OpenAI : corps JSON illisible");
  }
  if (valeur === null || typeof valeur !== "object" || Array.isArray(valeur)) {
    throw new RequeteInvalide("faux OpenAI : corps JSON non objet");
  }
  return valeur as Record<string, unknown>;
}

function embeddings(corps: Record<string, unknown>): unknown {
  const { input, model, encoding_format: format } = corps;
  if (format === "base64") throw new RequeteInvalide("faux OpenAI : encoding_format base64 non pris en charge");
  const textes = typeof input === "string" ? [input] : input;
  if (!Array.isArray(textes) || !textes.every((t) => typeof t === "string")) {
    throw new RequeteInvalide("faux OpenAI : input absent ou d'un type invalide (attendu string | string[])");
  }
  return {
    object: "list",
    data: textes.map((texte: string, index) => ({ object: "embedding", index, embedding: plonger(texte) })),
    model: typeof model === "string" ? model : "",
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

function chat(corps: Record<string, unknown>, numero: number): unknown {
  const { messages, model } = corps;
  if (!Array.isArray(messages)) throw new RequeteInvalide("faux OpenAI : messages absent (attendu un tableau)");
  const texte = messages
    .map((m: unknown) => (m !== null && typeof m === "object" && "content" in m ? m.content : undefined))
    .filter((c): c is string => typeof c === "string")
    .join("\n");
  const noms = [...new Set([...texte.matchAll(/\[script:([a-z0-9-]+)\]/g)].map((m) => m[1]))];
  let contenu = '{"memory":[]}';
  if (noms.length > 0) {
    if (noms.length > 1 || !Object.hasOwn(SCRIPTS_CHAT, noms[0])) {
      throw new RequeteInvalide(`faux OpenAI : marqueur de script inconnu ou ambigu (${noms.join(", ")})`);
    }
    contenu = SCRIPTS_CHAT[noms[0]];
  }
  return {
    id: `chatcmpl-contrat-${numero}`,
    object: "chat.completion",
    created: 0,
    model: typeof model === "string" ? model : "",
    choices: [{ index: 0, message: { role: "assistant", content: contenu }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Démarre le faux serveur sur 127.0.0.1:<port> (0 = port libre). Un port
 * indisponible rejette avec `faux OpenAI : port <p> indisponible`.
 */
export function demarrerFauxOpenAI(options: { port?: number } = {}): Promise<FauxOpenAI> {
  const port = options.port ?? 0;
  const compteurs = { embeddings: 0, chat: 0 };
  const serveur = http.createServer((req, res) => {
    const morceaux: Buffer[] = [];
    req.on("data", (morceau: Buffer) => morceaux.push(morceau));
    req.on("end", () => {
      const chemin = (req.url ?? "").split("?")[0];
      const route = `${req.method} ${chemin}`;
      try {
        if (route === "POST /v1/embeddings") {
          compteurs.embeddings += 1;
          repondre(res, 200, embeddings(lireJson(Buffer.concat(morceaux).toString("utf8"))));
        } else if (route === "POST /v1/chat/completions") {
          compteurs.chat += 1;
          repondre(res, 200, chat(lireJson(Buffer.concat(morceaux).toString("utf8")), compteurs.chat));
        } else {
          repondre(res, 404, erreur(`faux OpenAI : route inconnue ${route}`));
        }
      } catch (e) {
        if (!(e instanceof RequeteInvalide)) throw e;
        repondre(res, 400, erreur(e.message));
      }
    });
  });
  const { promise, resolve, reject } = Promise.withResolvers<FauxOpenAI>();
  serveur.once("error", () => reject(new Error(`faux OpenAI : port ${port} indisponible`)));
  serveur.listen(port, "127.0.0.1", () => {
    const { port: effectif } = serveur.address() as AddressInfo; // écoute TCP : jamais un chemin de socket
    resolve({
      url: `http://127.0.0.1:${effectif}/v1`,
      compteurs: () => ({ ...compteurs }),
      fermer: () => {
        const fin = Promise.withResolvers<void>();
        serveur.closeAllConnections();
        serveur.close(() => fin.resolve());
        return fin.promise;
      },
    });
  });
  return promise;
}
