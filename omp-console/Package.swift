// swift-tools-version: 6.0
// Paquet SwiftPM de la coque macOS (salle de contrôle OMP). Aucune dépendance
// externe : la coque n'affiche que des vues système, donc rien à résoudre et
// pas de Package.resolved à maintenir. La cible minimale macOS 14 est celle des
// postes de développement ; `platforms` la rend explicite au lieu de la subir.
import PackageDescription

let package = Package(
    name: "omp-console",
    platforms: [.macOS(.v14)],
    targets: [
        // Cible exécutable : le fichier d'entrée ne s'appelle PAS main.swift,
        // sinon `@main` est refusé.
        .executableTarget(name: "OMPConsole", path: "Sources/OMPConsole"),
        // Tests en Swift Testing, jamais XCTest : sous les Command Line Tools
        // seuls, XCTest n'existe pas (D2).
        .testTarget(
            name: "OMPConsoleTests",
            dependencies: ["OMPConsole"],
            path: "Tests/OMPConsoleTests"
        ),
    ]
)
