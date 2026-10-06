// Preuves de AC-1, AC-2 et AC-3 de la feature : l'état de présence des deux
// composants embarqués (S-1), ses mots exacts (SetupText) et le recalcul continu
// par veille (S-3).
//
// Racines TEMPORAIRES uniquement — la racine réelle du poste est polluée par le
// premier lancement de l'app (piège mesuré de all-in-one-app), donc jamais lue
// ici. Les binaires sont de VRAIS fichiers du disque, avec leur mode : c'est le
// mode qui décide (invariant S-1), jamais une doublure.

import Darwin
import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

/// Une racine de support jetable sous `NSTemporaryDirectory()`.
private final class ComponentsRoot {
    let paths: AppPaths
    let manifest = ComponentManifest.current
    private let fileManager = FileManager.default

    init() {
        let root = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("omp-console-components-\(UUID().uuidString)")
        paths = AppPaths(supportRoot: URL(fileURLWithPath: root, isDirectory: true))
    }

    deinit { try? fileManager.removeItem(at: paths.supportRoot) }

    /// Le chemin du contrat, RECOPIÉ ici plutôt que dérivé de
    /// `binaryLocation(_:)` : c'est lui que les preuves soumettent au sujet.
    func binary(_ id: ComponentID) -> URL {
        switch id {
        case .omp:
            paths.supportRoot.appendingPathComponent("components/omp/\(manifest.ompVersion)/omp")
        case .podman:
            paths.supportRoot.appendingPathComponent("components/podman/\(manifest.podmanVersion)/bin/podman")
        }
    }

    /// Crée les dossiers de version SANS poser les binaires : la veille s'arme
    /// alors sur un dossier existant, et l'apparition du fichier est un vrai
    /// événement de ce dossier — le cas de l'installation en cours.
    func prepareDirectories() throws {
        for id in ComponentID.allCases {
            try fileManager.createDirectory(
                at: binary(id).deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
        }
    }

    /// Pose un binaire — exécutable (`0755`) ou non (`0644`) — et rend son chemin.
    @discardableResult
    func place(_ id: ComponentID, executable: Bool = true, at destination: URL? = nil) throws -> URL {
        let target = destination ?? binary(id)
        try fileManager.createDirectory(
            at: target.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("#!/bin/sh\n".utf8).write(to: target)
        try fileManager.setAttributes(
            [.posixPermissions: executable ? 0o755 : 0o644],
            ofItemAtPath: target.path
        )
        return target
    }

    @MainActor
    var installer: ComponentInstaller { ComponentInstaller(paths: paths, manifest: manifest) }
}

// MARK: - AC-1 : tout est installé

@MainActor
@Test("add-status-badge-in-bottom-left-corner/AC-1 : les deux composants installés → « Tout est installé », lu dès l'init du badge")
func allInstalledShowsThePositiveState() throws {
    let root = ComponentsRoot()
    try root.place(.omp)
    try root.place(.podman)

    // Dès l'`init` : lecture locale, synchrone, sans attente.
    let model = ComponentPresenceModel(paths: root.paths, manifest: root.manifest, watch: false)
    #expect(model.presence.missing.isEmpty)
    #expect(model.presence.allInstalled)
    #expect(model.presence.status == ConsoleStatus(text: "Tout est installé", tone: .success))
}

// MARK: - AC-2 : les composants manquants sont nommés

@MainActor
@Test("add-status-badge-in-bottom-left-corner/AC-2 : un seul composant manquant est nommé seul")
func oneMissingComponentIsNamed() throws {
    let ompOnly = ComponentsRoot()
    try ompOnly.place(.omp)
    #expect(ComponentPresence.read(ompOnly.installer).status
        == ConsoleStatus(text: "Podman manquant", tone: .attention))

    let podmanOnly = ComponentsRoot()
    try podmanOnly.place(.podman)
    #expect(ComponentPresence.read(podmanOnly.installer).status
        == ConsoleStatus(text: "OMP manquant", tone: .attention))
}

@MainActor
@Test("add-status-badge-in-bottom-left-corner/AC-2 : les deux composants manquants sont nommés, dans l'ordre, jamais « manquant(s) »")
func bothMissingComponentsAreNamed() {
    // Racine jamais installée : ni racine, ni composant.
    let presence = ComponentPresence.read(ComponentsRoot().installer)
    #expect(presence.missing == [.omp, .podman])
    #expect(presence.status == ConsoleStatus(text: "OMP et Podman manquants", tone: .attention))
}

@MainActor
@Test("add-status-badge-in-bottom-left-corner/AC-2 : un fichier non exécutable (0644, 000) ne compte jamais comme installé")
func nonExecutableBinariesAreMissing() throws {
    let readOnly = ComponentsRoot()
    try readOnly.place(.omp, executable: false)
    #expect(ComponentPresence.read(readOnly.installer).missing == [.omp, .podman])

    let forbidden = ComponentsRoot()
    let binary = try forbidden.place(.podman)
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: binary.path)
    #expect(ComponentPresence.read(forbidden.installer).missing == [.omp, .podman])
}

@MainActor
@Test("add-status-badge-in-bottom-left-corner/AC-2 : un dossier à la place du binaire, ou le binaire d'une autre version, est manquant")
func directoryOrOtherVersionIsMissing() throws {
    let replaced = ComponentsRoot()
    for id in ComponentID.allCases {
        try FileManager.default.createDirectory(at: replaced.binary(id), withIntermediateDirectories: true)
    }
    // Mesuré : `isExecutableFile` dit vrai pour un dossier 0755 — le prédicat
    // complet de `isInstalled(_:)` doit l'écarter (Doc-2, correction du 05/10).
    #expect(ComponentPresence.read(replaced.installer).missing == [.omp, .podman])

    let otherVersion = ComponentsRoot()
    try otherVersion.place(.omp, at: otherVersion.paths.supportRoot
        .appendingPathComponent("components/omp/0.0.0/omp"))
    #expect(ComponentPresence.read(otherVersion.installer).missing == [.omp, .podman])
}

@MainActor
@Test("add-status-badge-in-bottom-left-corner/AC-2 : OMP_CONSOLE_OMP_BINARY est sans effet, le badge décrit les composants de l'app")
func ompBinaryEnvironmentIsIgnored() throws {
    let root = ComponentsRoot()
    let decoy = root.paths.supportRoot.appendingPathComponent("decoy/omp")
    try root.place(.omp, at: decoy)

    setenv("OMP_CONSOLE_OMP_BINARY", decoy.path, 1)
    defer { unsetenv("OMP_CONSOLE_OMP_BINARY") }
    // La variable est bien visible du process : la preuve n'est pas vide.
    #expect(ProcessInfo.processInfo.environment["OMP_CONSOLE_OMP_BINARY"] == decoy.path)

    #expect(ComponentPresence.read(root.installer).missing == [.omp, .podman])
}

// MARK: - AC-3 : le badge se recalcule sans redémarrer l'app

@MainActor
@Test("add-status-badge-in-bottom-left-corner/AC-3 : l'apparition des binaires est vue sans redémarrer l'app")
func appearingBinariesAreSeen() async throws {
    let root = ComponentsRoot()
    try root.prepareDirectories()
    let model = ComponentPresenceModel(paths: root.paths, manifest: root.manifest)
    #expect(model.presence.missing == [.omp, .podman])

    try root.place(.omp)
    #expect(await awaitMainTrue { model.presence.missing == [.podman] })

    try root.place(.podman)
    #expect(await awaitMainTrue { model.presence.allInstalled })
    #expect(model.presence.status == ConsoleStatus(text: "Tout est installé", tone: .success))
}

@MainActor
@Test("add-status-badge-in-bottom-left-corner/AC-3 : la disparition d'un composant installé est vue sans redémarrer l'app")
func disappearingBinaryIsSeen() async throws {
    let root = ComponentsRoot()
    try root.place(.omp)
    try root.place(.podman)
    let model = ComponentPresenceModel(paths: root.paths, manifest: root.manifest)
    #expect(model.presence.allInstalled)

    try FileManager.default.removeItem(at: root.binary(.podman))
    #expect(await awaitMainTrue { model.presence.missing == [.podman] })
    #expect(model.presence.status == ConsoleStatus(text: "Podman manquant", tone: .attention))
}

@MainActor
@Test("add-status-badge-in-bottom-left-corner/AC-3 : un changement de permission est vu sans redémarrer l'app")
func permissionChangeIsSeen() async throws {
    let root = ComponentsRoot()
    try root.place(.omp)
    try root.place(.podman)
    let model = ComponentPresenceModel(paths: root.paths, manifest: root.manifest)
    #expect(model.presence.allInstalled)

    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: root.binary(.omp).path)
    #expect(await awaitMainTrue { model.presence.missing == [.omp] })
    #expect(model.presence.status == ConsoleStatus(text: "OMP manquant", tone: .attention))
}
