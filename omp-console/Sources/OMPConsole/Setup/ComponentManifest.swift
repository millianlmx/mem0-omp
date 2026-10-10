// Le manifeste des composants que l'app INSTALLE elle-même (S-1, BR-1).
//
// Les valeurs sont figées sur la Documentation du contrat (mesures du 2026-10-04) :
// omp 18.6.0 (binaire autonome GitHub, sha256 de SHA256SUMS.txt), podman 6.1.3
// (pkg d'installation, sha256 du fichier `shasums` de la même release), l'image
// de machine alignée sur le podman épinglé, et les deux images de la pile.
//
// Évoluer un composant = changer UNE valeur ici : le reste de l'app (chemins,
// vérifications) en dérive.

import Foundation

/// Un fichier distant à télécharger, avec son empreinte et sa taille attendues.
struct RemoteFile: Equatable, Sendable {
    let url: URL
    let sha256: String
    let bytes: Int64
}

/// Les composants de l'app, à leurs versions épinglées.
struct ComponentManifest: Equatable, Sendable {
    let ompVersion: String
    let omp: RemoteFile
    let podmanVersion: String
    let podmanInstaller: RemoteFile
    /// La référence `machine init` de l'image de VM podman.
    let machineImage: String
    /// L'image Qdrant tirée par la pile de l'app.
    let qdrantImage: String
    /// Le dépôt de l'image mem0-http construite par l'app ; l'étiquette complète
    /// est dérivée de l'empreinte des sources embarquées (`StackSources`), jamais
    /// d'un simple numéro de version — un `:1` figé ne verrait pas une source
    /// modifiée (bogue du passé, S-7).
    let stackImageRepository: String

    /// L'étiquette de l'image mem0-http pour une empreinte de sources donnée :
    /// `<dépôt>:<12 premiers caractères hexadécimaux>`.
    func stackImageTag(fingerprint: String) -> String {
        "\(stackImageRepository):\(fingerprint.prefix(12))"
    }

    static let current = ComponentManifest(
        ompVersion: "18.6.0",
        omp: RemoteFile(
            url: URL(string: "https://github.com/can1357/oh-my-pi/releases/download/v18.6.0/omp-darwin-arm64")!,
            sha256: "bf7f20fbe3a41f3fae9cb3f8c5bfe52797ced272db7c91a205b0abf91f144f15",
            bytes: 208_135_408
        ),
        podmanVersion: "6.1.3",
        podmanInstaller: RemoteFile(
            url: URL(string: "https://github.com/containers/podman/releases/download/v6.1.3/podman-installer-macos-arm64.pkg")!,
            sha256: "84400d0539b5df0b2f00e9165463d4c17de51933244d1ea4b9cc54d8f05e4de9",
            bytes: 76_397_043
        ),
        machineImage: "docker://quay.io/podman/machine-os:6.1",
        qdrantImage: "docker.io/qdrant/qdrant:v1.19.0",
        stackImageRepository: "omp-console-mem0-http"
    )
}
