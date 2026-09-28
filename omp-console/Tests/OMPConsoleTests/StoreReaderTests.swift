// Preuves de S-1 (racine et énumération) et S-8 (filtrage, illisibilité,
// disponibilité) : AC-7, AC-8, AC-9, plus les cas limites de la résolution.
//
// Aucun test ne lit `~/.omp` : la racine est toujours une fixture sous
// `NSTemporaryDirectory()`, l'horloge est fixe.

import Foundation
import Testing
@testable import OMPConsole

@Test("client-magasin-etat/AC-7 : MEM0_PIPELINE_STATE_DIR défini fait lire ce répertoire")
func stateDirFromEnvironment() throws {
    let fixture = StoreFixture()
    let id = fixtureId(0x71)
    fixture.publish(
        .running,
        "\(id).json",
        object: runningObject(
            id: id,
            cwd: "/tmp/worktree-ac7",
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(getpid())
        )
    )
    let stateDir = PipelineStore.stateDir(env: ["MEM0_PIPELINE_STATE_DIR": fixture.root], home: "/nowhere")
    #expect(stateDir == fixture.root)
    let envelope = StoreReader(stateDir: stateDir, clock: fixtureClock).readRunning()
    #expect(envelope.entries.map(\.id) == [id])
}

@Test("client-magasin-etat/AC-7 : variable absente, la racine est <home>/.omp/agent/pipeline")
func stateDirWithoutEnvironment() {
    #expect(PipelineStore.stateDir(env: [:], home: "/Users/test") == "/Users/test/.omp/agent/pipeline")
    #expect(PipelineStore.stateDir(env: ["MEM0_PIPELINE_STATE_DIR": "   "], home: "/Users/test")
        == "/Users/test/.omp/agent/pipeline")
}

@Test("client-magasin-etat/AC-7 : la résolution suit la règle complète de pipelineStateDir")
func stateDirRules() {
    // Valeur rognée ; `~` seul rend le domicile ; `~/x` est développé.
    #expect(PipelineStore.stateDir(env: ["MEM0_PIPELINE_STATE_DIR": "  ~  "], home: "/Users/test") == "/Users/test")
    #expect(PipelineStore.stateDir(env: ["MEM0_PIPELINE_STATE_DIR": "~/etat"], home: "/Users/test")
        == "/Users/test/etat")
    // Chemin ABSOLU : tel quel. RELATIF : ignoré (il dépendrait du cwd).
    #expect(PipelineStore.stateDir(env: ["MEM0_PIPELINE_STATE_DIR": "/var/etat"], home: "/Users/test")
        == "/var/etat")
    #expect(PipelineStore.stateDir(env: ["MEM0_PIPELINE_STATE_DIR": "etat/relatif"], home: "/Users/test")
        == "/Users/test/.omp/agent/pipeline")
    // Le nom du répertoire d'un store EST son `rawValue`.
    #expect(PipelineStore.directory(.inbox, stateDir: "/var/etat") == "/var/etat/inbox")
    #expect(PipelineStore.allCases.map(\.rawValue) == ["running", "history", "lots", "projects", "inbox", "audit"])
}

@Test("client-magasin-etat/AC-8 : temporaire et .DS_Store ignorés, tronqué compté illisible")
func runningStoreFiltersNonEntries() {
    let fixture = StoreFixture()
    let id = fixtureId(0x81)
    fixture.publish(
        .running,
        "\(id).json",
        object: runningObject(
            id: id,
            cwd: "/tmp/worktree-ac8",
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(getpid())
        )
    )
    // Le temporaire d'une écriture atomique en cours : ni rendu, ni compté.
    fixture.put(.running, "\(id).json.tmp-\(getpid())", text: "{\"version\":1}")
    // Un fichier étranger : ni rendu, ni compté.
    fixture.put(.running, ".DS_Store", text: "\u{0}\u{1}")
    fixture.put(.running, "README", text: "notes")
    // Un sous-répertoire au nom NON conforme : ignoré sans être compté.
    try? FileManager.default.createDirectory(
        atPath: fixture.path(.running, "sous-dossier"),
        withIntermediateDirectories: true
    )
    // Un fichier au nom CONFORME mais tronqué : compté illisible, jamais rendu.
    fixture.put(.running, "\(fixtureId(0x82)).json", text: "{\"version\":1,\"id\":\"tronq")

    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readRunning()
    #expect(envelope.availability == .present)
    #expect(envelope.entries.map(\.id) == [id])
    #expect(envelope.discarded == 1)
}

@Test("client-magasin-etat/AC-9 : magasin absent contre magasin vide")
func absentVersusEmptyStore() {
    // Aucun répertoire n'est créé : « magasin absent ».
    let absent = StoreFixture(stores: [])
    #expect(!FileManager.default.fileExists(atPath: absent.root))
    let absentSnapshot = StoreReader(stateDir: absent.root, clock: fixtureClock).readAll()
    #expect(absentSnapshot.running.availability == .absent)
    #expect(absentSnapshot.history.availability == .absent)
    #expect(absentSnapshot.lots.availability == .absent)
    #expect(absentSnapshot.projects.availability == .absent)
    #expect(absentSnapshot.inbox.availability == .absent)
    #expect(absentSnapshot.audit.availability == .absent)
    #expect(absentSnapshot.running.entries.isEmpty)
    #expect(absentSnapshot.running.discarded == 0)

    // Les six répertoires existent mais sont vides : « magasin vide ».
    let empty = StoreFixture()
    let emptySnapshot = StoreReader(stateDir: empty.root, clock: fixtureClock).readAll()
    #expect(emptySnapshot.running.availability == .present)
    #expect(emptySnapshot.history.availability == .present)
    #expect(emptySnapshot.lots.availability == .present)
    #expect(emptySnapshot.projects.availability == .present)
    #expect(emptySnapshot.inbox.availability == .present)
    #expect(emptySnapshot.audit.availability == .present)
    #expect(emptySnapshot.running.entries.isEmpty)
    #expect(emptySnapshot.running.discarded == 0)

    // Un store DONT LE NOM existe comme FICHIER n'est pas un répertoire : `.absent`.
    let byFile = StoreFixture(stores: [])
    try? FileManager.default.createDirectory(atPath: byFile.root, withIntermediateDirectories: true)
    byFile.publish(path: joinPath(byFile.root, "audit"), contents: "{}")
    let fileSnapshot = StoreReader(stateDir: byFile.root, clock: fixtureClock).readAudit()
    #expect(fileSnapshot.availability == .absent)
    #expect(fileSnapshot.relays.isEmpty)
}

@Test("client-magasin-etat/AC-8 : les noms d'entrée sont exactement 16 hexadécimaux et .json")
func entryNameRecognition() {
    #expect(isStoreEntryName("0123456789abcdef.json"))
    #expect(!isStoreEntryName("0123456789abcdef.json.tmp-42"))
    #expect(!isStoreEntryName("0123456789abcde.json"))
    #expect(!isStoreEntryName("0123456789ABCDEF.json"))
    #expect(!isStoreEntryName("gg23456789abcdef.json"))
    #expect(!isStoreEntryName(".DS_Store"))
    #expect(isInboxBoxName("5fd065abf520fda4-1"))
    #expect(!isInboxBoxName("5fd065abf520fda4"))
    #expect(!isInboxBoxName("5fd065abf520fda4-x"))
}
