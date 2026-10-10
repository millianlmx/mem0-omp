// Le crochet de RECETTE `-setup.recipe <valeur>` (S-7) : il remplace l'installateur
// de la feuille de préparation par un script, pour que la recette sur l'app réelle
// observe la progression chiffrée, la progression indéterminée, l'échec à détail
// long et la réussite — sans réseau, sans pile mémoire, sans machine podman.
//
// Garde : le crochet n'agit QUE sous une racine jetable (`OMP_CONSOLE_SUPPORT_ROOT`
// posée et non vide). Sans elle, ou avec une valeur inconnue, l'app prend la chaîne
// réelle, sans message : le crochet ne touche JAMAIS la racine réelle de l'app.
//
// Seule l'étape Composants est scriptée ; migration et pile ne font rien, oMLX est
// `.unknown`. Le reste du câblage (`refreshOmp`, `onReady`, service distant) est
// celui de la chaîne réelle, posé par `OMPConsoleApp`. Ce n'est pas une
// fonctionnalité, comme `-home.welcomeSeen`.

import Foundation

enum SetupRecipe: String, CaseIterable {
    /// Téléchargement chiffré de la cible (0 → 100 % en 10 s), puis attente.
    case progression
    /// Téléchargement sans taille connue (`total: 0`), puis attente.
    case indeterminee
    /// Échec d'installation dont le détail dépasse la zone d'affichage.
    case echec
    /// Téléchargement court, puis pose d'exécutables factices : `.ready`.
    case succes

    /// La clé lue dans les préférences ; l'argument de lancement
    /// `-setup.recipe <valeur>` la fournit au domaine d'arguments.
    static let defaultsKey = "setup.recipe"

    /// Le détail de l'échec scripté : 40 lignes, puis une ligne finale que la
    /// recette cherche après défilement de la zone de détail.
    static let failureDetail: String = ((1...40).map {
        String(format: "Ligne %02d du détail de recette : étape simulée de l'installation.", $0)
    } + ["Fin du détail de recette."]).joined(separator: "\n")

    /// La recette demandée, ou `nil` : racine jetable absente ou vide, valeur
    /// absente, ou valeur inconnue.
    static func current(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> SetupRecipe? {
        guard let root = environment[AppPaths.supportRootEnvironmentKey], !root.isEmpty else { return nil }
        return defaults.string(forKey: defaultsKey).flatMap(SetupRecipe.init(rawValue:))
    }

    /// Un modèle de préparation dont l'installateur suit la recette. La cible est
    /// le premier composant manquant dans l'ordre `[.omp, .podman]`, relue à chaque
    /// passage ; sans cible, l'installation rend la main tout de suite.
    @MainActor
    func model(
        paths: AppPaths = .standard(),
        manifest: ComponentManifest = .current,
        autoPrepare: Bool
    ) -> SetupModel {
        let installer = ComponentInstaller(paths: paths, manifest: manifest)
        let recipe = self
        return SetupModel(
            install: { progress in try await recipe.install(installer: installer, progress: progress) },
            migrate: { _ in },
            ensureStack: { _ in },
            probeOMLX: { .unknown },
            autoPrepare: autoPrepare
        )
    }

    @MainActor
    private func install(
        installer: ComponentInstaller,
        progress: @escaping @MainActor (ComponentInstallStep) -> Void
    ) async throws {
        let missing = ComponentID.allCases.filter { !installer.isInstalled($0) }
        guard let target = missing.first else {
            if self == .echec {
                throw ComponentInstallError.install(component: ComponentID.omp.name, detail: Self.failureDetail)
            }
            return
        }
        switch self {
        case .progression:
            for k in 0...10 {
                progress(Self.download(target, downloaded: Int64(k) * 12_000_000, total: 120_000_000))
                try await Task.sleep(for: .seconds(1))
            }
            progress(Self.installStep(target))
            try await Task.sleep(for: .seconds(86_400))
        case .indeterminee:
            for k in 0..<10 {
                progress(Self.download(target, downloaded: Int64(k) * 4_000_000, total: 0))
                try await Task.sleep(for: .seconds(1))
            }
            try await Task.sleep(for: .seconds(86_400))
        case .echec:
            throw ComponentInstallError.install(component: target.name, detail: Self.failureDetail)
        case .succes:
            for k in 0...4 {
                progress(Self.download(target, downloaded: Int64(k) * 30_000_000, total: 120_000_000))
                try await Task.sleep(for: .milliseconds(500))
            }
            progress(Self.installStep(target))
            for component in missing {
                try Self.placeStub(at: installer.binaryLocation(component))
            }
        }
    }

    private static func download(_ component: ComponentID, downloaded: Int64, total: Int64) -> ComponentInstallStep {
        switch component {
        case .omp: .omp(downloaded: downloaded, total: total)
        case .podman: .podman(downloaded: downloaded, total: total)
        }
    }

    private static func installStep(_ component: ComponentID) -> ComponentInstallStep {
        switch component {
        case .omp: .ompInstall
        case .podman: .podmanInstall
        }
    }

    /// Un exécutable factice (`exit 0`, mode 0755), dossiers intermédiaires créés.
    private static func placeStub(at location: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: location.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: location)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: location.path)
    }
}
