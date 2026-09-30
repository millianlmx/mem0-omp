// Preuves du registre persisté (BR-2, S-7) : la déduplication survit à une relance de
// l'app (AC-5) et la lecture est tolérante à toutes les formes d'un fichier abîmé.

import Foundation
import Testing
@testable import OMPConsole

// MARK: - AC-5 : après relance, pas de renotification

@MainActor
@Test("notifications-et-barre-de-menus/AC-5 : un évènement déjà notifié n'est pas renotifié après relance")
func ledgerPreventsReNotificationAcrossRelaunch() async {
    let fixture = StoreFixture()
    let id = fixtureId(0xf1)
    publishPendingAnswer(fixture, id: id, toolCallId: "call-1")
    let ledgerPath = fixtureLedgerPath(fixture)
    let key = "answer:\(id):call-1"

    // Première exécution : la question est notifiée et la clé enregistrée.
    let first = RecorderAlertDeliverer()
    let model1 = fixtureAlertsModel(fixture, deliverer: first, frontmost: false, ledgerPath: ledgerPath)
    model1.start()
    #expect(await awaitMainTrue { first.messages.count == 1 })
    model1.stop()
    #expect(AlertLedger(path: ledgerPath).contains(key))

    // Relance : le MÊME évènement est toujours présent, et n'est PAS renotifié.
    let second = RecorderAlertDeliverer()
    let model2 = fixtureAlertsModel(fixture, deliverer: second, frontmost: false, ledgerPath: ledgerPath)
    model2.start()
    // Laisser le modèle traiter au moins un instantané : le compteur est publié.
    #expect(await awaitMainTrue { model2.status.counters != nil })
    try? await Task.sleep(for: .milliseconds(150))
    model2.stop()
    #expect(second.messages.isEmpty)
}

// MARK: - Schéma et tolérance de la lecture

@Test("notifications-et-barre-de-menus/AC-5 : la lecture tolère absent, illisible, mauvaise version et clés mal typées")
func ledgerToleratesBrokenFiles() throws {
    let root = (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-ledger-\(UUID().uuidString)")
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: root) }

    // Fichier absent ⇒ registre vide.
    #expect(AlertLedger.load(path: joinPath(root, "absent.json")).isEmpty)

    // Non JSON ⇒ vide.
    let notJSON = joinPath(root, "notjson.json")
    try "pas du json".write(toFile: notJSON, atomically: true, encoding: .utf8)
    #expect(AlertLedger.load(path: notJSON).isEmpty)

    // Mauvaise version ⇒ vide.
    let badVersion = joinPath(root, "v2.json")
    try #"{"version":2,"notified":{"cle":1}}"#.write(toFile: badVersion, atomically: true, encoding: .utf8)
    #expect(AlertLedger.load(path: badVersion).isEmpty)

    // `notified` non objet ⇒ vide.
    let badNotified = joinPath(root, "badnotified.json")
    try #"{"version":1,"notified":[]}"#.write(toFile: badNotified, atomically: true, encoding: .utf8)
    #expect(AlertLedger.load(path: badNotified).isEmpty)

    // Une valeur non numérique vaut 0 ; seule la CLÉ fait foi.
    let mixed = joinPath(root, "mixed.json")
    try #"{"version":1,"notified":{"a":123,"b":"x"}}"#.write(toFile: mixed, atomically: true, encoding: .utf8)
    let loaded = AlertLedger.load(path: mixed)
    #expect(loaded["a"] == 123)
    #expect(loaded["b"] == 0)
}

@Test("notifications-et-barre-de-menus/AC-5 : `record` n'écrit que pour une clé neuve et le registre se relit")
func ledgerRecordsOnlyNewKeys() throws {
    let root = (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-ledger-\(UUID().uuidString)")
    let path = joinPath(root, AlertLedger.fileName)
    defer { try? FileManager.default.removeItem(atPath: root) }

    var ledger = AlertLedger(path: path)
    let firstRecord = ledger.record(keys: ["k1", "k2"], nowMs: 1_000)
    #expect(firstRecord)
    #expect(ledger.save())
    #expect(AlertLedger(path: path).notified == ["k1": 1_000, "k2": 1_000])

    // Rejouer les mêmes clés n'est pas une écriture (aucune clé neuve).
    let replay = ledger.record(keys: ["k1", "k2"], nowMs: 2_000)
    #expect(!replay)
    // Une clé neuve l'est.
    let added = ledger.record(keys: ["k3"], nowMs: 3_000)
    #expect(added)
    #expect(ledger.contains("k3"))
}

@Test("notifications-et-barre-de-menus/AC-5 : `defaultPath` retient un chemin absolu, développe `~`, ignore un relatif")
func ledgerDefaultPath() {
    let home = "/Users/quelqu-un"
    let expectedDefault = "\(home)/Library/Application Support/com.omp.console/\(AlertLedger.fileName)"

    #expect(AlertLedger.defaultPath(env: [:], home: home) == expectedDefault)
    #expect(
        AlertLedger.defaultPath(env: ["MEM0_CONSOLE_ALERTS_DIR": "/tmp/ledger"], home: home)
            == "/tmp/ledger/\(AlertLedger.fileName)"
    )
    #expect(
        AlertLedger.defaultPath(env: ["MEM0_CONSOLE_ALERTS_DIR": "~/alerts"], home: home)
            == "\(home)/alerts/\(AlertLedger.fileName)"
    )
    #expect(
        AlertLedger.defaultPath(env: ["MEM0_CONSOLE_ALERTS_DIR": "~"], home: home)
            == "\(home)/\(AlertLedger.fileName)"
    )
    // Un chemin relatif est ignoré (il dépendrait du cwd) : le défaut s'applique.
    #expect(
        AlertLedger.defaultPath(env: ["MEM0_CONSOLE_ALERTS_DIR": "ledger"], home: home) == expectedDefault
    )
}
