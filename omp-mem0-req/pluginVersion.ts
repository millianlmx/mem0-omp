// LA VERSION D'OMP-MEM0-REQ DU CODE CHARGÉ (service-version-drift-detection, S-1).
//
// Lue UNE fois, à l'évaluation du module, dans le `package.json` voisin du code
// chargé : un upgrade du plugin sur disque ne la change pas — c'est précisément ce
// qui permet de voir qu'un service démarré avant l'upgrade exécute l'ancien code.
//
// Imports `node:` seulement : le module se copie seul (preuve d'AC-2).
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Le champ `version` d'un package.json, ou `null` (absent, illisible, invalide, vide). Ne lève jamais. */
export function readPackageVersion(file: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || !("version" in parsed)) return null;
    const version = parsed.version;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

function loadedPluginVersion(): string | null {
  try {
    return readPackageVersion(fileURLToPath(new URL("./package.json", import.meta.url)));
  } catch {
    return null;
  }
}

/** La version d'omp-mem0-req chargée par ce process, figée au chargement du module. */
export const LOADED_PLUGIN_VERSION: string | null = loadedPluginVersion();
