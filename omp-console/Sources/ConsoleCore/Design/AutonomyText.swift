// Le vocabulaire de l'AUTONOMIE PAR PALIERS, partagé par la coque Mac et l'app iOS : la
// page Système › Autonomie (règles par dépôt, décisions prises seules, propositions de
// palier), la carte « décision prise seule » d'À traiter (porte franchie, règle, preuves)
// et le type de travail de la feuille de création.
//
// Les codes du serveur (type de travail, porte, qui franchit la porte, statut d'une
// décision) se traduisent ici, une seule fois pour les deux apps ; un code inconnu de
// cette version se rend tel quel. Les mots qui existent ailleurs (Revue, Annuler) se
// reprennent de `PipelineServerText`.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?) et glossaire GLOSSAIRE.md.

public enum AutonomyText {
    // MARK: - Page Système › Autonomie

    public static let pageTitle = L10n.text("Autonomie")
    public static let pageSummary = L10n.text("Règles par dépôt, décisions prises seules et propositions de palier.")
    public static let pageSymbol = "slider.horizontal.3"
    public static let readOnlyHint = L10n.text("Cette page se lit seulement : le serveur ne change jamais une règle seul. Pour modifier un palier, éditez la configuration du serveur.")
    public static let rulesTitle = L10n.text("Règles par dépôt")
    public static let rulesFooter = L10n.text("Pour un type de travail, la première règle qui correspond s’applique. Sans règle, toute attente reste à l’humain.")
    public static let noRules = L10n.text("Aucune règle : toute attente reste à l’humain.")
    public static let validationsTitle = L10n.text("Décisions prises seules")
    public static let validationsFooter = L10n.text("Chacune dit la règle et les preuves qui l’ont permise. Elle s’accepte ou se renverse comme toute décision prise seule, depuis À traiter.")
    public static let noValidations = L10n.text("Le serveur n’a rien validé seul sur la période.")
    public static let proposalsTitle = L10n.text("Propositions de palier")
    public static let proposalsFooter = L10n.text("Le serveur propose, il ne change jamais une règle : la modification suggérée se fait dans la configuration du serveur.")
    public static let noProposals = L10n.text("Aucune proposition pour l’instant.")
    public static let changesTitle = L10n.text("Modification de configuration suggérée")

    public static func ruleTitle(rank: Int, kind: String) -> String {
        L10n.format("Règle %lld : %@", rank, kindName(kind))
    }

    /// Ce qu'une règle compare à une feature : son type, la taille de ses différences, ses fichiers et ses étiquettes.
    public static func matchSummary(kind: String, maxDiffLines: Int?, paths: [String], labels: [String]) -> String {
        var parts = [kindName(kind)]
        if let maxDiffLines { parts.append(L10n.format("au plus %lld lignes de différences", maxDiffLines)) }
        if !paths.isEmpty { parts.append(L10n.format("fichiers : %@", paths.joined(separator: ", "))) }
        if !labels.isEmpty { parts.append(L10n.format("étiquettes : %@", labels.joined(separator: ", "))) }
        return parts.joined(separator: ", ")
    }

    /// Ce qu'une règle exige d'être prouvé avant de valider seule.
    public static func requireSummary(reproTest: Bool, greenChecks: Bool, proofs: Bool) -> String {
        var parts: [String] = []
        if reproTest { parts.append(L10n.text("test de reproduction vert")) }
        if greenChecks { parts.append(L10n.text("suite complète verte")) }
        if proofs { parts.append(L10n.text("critères d’acceptation prouvés")) }
        return parts.isEmpty ? L10n.text("aucune exigence") : parts.joined(separator: ", ")
    }

    /// Qui franchit chaque porte d'une règle.
    public static func gatesSummary(specs: String, review: String) -> String {
        L10n.format("specs : %@, revue : %@", who(specs), who(review))
    }

    // MARK: - Porte franchie, règle et preuves (carte d'À traiter, page Système)

    public static let validatedAlone = L10n.text("Validé seul par le serveur (autonomie)")
    public static let factGate = L10n.text("Porte franchie")
    public static let factRuleHeader = L10n.text("Correspond à")
    public static let factRequire = L10n.text("Exigences")
    public static let factRuleGates = L10n.text("Portes de la règle")
    public static let factKind = L10n.text("Type de travail")
    public static let factLabels = L10n.text("Étiquettes")
    public static let factGateReasons = L10n.text("Raisons de porte des specs")
    public static let factDiff = L10n.text("Différences")
    public static let factTests = L10n.text("Suite complète")
    public static let factRepro = L10n.text("Test de reproduction")
    public static let factCriteria = L10n.text("Critères prouvés")
    public static let none = L10n.text("aucune")
    public static let noneMasculine = L10n.text("aucun")

    public static func factRule(rank: Int) -> String { L10n.format("Règle n° %lld", rank) }

    /// La porte franchie : les specs, avant l'implémentation, ou la revue, avant la fusion.
    public static func gateCrossed(_ raw: String) -> String {
        switch raw {
        case "specs": L10n.text("specs (avant l’implémentation)")
        case "review": L10n.text("revue (avant la fusion)")
        default: raw
        }
    }

    public static func diffFigures(lines: Int, serverLimit: Int?, ruleLimit: Int?) -> String {
        switch (serverLimit, ruleLimit) {
        case (let server?, let rule?): L10n.format("%lld lignes (seuil du serveur %lld, de la règle %lld)", lines, server, rule)
        case (let server?, nil): L10n.format("%lld lignes (seuil du serveur %lld)", lines, server)
        case (nil, let rule?): L10n.format("%lld lignes (seuil de la règle %lld)", lines, rule)
        case (nil, nil): L10n.format("%lld lignes", lines)
        }
    }

    public static func testsResult(_ raw: String, sha: String?) -> String {
        let result = switch raw {
        case "pass": L10n.text("verte")
        default: raw
        }
        guard let sha, !sha.isEmpty else { return result }
        return L10n.format("%@ sur l’arbre %@", result, String(sha.prefix(8)))
    }

    /// Qui franchit une porte : l'humain, ou le serveur une fois les preuves faites.
    public static func who(_ raw: String) -> String {
        switch raw {
        case "human": L10n.text("l’humain")
        case "auto": L10n.text("le serveur")
        default: raw
        }
    }

    /// Le statut d'une décision prise seule par l'autonomie.
    public static func validationStatus(_ raw: String) -> String {
        switch raw {
        case "auto": L10n.text("À accepter ou à renverser")
        case "accepted": L10n.text("Acceptée")
        case "reversed": L10n.text("Renversée")
        case "superseded": L10n.text("Remplacée")
        default: raw
        }
    }

    // MARK: - Propositions de palier

    public static func proposalTitle(raise: Bool, kind: String, gate: String) -> String {
        raise
            ? L10n.format("Monter d’un palier : %@, porte %@", kindName(kind), gateWord(gate))
            : L10n.format("Baisser d’un palier : %@, porte %@", kindName(kind), gateWord(gate))
    }

    public static func proposalToday(current: String, rule: Int?) -> String {
        guard let rule else { return L10n.format("Aujourd’hui : %@ franchit la porte (aucune règle)", who(current)) }
        return L10n.format("Aujourd’hui : %@ franchit la porte (règle n° %lld)", who(current), rule)
    }

    public static func proposalFigures(runs: Int, passages: Int, corrections: Int, rate: Double) -> String {
        L10n.format("Sur la période : %lld features, %lld passages, %lld corrigées (%@)", runs, passages, corrections, PipelineServerText.percent(rate))
    }

    // MARK: - Création d'une feature

    public static let launchKindLabel = L10n.text("Type de travail (facultatif)")
    public static let launchKindNone = L10n.text("Aucun")
    public static let launchLabelsLabel = L10n.text("Étiquettes (facultatif)")
    public static let launchLabelsPrompt = L10n.text("ex. correctif, interface")
    public static let launchLabelsInvalid = L10n.text("Au plus 20 étiquettes, de 50 caractères chacune.")
    public static let launchKindHint = L10n.text("Le type et les étiquettes laissent le serveur valider seul certaines attentes, selon les règles du dépôt. Sans type, la feature reste à l’humain.")

    // MARK: - Codes du serveur

    public static func kindName(_ raw: String) -> String {
        switch raw {
        case "bug": L10n.text("Bug")
        case "feature": L10n.text("Feature")
        case "docs": L10n.text("Documentation")
        case "deps": L10n.text("Dépendances")
        case "test": L10n.text("Tests")
        default: raw
        }
    }

    /// La porte dans une phrase : « specs » ou « revue ».
    public static func gateWord(_ raw: String) -> String {
        switch raw {
        case "specs": L10n.text("specs")
        case "review": L10n.text("revue")
        default: raw
        }
    }
}
