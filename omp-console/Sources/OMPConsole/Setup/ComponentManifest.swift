// Le manifeste du composant que l'app INSTALLE elle-même (S-1, BR-1) : OMP seul,
// le service mémoire (mem0-rs) étant embarqué dans le bundle.
//
// Les valeurs sont figées sur la Documentation du contrat (mesures du 2026-10-04) :
// omp 18.6.0 (binaire autonome GitHub, sha256 de SHA256SUMS.txt).
//
// Évoluer le composant = changer UNE valeur ici : le reste de l'app (chemins,
// vérifications) en dérive.

import Foundation

/// Un fichier distant à télécharger, avec son empreinte et sa taille attendues.
struct RemoteFile: Equatable, Sendable {
    let url: URL
    let sha256: String
    let bytes: Int64
}

/// Le composant de l'app, à sa version épinglée.
struct ComponentManifest: Equatable, Sendable {
    let ompVersion: String
    let omp: RemoteFile

    static let current = ComponentManifest(
        ompVersion: "18.6.0",
        omp: RemoteFile(
            url: URL(string: "https://github.com/can1357/oh-my-pi/releases/download/v18.6.0/omp-darwin-arm64")!,
            sha256: "bf7f20fbe3a41f3fae9cb3f8c5bfe52797ced272db7c91a205b0abf91f144f15",
            bytes: 208_135_408
        )
    )
}
