// Garde de la feature `gestes-vocaux-sans-politique-de-confirma` (S-6) : la
// politique de confirmation des gestes vocaux (ConsoleCore/Voice) ne régit que les
// App Intents. Les écrans et modèles de gestes tactiles de la coque Mac et de la
// coque iOS gardent leurs confirmations propres : aucun fichier de ces deux racines
// ne cite la politique vocale s'il ne déclare pas lui-même un App Intent.
//
// La garde est jugée sur l'arbre réel, puis sur des Map synthétiques où l'on
// plante une fuite (un écran) et un usage légitime (un intent).
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { stripComments, swiftSources } from "../support/swift-source.ts";

/** Les deux coques dont les gestes tactiles ne doivent pas changer. */
const ROOTS = ["omp-console/Sources/OMPConsole", "omp-console/ios/OMPConsoleIOS"] as const;

/** Un symbole de la politique vocale de ConsoleCore. */
const VOICE_POLICY = /\bVoiceGesture\w*\b|\bVoicePlatform\b|\bapplyVoicePolicy\b/;
/** La déclaration d'un type conforme à `AppIntent` ou à `VoiceGestureIntent`. */
const INTENT_DECLARATION = /\b(struct|class|enum)\s+\w+\s*:[^{]*\b(AppIntent|VoiceGestureIntent)\b/;

/**
 * Les fichiers `.swift` (clé = chemin relatif) qui citent la politique vocale
 * hors d'un App Intent, commentaires retirés ; liste vide si aucun.
 */
function voicePolicyLeaks(sources: Map<string, string>): string[] {
  const faults: string[] = [];
  for (const [file, source] of sources) {
    const code = stripComments(source);
    if (VOICE_POLICY.test(code) && !INTENT_DECLARATION.test(code)) {
      faults.push(`${file} applique la politique vocale hors d’un App Intent`);
    }
  }
  return faults;
}

/** Les `.swift` des deux coques, clé = chemin relatif à la racine du dépôt. */
function shellSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const base of ROOTS) {
    for (const [file, source] of swiftSources(path.join(ROOT, base), ROOT)) out.set(file, source);
  }
  return out;
}

test("gestes-vocaux-sans-politique-de-confirma/AC-9 : les gestes tactiles Mac et iOS n’appliquent pas la politique vocale, réservée aux App Intents", () => {
  const sources = shellSources();
  assert.ok(
    ROOTS.every((base) => [...sources.keys()].some((file) => file.startsWith(`${base}/`))),
    "le scan doit lire des sources sous chacune des deux coques",
  );
  assert.deepEqual(voicePolicyLeaks(sources), [], "l'arbre réel doit être sain");

  // Un écran qui consulte la table : une faute, qui nomme le fichier.
  const screen = "omp-console/ios/OMPConsoleIOS/HomeView.swift";
  const leaked = new Map(sources);
  leaked.set(
    screen,
    `${sources.get(screen) ?? ""}\nlet regle = VoiceGesturePolicy.rule(for: .stopFeature, on: .ios)\n`,
  );
  assert.deepEqual(voicePolicyLeaks(leaked), [`${screen} applique la politique vocale hors d’un App Intent`]);

  // Une mention en commentaire seulement ne compte pas.
  const commented = new Map([[screen, "// VoiceGesturePolicy n'est pas appliquée ici\nstruct HomeView {}\n"]]);
  assert.deepEqual(voicePolicyLeaks(commented), []);

  // Un intent vocal qui applique la politique : légitime.
  const intent = new Map([
    [
      "omp-console/Sources/OMPConsole/Intents/StopIntent.swift",
      [
        "import AppIntents",
        "import ConsoleCore",
        "struct StopIntent: VoiceGestureIntent {",
        "  static let voiceGesture: VoiceGesture = .stopFeature",
        "  func perform() async throws -> some IntentResult {",
        "    _ = try await applyVoicePolicy(target: \"login-oauth\", send: {})",
        "    return .result()",
        "  }",
        "}",
      ].join("\n"),
    ],
  ]);
  assert.deepEqual(voicePolicyLeaks(intent), []);
});
