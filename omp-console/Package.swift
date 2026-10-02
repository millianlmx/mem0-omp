// swift-tools-version: 6.2
// Paquet SwiftPM de la coque macOS (salle de contrôle OMP). Aucune dépendance
// externe : la coque n'affiche que des vues système, donc rien à résoudre et
// pas de Package.resolved à maintenir. La cible minimale macOS 26 est imposée par
// Liquid Glass ; `platforms` la rend explicite au lieu de la subir (et
// `.macOS(.v26)` exige swift-tools-version 6.2).
import PackageDescription

let package = Package(
    name: "omp-console",
    platforms: [.macOS(.v26)],
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
