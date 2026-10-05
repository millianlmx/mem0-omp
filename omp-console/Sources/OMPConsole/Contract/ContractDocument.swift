// Le socle PUR de la feuille Contrat (S-1 … S-4) : le moment de validation d'une
// carte, le découpage du contrat par section, le chemin du fichier et sa lecture.
//
// Aucune vue, aucune E/S hors `FilesReader` : `moment(for:)`, `titles(for:)`,
// `section(in:title:)` et `path(worktree:)` sont des fonctions pures, vérifiables
// sans rendre de vue (patron `HomePresentation`).
//
// Le magasin d'état ne contient JAMAIS le texte du contrat — seulement son sha1
// (`LotFeature.contractHash`) : la console lit donc le FICHIER, à l'instant de
// l'ouverture, dans le worktree de la feature (`<worktree>/.omp/pipeline/contract.md`).

import Foundation

// --- moment et sections (S-1, S-2) -------------------------------------------

/// Le moment de validation auquel une carte donne lieu : les deux jalons dont le
/// contrat porte le texte à accepter. `waitKind == .review` n'en est jamais un
/// (hors périmètre).
enum ContractMoment: String, Sendable {
    case besoins
    case specs
}

/// Une section requise du contrat : son titre, et son texte VERBATIM quand le
/// fichier la porte (`nil` quand la section est absente — jamais un texte vide
/// deviné).
struct ContractSection: Equatable, Sendable {
    var title: String
    var text: String?
}

/// Ce que la lecture du contrat a rendu (S-3) : les sections requises, un fichier
/// absent, ou un fichier illisible.
enum ContractContent: Equatable, Sendable {
    case sections([ContractSection])
    case missing
    case unreadable(ContractUnreadable)
}

/// La raison d'une illisibilité (S-3) : le fichier n'est pas du texte UTF-8, ou
/// le système a refusé la lecture.
enum ContractUnreadable: Equatable, Sendable {
    case notText(bytes: Int)
    case error(String)
}

enum ContractDocument {
    /// Le moment de validation d'une carte (S-1), dans l'ordre de ses règles —
    /// la première qui s'applique gagne :
    ///
    /// 1. une feature `waiting` sur le jalon specs ⇒ `.specs` ;
    /// 2. un maillon `req` qui attend une réponse — question `ask` EN VOL (la
    ///    collecte de session, `state: running`, `waitKind: null`) ou feature
    ///    `waiting`/`answer` — ⇒ `.besoins` ;
    /// 3. sinon aucun moment.
    ///
    /// Garde appliquée APRÈS : sans worktree (`nil` ou vide), le contrat n'est
    /// localisable nulle part — donc aucun moment. Une carte sans `action` n'a
    /// jamais de moment.
    static func moment(for card: KanbanCard) -> ContractMoment? {
        guard let action = card.action else { return nil }
        let moment: ContractMoment?
        if action.featureState == .waiting, action.waitKind == .specs {
            moment = .specs
        } else if card.phase == .req,
                  action.run?.pendingAsk != nil
                    || (action.featureState == .waiting && action.waitKind == .answer) {
            moment = .besoins
        } else {
            moment = nil
        }
        guard moment != nil, let worktree = action.worktree, !worktree.isEmpty else { return nil }
        return moment
    }

    /// Les titres requis d'un moment (S-2) : c'est la liste ET l'ordre
    /// d'affichage. Aucune autre section n'est lue ni montrée, même présente.
    static func titles(for moment: ContractMoment) -> [String] {
        switch moment {
        case .besoins: ["Besoins", "Critères d'acceptation"]
        case .specs: ["Spécifications", "Lots"]
        }
    }

    /// La section `## <titre>` du contrat, texte VERBATIM (S-2) : de la ligne du
    /// titre INCLUSE à la ligne qui précède la prochaine ligne dont le texte
    /// rogné commence par `## `, ou la fin du fichier.
    ///
    /// La DERNIÈRE occurrence fait foi (parité `contractSection`, contract.ts) :
    /// un maillon qui AJOUTE une section au lieu de remplacer l'ancienne doit
    /// être lu. L'ancrage est un test de LIGNE ENTIÈRE : la chaîne `## Lots`
    /// citée dans un paragraphe ne compte pas.
    static func section(in markdown: String, title: String) -> ContractSection {
        let header = "## \(title)"
        let lines = lineRanges(in: markdown)
        guard let head = lines.lastIndex(where: { trimmedLine($0.text) == header }) else {
            return ContractSection(title: title, text: nil)
        }
        let end = lines[(head + 1)...].first(where: { trimmedLine($0.text).hasPrefix("## ") })?.start
            ?? markdown.endIndex
        return ContractSection(title: title, text: String(markdown[lines[head].start..<end]))
    }

    // --- chemin et lecture (S-3) ---------------------------------------------

    /// Le chemin du contrat d'un worktree : le chemin relatif de `FilesModel`,
    /// jamais un second littéral.
    static func path(worktree: String) -> String {
        joinPath(worktree, FilesModel.contractRelativePath)
    }

    /// La lecture du contrat, traduite pour la feuille (S-3) : une entrée par
    /// titre requis de `titles(for:)`, présente ou non. Aucune borne de taille —
    /// un contrat de plus de 100 000 caractères est lu et rendu en entier.
    static func read(path: String, moment: ContractMoment, fileManager: FileManager) -> ContractContent {
        switch FilesReader.read(path: path, fileManager: fileManager) {
        case .text(let markdown):
            return .sections(titles(for: moment).map { section(in: markdown, title: $0) })
        case .missing:
            return .missing
        case .binary(let bytes):
            return .unreadable(.notText(bytes: bytes))
        case .unreadable(let reason):
            return .unreadable(.error(reason))
        }
    }

    // --- outils de découpage --------------------------------------------------

    /// Les lignes du fichier avec leur point de départ dans la chaîne d'origine :
    /// c'est lui qui rend le texte d'une section VERBATIM (le séparateur `\n`
    /// reste hors du texte de la ligne, donc dans la tranche).
    private static func lineRanges(in markdown: String) -> [(start: String.Index, text: Substring)] {
        var result: [(start: String.Index, text: Substring)] = []
        var start = markdown.startIndex
        var index = markdown.startIndex
        while index < markdown.endIndex {
            if markdown[index] == "\n" {
                result.append((start: start, text: markdown[start..<index]))
                start = markdown.index(after: index)
            }
            index = markdown.index(after: index)
        }
        if start < markdown.endIndex {
            result.append((start: start, text: markdown[start...]))
        }
        return result
    }

    /// `trim()` de contract.ts : les espaces, tabulations et fins de ligne de bord
    /// sont tolérés — le titre est comparé au reste près.
    private static func trimmedLine(_ line: Substring) -> String {
        line.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
