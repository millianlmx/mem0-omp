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
        // Cible bibliothèque PARTAGÉE macOS/iOS : les modèles et constantes pures
        // du magasin, le vocabulaire figé des sections et le socle du contrat de
        // l'API distante — rien qui touche à une vue, donc ni AppKit ni UIKit
        // (garde permanente : section « Noyau partagé » de scripts/check.sh).
        //
        // AUCUNE dépendance, ni interne ni externe : c'est ce qui la rend
        // compilable seule (`swift build --target ConsoleCore`) et réutilisable
        // par un autre paquet (la coque iOS). Ses déclarations sont `public`,
        // jamais `package` — `package` serait invisible depuis un autre paquet.
        .target(name: "ConsoleCore", path: "Sources/ConsoleCore"),
        // Cible exécutable : le fichier d'entrée ne s'appelle PAS main.swift,
        // sinon `@main` est refusé.
        .executableTarget(
            name: "OMPConsole",
            dependencies: ["ConsoleCore"],
            path: "Sources/OMPConsole"
        ),
        // Tests en Swift Testing, jamais XCTest : sous les Command Line Tools
        // seuls, XCTest n'existe pas (D2).
        .testTarget(
            name: "OMPConsoleTests",
            dependencies: ["OMPConsole", "ConsoleCore"],
            path: "Tests/OMPConsoleTests"
        ),
    ]
)
