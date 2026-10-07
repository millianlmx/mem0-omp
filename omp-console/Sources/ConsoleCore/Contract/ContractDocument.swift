// Le socle PUR de la feuille Contrat (S-1 … S-4) : le moment de validation d'une
// carte, le découpage du contrat par section et le chemin du fichier.
//
// Aucune vue, aucune E/S : `moment(for:)`, `titles(for:)`, `section(in:title:)`,
// `path(worktree:)` et `content(markdown:moment:)` sont des fonctions pures,
// vérifiables sans rendre de vue (patron `HomePresentation`). La LECTURE disque
// (`read(path:moment:fileManager:)`, `FilesReader`) reste déclarée par la coque
// macOS, en extension, dans `Sources/OMPConsole/Contract/`.
//
// Le magasin d'état ne contient JAMAIS le texte du contrat — seulement son sha1
// (`LotFeature.contractHash`) : la console lit donc le FICHIER, à l'instant de
// l'ouverture, dans le worktree de la feature (`<worktree>/.omp/pipeline/contract.md`).
//
// VIT DANS `ConsoleCore` : les deux coques découpent le contrat de la même façon.

import Foundation

// --- moment et sections (S-1, S-2) -------------------------------------------

/// Le moment de validation auquel une carte donne lieu : les deux jalons dont le
/// contrat porte le texte à accepter. `waitKind == .review` n'en est jamais un
/// (hors périmètre).
public enum ContractMoment: String, Sendable {
    case besoins
    case specs
}

/// Une section requise du contrat : son titre, et son texte VERBATIM quand le
/// fichier la porte (`nil` quand la section est absente — jamais un texte vide
/// deviné).
public struct ContractSection: Equatable, Sendable {
    public var title: String
    public var text: String?

    public init(title: String, text: String?) {
        self.title = title
        self.text = text
    }
}

/// Ce que la lecture du contrat a rendu (S-3) : les sections requises, un fichier
/// absent, ou un fichier illisible.
public enum ContractContent: Equatable, Sendable {
    case sections([ContractSection])
    case missing
    case unreadable(ContractUnreadable)
}

/// La raison d'une illisibilité (S-3) : le fichier n'est pas du texte UTF-8, ou
/// le système a refusé la lecture.
public enum ContractUnreadable: Equatable, Sendable {
    case notText(bytes: Int)
    case error(String)
}

public enum ContractDocument {
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
    public static func moment(for card: KanbanCard) -> ContractMoment? {
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
    public static func titles(for moment: ContractMoment) -> [String] {
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
    public static func section(in markdown: String, title: String) -> ContractSection {
        let header = "## \(title)"
        let lines = lineRanges(in: markdown)
        guard let head = lines.lastIndex(where: { trimmedLine($0.text) == header }) else {
            return ContractSection(title: title, text: nil)
        }
        let end = lines[(head + 1)...].first(where: { trimmedLine($0.text).hasPrefix("## ") })?.start
            ?? markdown.endIndex
        return ContractSection(title: title, text: String(markdown[lines[head].start..<end]))
    }

    // --- chemin et traduction (S-3) ------------------------------------------

    /// Le chemin du contrat d'un worktree : le chemin relatif de `ContractText`,
    /// jamais un second littéral.
    public static func path(worktree: String) -> String {
        joinPath(worktree, ContractText.relativePath)
    }

    /// Le découpage d'un markdown de contrat (S-3) : une section par titre requis
    /// de `titles(for:)`, présente ou non. C'est ce que fait la branche `.text` de
    /// la lecture disque — partagé pour que les deux coques lisent pareil.
    public static func content(markdown: String, moment: ContractMoment) -> ContractContent {
        .sections(titles(for: moment).map { section(in: markdown, title: $0) })
    }

    // --- outils de découpage --------------------------------------------------

    /// Les lignes du fichier avec leur point de départ dans la chaîne d'origine :
    /// c'est lui qui rend le texte d'une section VERBATIM (le séparateur `\n`
    /// reste hors du texte de la ligne, donc dans la tranche).
    public static func lineRanges(in markdown: String) -> [(start: String.Index, text: Substring)] {
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
    public static func trimmedLine(_ line: Substring) -> String {
        line.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
