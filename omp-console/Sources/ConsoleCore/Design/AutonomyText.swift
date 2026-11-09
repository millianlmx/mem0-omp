// Le vocabulaire de l’AUTONOMIE PAR PALIERS, partagé par la coque Mac et l’app iOS :
// le type de travail et les labels d’un lancement, la carte d’une validation prise
// seule (porte franchie, règle, preuves) et la page Système › Autonomie (règles par
// dépôt, validations prises seules, propositions de palier).
//
// Les types de travail du serveur se traduisent ici ; les autres codes (porte, mode
// d’une porte, état de la suite, sens d’une proposition) sont lus par `ConsoleClient`
// (HarnessAutonomy.swift), qui choisit le mot. Un code inconnu se rend tel quel.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?) et glossaire GLOSSAIRE.md.

public enum AutonomyText {
    // MARK: - Lancement typé

    public static let kindLabel = L10n.text("Type de travail")
    public static let kindUnset = L10n.text("Non précisé")
    public static let labelsLabel = L10n.text("Labels")
    public static let labelsPrompt = L10n.text("Par exemple : urgent, paiement")
    public static let labelsInvalid = L10n.text("20 labels au plus, de 1 à 50 caractères chacun.")
    public static let kindHint = L10n.text("Le type et les labels choisissent la règle d’autonomie du dépôt ; sans type, chaque porte attend l’humain.")

    /// Le nom d’un type de travail du serveur (`WORK_KINDS`).
    public static func kind(_ raw: String) -> String {
        switch raw {
        case "bug": L10n.text("Bogue")
        case "feature": L10n.text("Feature")
        case "docs": L10n.text("Documentation")
        case "deps": L10n.text("Dépendances")
        case "test": L10n.text("Tests")
        default: raw
        }
    }

    // MARK: - Validation prise seule

    public static let decidedAlone = L10n.text("Validée seule par l’autonomie")
    public static let proofsTitle = L10n.text("Preuves constatées")
    public static let none = L10n.text("aucun")
    public static let decidedAloneSymbol = "checkmark.seal"
    /// Les deux portes.
    public static let gateSpecs = L10n.text("specs")
    public static let gateReview = L10n.text("revue")
    /// Les deux modes d’une porte.
    public static let modeHuman = L10n.text("humain")
    public static let modeAuto = L10n.text("autonomie")

    /// « Porte franchie : revue ».
    public static func gateCrossed(_ gate: String) -> String { L10n.format("Porte franchie : %@", gate) }
    /// « Règle 2 : Bogue · 50 lignes de différences au plus ».
    public static func rule(_ rank: Int, _ match: String) -> String { L10n.format("Règle %lld : %@", rank, match) }
    /// « 50 lignes de différences au plus ».
    public static func maxDiffLines(_ count: Int) -> String { L10n.format("%lld lignes de différences au plus", count) }
    /// « sous docs/, README.md ».
    public static func paths(_ list: String) -> String { L10n.format("sous %@", list) }
    /// « labels : urgent, paiement ».
    public static func labels(_ list: String) -> String { L10n.format("labels : %@", list) }
    /// « Exige : test de reproduction, suite complète verte ».
    public static func requires(_ list: String) -> String { L10n.format("Exige : %@", list) }
    public static let requireReproTest = L10n.text("test de reproduction")
    public static let requireGreenChecks = L10n.text("suite complète verte")
    public static let requireProofs = L10n.text("critères prouvés")
    /// « Specs : humain · revue : autonomie ».
    public static func gates(specs: String, review: String) -> String { L10n.format("Specs : %@ · revue : %@", specs, review) }

    /// « Type de travail : Bogue ».
    public static func proofKind(_ kind: String) -> String { L10n.format("Type de travail : %@", kind) }
    /// « Labels : urgent ».
    public static func proofLabels(_ list: String) -> String { L10n.format("Labels : %@", list) }
    /// « Raisons de porte des specs : aucune ».
    public static let proofNoGateReason = L10n.text("Raisons de porte des specs : aucune")
    public static func proofGateReasons(_ list: String) -> String { L10n.format("Raisons de porte des specs : %@", list) }
    /// « Lignes de différences : 40 (seuil du serveur 30, de la règle 50) ».
    public static func proofDiff(_ lines: Int, server: Int, rule: Int) -> String {
        L10n.format("Lignes de différences : %lld (seuil du serveur %lld, de la règle %lld)", lines, server, rule)
    }
    /// « Suite complète : verte sur 1a2b3c4d ».
    public static func proofSuiteGreen(_ sha: String) -> String { L10n.format("Suite complète : verte sur %@", sha) }
    /// L’état de la suite complète sur l’arbre jugé.
    public static let suiteGreen = L10n.text("verte")
    public static let suiteRed = L10n.text("rouge")
    public static let suiteNotRun = L10n.text("non lancée")
    /// « Suite complète : rouge ».
    public static func proofSuite(_ state: String) -> String { L10n.format("Suite complète : %@", state) }
    /// « Test de reproduction : test/x.test.ts ».
    public static func proofRepro(_ list: String) -> String { L10n.format("Test de reproduction : %@", list) }
    /// « Critères prouvés : AC-1, AC-2 ».
    public static func proofCriteria(_ list: String) -> String { L10n.format("Critères prouvés : %@", list) }

    // MARK: - Page Système › Autonomie

    public static let readOnlyHint = L10n.text("Lecture seule : les règles se changent dans la configuration du serveur.")
    public static let rulesTitle = L10n.text("Règles par dépôt")
    public static let noRule = L10n.text("Aucun dépôt n’a de règle : chaque porte attend l’humain.")
    /// « Sans règle : demo, docs » : les dépôts dont chaque porte attend l’humain.
    public static func withoutRule(_ list: String) -> String { L10n.format("Sans règle, chaque porte attend l’humain : %@", list) }
    public static let validationsTitle = L10n.text("Validations prises seules")
    public static let validationsHint = L10n.text("Celles de la fenêtre d’apprentissage, les plus récentes d’abord.")
    public static let proposalsTitle = L10n.text("Propositions de palier")
    public static let proposalsHint = L10n.text("Calculées sur les gestes humains ; rien n’est appliqué : la modification se fait dans la configuration du serveur.")
    public static let changesTitle = L10n.text("Modification suggérée")

    /// « Bogue · revue : passer à l’autonomie ».
    public static func proposalRaise(kind: String, gate: String) -> String { L10n.format("%@ · %@ : passer à l’autonomie", kind, gate) }
    /// « Bogue · revue : rendre à l’humain ».
    public static func proposalLower(kind: String, gate: String) -> String { L10n.format("%@ · %@ : rendre à l’humain", kind, gate) }
    /// « Règle 1 aujourd’hui » ou « Aucune règle aujourd’hui ».
    public static func currentRule(_ rank: Int?) -> String {
        guard let rank else { return L10n.text("Aucune règle ne s’applique aujourd’hui") }
        return L10n.format("Règle %lld aujourd’hui", rank)
    }
    /// « Jugées : 12 · corrigées : 0 (0 %) ».
    public static func proposalStats(runs: Int, corrections: Int, rate: String) -> String {
        L10n.format("Jugées : %lld · corrigées : %lld (%@)", runs, corrections, rate)
    }
    /// « 2 propositions » : l’état de la rangée du hub.
    public static func proposalsCount(_ count: Int) -> String {
        count == 1 ? L10n.text("1 proposition") : L10n.format("%lld propositions", count)
    }
}
