// Faux serveur OpenAI-compatible du contrat boîte noire mem0-http (spec S-2 ;
// scripts et enregistrement des requêtes : spec S-6 de mem0-rs-extraction-llm).
//
// Remplace oMLX pendant le contrat : embeddings DÉTERMINISTES de 1024 dimensions
// (sac de mots haché par sha256, identique d'un processus à l'autre) et réponses
// chat SCRIPTÉES, choisies par le DERNIER marqueur `[script:<nom>]` du dernier
// message `user`. Écoute sur 127.0.0.1 seulement ; il garde les compteurs et la
// copie des requêtes reçues, que les cas comparent entre les deux cibles.
import { createHash } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export const DIMENSIONS = 1024;

/** Valeurs posées dans l'environnement du serveur à tester (contrat.ts). */
export const MODELE_CHAT = "contrat-chat";
export const MODELE_EMBEDDINGS = "contrat-embed";
export const JETON_OPENAI = "contrat-faux-openai";

/** Réponse scriptée : un `content` chat rendu en 200, ou un statut d'erreur. */
export type ScriptChat = { readonly contenu: string } | { readonly statut: number };

/** Réponses chat scriptées, par nom de marqueur `[script:<nom>]`. */
export const SCRIPTS_CHAT: Readonly<Record<string, ScriptChat>> = Object.freeze({
  "deux-faits": {
    contenu:
      '{"memory":[{"id":"0","text":"Le dépôt cible bash 3.2","attributed_to":"user"},{"id":"1","text":"La CI tourne sur ubuntu-latest"}]}',
  },
  vide: { contenu: '{"memory":[]}' },
  "non-json": { contenu: "Pas de JSON dans cette réponse." },
  "sans-memoire": { contenu: '{"faits":[{"text":"Fait ignoré"}]}' },
  "element-sans-texte": { contenu: '{"memory":[{"nope":1}]}' },
  "memoire-chaine": { contenu: '{"memory":"Le dépôt cible bash 3.2"}' },
  doublon: { contenu: '{"memory":[{"text":"Le dépôt cible bash 3.2"},{"text":"Fait inédit du doublon"}]}' },
  "double-interne": { contenu: '{"memory":[{"text":"Fait répété"},{"text":"Fait répété"},{"text":"Fait unique"}]}' },
  balises: { contenu: '```json\n<think>raisonnement</think>{"memory":[{"text":"Fait balisé"}]}\n```' },
  "erreur-500": { statut: 500 },
});

/** Une requête chat/completions reçue (y compris celles rendues en 400 ou 500). */
export type RequeteChat = {
  /** Corps JSON reçu ; `null` s'il est illisible. */
  corps: unknown;
  /** En-tête `authorization`, ou `null`. */
  autorisation: string | null;
  /** Date UTC `AAAA-MM-JJ` à la réception. */
  jour: string;
};

/** Une requête embeddings rendue en 200, `input` normalisé en liste. */
export type RequeteEmbeddings = { entrees: string[] };

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
  /** Copies de toutes les requêtes chat reçues, dans l'ordre de réception. */
  requetesChat(): RequeteChat[];
  /** Copies des requêtes embeddings rendues en 200, dans l'ordre de réception. */
  requetesEmbeddings(): RequeteEmbeddings[];
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

function embeddings(corps: Record<string, unknown>): { reponse: unknown; entrees: string[] } {
  const { input, model, encoding_format: format } = corps;
  if (format === "base64") throw new RequeteInvalide("faux OpenAI : encoding_format base64 non pris en charge");
  const textes = typeof input === "string" ? [input] : input;
  if (!Array.isArray(textes) || !textes.every((t) => typeof t === "string")) {
    throw new RequeteInvalide("faux OpenAI : input absent ou d'un type invalide (attendu string | string[])");
  }
  return {
    reponse: {
      object: "list",
      data: textes.map((texte: string, index) => ({ object: "embedding", index, embedding: plonger(texte) })),
      model: typeof model === "string" ? model : "",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    },
    entrees: textes,
  };
}

/**
 * Script désigné par la DERNIÈRE occurrence du marqueur dans le `content` chaîne
 * du DERNIER message `user` : l'invite d'extraction recopie les messages
 * précédents du scope (« Last k Messages ») avant « New Messages ».
 */
function scriptDe(messages: readonly unknown[]): ScriptChat {
  const dernier = messages.findLast(
    (m): m is { role: unknown; content?: unknown } => m !== null && typeof m === "object" && "role" in m && m.role === "user",
  );
  const contenu = dernier?.content;
  const marqueurs = typeof contenu === "string" ? [...contenu.matchAll(/\[script:([a-z0-9-]+)\]/g)] : [];
  const nom = marqueurs.at(-1)?.[1];
  if (nom === undefined) return { contenu: '{"memory":[]}' };
  if (!Object.hasOwn(SCRIPTS_CHAT, nom)) throw new RequeteInvalide(`faux OpenAI : marqueur de script inconnu (${nom})`);
  return SCRIPTS_CHAT[nom];
}

function chat(corps: Record<string, unknown>, numero: number): { statut: number; reponse: unknown } {
  const { messages, model } = corps;
  if (!Array.isArray(messages)) throw new RequeteInvalide("faux OpenAI : messages absent (attendu un tableau)");
  const script = scriptDe(messages);
  if ("statut" in script) {
    return { statut: script.statut, reponse: { error: { message: "faux OpenAI : erreur scriptée", type: "server_error" } } };
  }
  return {
    statut: 200,
    reponse: {
      id: `chatcmpl-contrat-${numero}`,
      object: "chat.completion",
      created: 0,
      model: typeof model === "string" ? model : "",
      choices: [{ index: 0, message: { role: "assistant", content: script.contenu }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  };
}

/** Corps JSON d'une requête chat tel qu'enregistré : `null` s'il est illisible. */
function corpsBrut(texte: string): unknown {
  try {
    return JSON.parse(texte);
  } catch {
    return null;
  }
}

/**
 * Démarre le faux serveur sur 127.0.0.1:<port> (0 = port libre). Un port
 * indisponible rejette avec `faux OpenAI : port <p> indisponible`.
 */
export function demarrerFauxOpenAI(options: { port?: number } = {}): Promise<FauxOpenAI> {
  const port = options.port ?? 0;
  const compteurs = { embeddings: 0, chat: 0 };
  const requetesChat: RequeteChat[] = [];
  const requetesEmbeddings: RequeteEmbeddings[] = [];
  const serveur = http.createServer((req, res) => {
    const morceaux: Buffer[] = [];
    req.on("data", (morceau: Buffer) => morceaux.push(morceau));
    req.on("end", () => {
      const chemin = (req.url ?? "").split("?")[0];
      const route = `${req.method} ${chemin}`;
      const texte = Buffer.concat(morceaux).toString("utf8");
      try {
        if (route === "POST /v1/embeddings") {
          compteurs.embeddings += 1;
          const { reponse, entrees } = embeddings(lireJson(texte));
          requetesEmbeddings.push({ entrees });
          repondre(res, 200, reponse);
        } else if (route === "POST /v1/chat/completions") {
          compteurs.chat += 1;
          requetesChat.push({
            corps: corpsBrut(texte),
            autorisation: req.headers.authorization ?? null,
            jour: new Date().toISOString().slice(0, 10),
          });
          const { statut, reponse } = chat(lireJson(texte), compteurs.chat);
          repondre(res, statut, reponse);
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
      requetesChat: () => structuredClone(requetesChat),
      requetesEmbeddings: () => structuredClone(requetesEmbeddings),
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
