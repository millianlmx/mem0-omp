// La SUPERVISION du service par launchd (S-1) : le job qui garantit qu'un service
// tourne — au démarrage de session comme après un `kill -9` (Doc-3 §1-5).
//
// Le plist est du texte PUR, rendu ici et nulle part ailleurs : c'est lui qui
// porte le PATH sans lequel `omp` (un script `#!/usr/bin/env bun`) ne démarre pas
// dans la session graphique, dont le PATH est minimal (Doc-3 §5).
import * as fs from "node:fs";
import * as path from "node:path";
import { SERVICE_LABEL, serviceLogPath } from "./serviceState.ts";
import type { ServiceRecord } from "./serviceState.ts";
import { serviceRunning } from "./serviceState.ts";
import { pipelineStateDir } from "./store.ts";


/** Le dossier des agents utilisateur : `~/Library/LaunchAgents` (Doc-3 §1). */
export function launchAgentDir(home: string): string {
  return path.join(home, "Library", "LaunchAgents");
}


export function launchAgentPath(home: string, label: string = SERVICE_LABEL): string {
  return path.join(launchAgentDir(home), `${label}.plist`);
}


/** Le domaine launchd d'un utilisateur : `gui/<uid>` (Doc-3 §1). */
export function launchDomain(uid: number): string {
  return `gui/${uid}`;
}


/** Ce que le service écrit sur sa sortie : le fichier où lire une panne de job. */
export function launchdStdioPath(stateDir: string): string {
  return serviceLogPath(stateDir);
}


/** Les trois binaires d'un PATH launchd utilisable par `omp` (Doc-3 §5). */
export function launchdPath(ompBin: string, home: string): string {
  const ompDir = path.dirname(path.resolve(ompBin));
  const parts = [ompDir, path.join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const seen = new Set<string>();
  return parts.filter(part => (seen.has(part) ? false : (seen.add(part), true))).join(":");
}


const XML_ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };


/** Le texte d'une valeur XML : jamais un `<` brut qui casserait le plist. */
export function plistText(value: string): string {
  return value.replace(/[&<>"']/g, char => XML_ESCAPE[char] as string);
}


export type ServiceJobSpec = {
  label: string;
  /** La ligne de commande complète du service (ProgramArguments). */
  argv: string[];
  home: string;
  stateDir: string;
  ompBin: string;
  /** `ThrottleInterval` : l'étranglement d'un job qui meurt en boucle (Doc-3 §2). */
  throttleSeconds?: number;
};


/**
 * Le plist du service, rendu EXACTEMENT : `RunAtLoad` + `KeepAlive` (relance après
 * SIGKILL et démarrage à l'ouverture de session), `ThrottleInterval` (un job qui
 * échoue en boucle est étranglé), `WorkingDirectory` au foyer, le PATH complet, et
 * les deux sorties standard vers `<état>/service.log` (Doc-3 §2-5).
 */
export function renderServicePlist(spec: ServiceJobSpec): string {
  const env = [
    ["HOME", spec.home],
    ["PATH", launchdPath(spec.ompBin, spec.home)],
  ] as const;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${plistText(spec.label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...spec.argv.map(arg => `    <string>${plistText(arg)}</string>`),
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>${spec.throttleSeconds ?? 10}</integer>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${plistText(spec.home)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...env.flatMap(([key, value]) => [`    <key>${key}</key>`, `    <string>${plistText(value)}</string>`]),
    `  </dict>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${plistText(launchdStdioPath(spec.stateDir))}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${plistText(launchdStdioPath(spec.stateDir))}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}


/** La ligne de commande du job : le service est un process `omp -p` sans session. */
export function serviceJobArgv(ompBin: string): string[] {
  return [ompBin, "-p", "--no-session", "--pipeline-service", "/service start"];
}


/**
 * Le CHEMIN ABSOLU du binaire `omp` du job launchd, ou le motif de son absence.
 *
 * Un nom nu ne suffit PAS : launchd résout le premier élément de `ProgramArguments`
 * relatif via `_PATH_STDPATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), jamais via le PATH
 * du job — mesuré : le job meurt en `78: EX_CONFIG` sans jamais lancer `omp`. La
 * résolution est donc faite ICI, sur le PATH de l'installation (celui du shell qui
 * lance `/service install`), et un échec est NOMMÉ, jamais rendu tel quel.
 *
 * `process.execPath` ne convient pas : `omp` est un script `#!/usr/bin/env bun`,
 * donc `execPath` vaut le binaire `bun` (mesuré).
 */
export function resolveLaunchdOmpBinary(
  env: Record<string, string | undefined> = process.env,
  exists: (file: string) => boolean = fs.existsSync,
): { bin: string | null; problem: string | null } {
  const flag = (env.MEM0_PIPELINE_OMP_BIN ?? "").trim();
  if (flag !== "" && path.isAbsolute(flag)) {
    return exists(flag)
      ? { bin: flag, problem: null }
      : { bin: null, problem: `MEM0_PIPELINE_OMP_BIN=${flag} n'existe pas` };
  }
  const wanted = flag === "" ? "omp" : flag;
  if (wanted.includes("/")) {
    return { bin: null, problem: `« ${wanted} » n'est pas un chemin absolu` };
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = path.join(dir, wanted);
    if (exists(candidate)) return { bin: candidate, problem: null };
  }
  return {
    bin: null,
    problem: `« ${wanted} » introuvable dans le PATH — le job launchd exige un chemin ABSOLU (un nom nu est résolu via _PATH_STDPATH, où omp n'est pas)`,
  };
}


/** Le résultat d'une commande externe : `pi.exec` en production, un double en test. */
export type LaunchdExec = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export type LaunchdDeps = {
  /** Le binaire `omp` du job : un chemin ABSOLU, résolu par `resolveLaunchdOmpBinary`. */
  ompBin: string;
  /** Le motif d'un échec de résolution : l'installation refuse ALORS d'écrire le plist. */
  ompBinProblem?: string | null;
  home?: string;
  uid?: number;
  stateDir?: string;
  label?: string;
  exec: LaunchdExec;
  now?: () => number;
};


export type LaunchdStatus = {
  installed: boolean;
  /** `launchctl print` a répondu pour ce job. */
  loaded: boolean;
  /** Le service enregistré dans `service.json` est vivant. */
  running: ServiceRecord | null;
  /** `en marche (pid N, port P)` / `arrêté` — le texte de `/service status` (S-1). */
  text: string;
};


/** Le texte d'état, mot pour mot : le panneau et l'app le lisent tel quel (S-1). */
export function launchdStatusText(status: Omit<LaunchdStatus, "text">): string {
  if (status.running !== null) return `en marche (pid ${status.running.pid}, port ${status.running.port})`;
  if (!status.installed) return "arrêté — job launchd non installé (/service install)";
  if (!status.loaded) return "arrêté — job launchd installé mais non chargé (/service install)";
  return "arrêté";
}


/**
 * Le pilotage launchd du service : `bootstrap` à l'installation, `bootout` au
 * retrait, `print` pour l'état. Chaque commande est bornée par l'appelant (le
 * `pi.exec` du service porte son propre délai) et un échec n'est jamais avalé :
 * c'est le TEXTE de `launchctl` qui remonte à l'utilisateur.
 */
export function createLaunchd(deps: LaunchdDeps) {
  const home = deps.home ?? process.env.HOME ?? "";
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const stateDir = deps.stateDir ?? pipelineStateDir();
  const label = deps.label ?? SERVICE_LABEL;
  const plist = launchAgentPath(home, label);
  const domain = launchDomain(uid);

  async function printLoaded(): Promise<boolean> {
    const result = await deps.exec(["launchctl", "print", `${domain}/${label}`]);
    return result.code === 0;
  }

  return {
    plist,
    argv: serviceJobArgv(deps.ompBin),
    spec: (): ServiceJobSpec => ({ label, argv: serviceJobArgv(deps.ompBin), home, stateDir, ompBin: deps.ompBin }),

    /** Écrit le plist PUIS charge le job ; un job déjà chargé est relancé. */
    async install(): Promise<{ ok: boolean; text: string }> {
      // Un `ProgramArguments[0]` relatif n'est PAS lançable par launchd
      // (`_PATH_STDPATH`, mesuré : `78: EX_CONFIG`) : l'installation refuse AVANT
      // d'écrire quoi que ce soit, en nommant le remède. Un chemin ABSOLU mais
      // INTROUVABLE (drapeau fautif) est refusé de même : le job ne pourrait pas
      // `exec` le binaire, donc ne démarrerait jamais.
      if (deps.ompBinProblem) {
        return {
          ok: false,
          text:
            `binaire « omp » inutilisable pour launchd : ${deps.ompBinProblem} — ` +
            "installe `omp` dans le PATH, ou pose MEM0_PIPELINE_OMP_BIN=/chemin/absolu/omp (un fichier existant)",
        };
      }
      if (!path.isAbsolute(deps.ompBin)) {
        return {
          ok: false,
          text:
            `binaire « omp » non absolu (${deps.ompBin}) : launchd ne le résoudrait pas (_PATH_STDPATH) ` +
            "et le job ne démarrerait jamais — installe `omp` dans le PATH, ou pose " +
            "MEM0_PIPELINE_OMP_BIN=/chemin/absolu/omp",
        };
      }
      fs.mkdirSync(launchAgentDir(home), { recursive: true });
      fs.writeFileSync(plist, renderServicePlist(this.spec()), "utf8");
      const loaded = await printLoaded();
      if (loaded) {
        // Le plist a peut-être changé : `kickstart -k` reprend le job en cours.
        const kick = await deps.exec(["launchctl", "kickstart", "-k", `${domain}/${label}`]);
        return kick.code === 0
          ? { ok: true, text: "service installé et relancé (launchd)" }
          : { ok: false, text: `launchctl kickstart a échoué : ${kick.stderr.trim() || `code ${kick.code}`}` };
      }
      const boot = await deps.exec(["launchctl", "bootstrap", domain, plist]);
      return boot.code === 0
        ? { ok: true, text: "service installé (launchd)" }
        : { ok: false, text: `launchctl bootstrap a échoué : ${boot.stderr.trim() || `code ${boot.code}`}` };
    },

    /** Décharge le job puis retire le plist : un service qui tourne encore est tué. */
    async uninstall(): Promise<{ ok: boolean; text: string }> {
      const boot = await deps.exec(["launchctl", "bootout", `${domain}/${label}`]);
      fs.rmSync(plist, { force: true });
      if (boot.code === 0 || (await printLoaded()) === false) return { ok: true, text: "service désinstallé (launchd)" };
      return { ok: false, text: `launchctl bootout a échoué : ${boot.stderr.trim() || `code ${boot.code}`}` };
    },

    /** L'état complet : le fichier, la vivacité du pid, et le job launchd. */
    async status(): Promise<LaunchdStatus> {
      const installed = fs.existsSync(plist);
      const loaded = await printLoaded();
      const running = serviceRunning(stateDir);
      const rest = { installed, loaded, running };
      return { ...rest, text: launchdStatusText(rest) };
    },
  };
}
