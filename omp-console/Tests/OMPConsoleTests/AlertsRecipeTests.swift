// Preuve sur le réel (BR-6, S-10, AC-10) : la chaîne magasin réel → dérivation réelle
// → livraison est exercée sur un vrai magasin alimenté par un PROCESS distinct, hors
// suite et hors CI.
//
// DÉSACTIVÉE par défaut : ni `.github/workflows/check.yml` ni `scripts/swift-app.sh`
// ne posent `MEM0_ALERTS_RECIPE_DIR`/`MEM0_ALERTS_RECIPE_OUT`, donc la CI la rapporte
// « skipped ». Elle ne peut PAS conclure un `add` réel hors bundle (mesuré : l'appel à
// `UNUserNotificationCenter` tue le process, Doc-3) — cette partie est prouvée par la
// recette manuelle du README (S-10 b).

import Foundation
import Testing
@testable import OMPConsole

/// Un script jetable `#!/bin/sh` qui écrit lui-même l'entrée `running/`, puis reste
/// vivant (`exec sleep`) pour que son pid soit VIVANT — sans quoi l'entrée serait
/// périmée et n'émettrait rien (motif mesuré, SessionHostTests).
private func writeRecipeScript(at path: String) throws {
    let script = """
    #!/bin/sh
    dir="$1"
    mkdir -p "$dir/running"
    id="00000000000000a1"
    ms="$(date +%s)000"
    printf '{"version":1,"id":"%s","cwd":"%s/worktree","label":"recette/attente","phase":"impl","state":"waiting","phaseStartedAt":%s,"updatedAt":%s,"owner":{"pid":%s},"pendingAsk":{"toolCallId":"call-1","id":"ask-1","question":"Quel chemin ?","options":[{"label":"ici"}]}}' "$id" "$dir" "$ms" "$ms" "$$" > "$dir/running/$id.json"
    exec sleep 30
    """
    try script.write(toFile: path, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
}

@Test(
    "notifications-et-barre-de-menus/AC-10 : recette réelle — un process alimente le magasin, le modèle notifie",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_ALERTS_RECIPE_DIR"] != nil
        && ProcessInfo.processInfo.environment["MEM0_ALERTS_RECIPE_OUT"] != nil)
)
/// Le NOM de la fonction doit porter « recette » : `swift test --filter` filtre sur
/// l'identifiant du test, pas sur son titre affiché.
@MainActor
func recetteAlertsSurUnMagasinReel() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let stateDir = environment["MEM0_ALERTS_RECIPE_DIR"], !stateDir.isEmpty else {
        Issue.record("MEM0_ALERTS_RECIPE_DIR est vide : la recette ne sait pas quel magasin utiliser")
        return
    }
    guard let output = environment["MEM0_ALERTS_RECIPE_OUT"], !output.isEmpty else {
        Issue.record("MEM0_ALERTS_RECIPE_OUT est requis : c'est le chemin du journal à écrire")
        return
    }
    try FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true)

    // (1) Un PROCESS distinct écrit le magasin — jamais une double interne au test.
    let scriptPath = joinPath(stateDir, "recipe-\(UUID().uuidString).sh")
    try writeRecipeScript(at: scriptPath)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: scriptPath)
    process.arguments = [stateDir]
    try process.run()
    defer { if process.isRunning { process.terminate() } }

    let entryFile = joinPath(joinPath(stateDir, "running"), "00000000000000a1.json")
    var waited = 0
    while !FileManager.default.fileExists(atPath: entryFile) && waited < 3_000 {
        try? await Task.sleep(for: .milliseconds(50))
        waited += 50
    }
    guard FileManager.default.fileExists(atPath: entryFile) else {
        Issue.record("le script n'a pas écrit \(entryFile)")
        return
    }

    // (2) Le VRAI modèle sur le VRAI StoreHub du magasin, avec un livreur enregistreur.
    let ledgerPath = joinPath(joinPath(stateDir, "alerts"), AlertLedger.fileName)
    let deliverer = RecorderAlertDeliverer()
    let model = AlertsModel(
        hub: StoreHub(stateDir: stateDir),
        ledgerPath: ledgerPath,
        deliverer: deliverer,
        isWindowFrontmost: { false },
        nowMs: { StoreClock.live.nowMs() }
    )
    defer { model.stop() }
    model.start()
    _ = await awaitMainTrue(timeout: 10) { deliverer.messages.count >= 1 }
    try? await Task.sleep(for: .milliseconds(200))

    // (3) Le journal : clés, titres, corps, résultats, contenu du registre.
    var journal: [String] = []
    journal.append("magasin=\(stateDir)")
    journal.append("AUCUNE preuve d'`add` hors bundle : un processus de test n'est pas un bundle .app "
        + "(Doc-3/Doc-4) — seul un livreur enregistreur est exercé ici.")
    for message in deliverer.messages {
        journal.append("livraison key=\(message.key) titre=\(message.title) corps=\(message.body)")
    }
    for outcome in deliverer.outcomes {
        journal.append("résultat=\(outcome)")
    }
    let ledger = AlertLedger(path: ledgerPath)
    for key in ledger.notified.keys.sorted() {
        journal.append("registre key=\(key) at=\(ledger.notified[key] ?? 0)")
    }
    let text = journal.joined(separator: "\n") + "\n"
    try text.write(toFile: output, atomically: true, encoding: .utf8)

    print("recette alertes : \(deliverer.messages.count) livraison(s), registre=\(ledger.notified.count) clé(s) → \(output)")
}
