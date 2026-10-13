// TOUTES les phrases que Siri prononce pour le noyau vocal (noyau-vocal-partage,
// S-6), en UN endroit (convention `HomeText`) : les fonctions de `Voice/` calculent,
// elles ne composent jamais une phrase. Le vocabulaire entendu (mots de rang,
// suffixes d'ordinal) vit aussi ici : c'est du français, jugé par la même garde.
//
// VIT DANS `ConsoleCore`.

import Foundation

public enum VoiceSpeechText {
    // --- recherche d'une feature (S-2) -------------------------------------------
    public static let featureNotFound = "Je n’ai trouvé aucune feature en cours à ce nom."

    /// « Plusieurs features correspondent : a, b, c et 2 autres. Laquelle ? »
    public static func featureAmbiguous(titles: [String], more: Int) -> String {
        "Plusieurs features correspondent : \(list(titles, more: more)). Laquelle ?"
    }

    // --- correspondance réponse → option (S-3) -----------------------------------
    public static let nothingHeard = "Je n’ai pas entendu de réponse."

    /// Rappelle TOUS les choix possibles, sans plafond : à la voix, l'utilisateur
    /// ne voit pas l'écran.
    public static func optionNotFound(labels: [String]) -> String {
        guard !labels.isEmpty else { return "Je n’ai pas reconnu cette option." }
        return "Je n’ai pas reconnu cette option. Choix possibles : \(list(labels, more: 0))."
    }

    /// Les mots retirés d'une réponse avant d'y lire un rang (« la », « option 2 »).
    static let rankFillers: Set<String> = ["la", "le", "l", "option", "choix", "reponse", "numero"]

    /// Les suffixes d'un ordinal écrit en chiffres (« 1er », « 2e », « 3ème »).
    static let rankSuffixes: Set<String> = ["er", "re", "ere", "e", "eme"]

    /// Les rangs dits en toutes lettres, sous forme normalisée.
    static let rankWords: [String: Int] = [
        "premier": 1, "premiere": 1, "un": 1, "une": 1,
        "deuxieme": 2, "second": 2, "seconde": 2, "deux": 2,
        "troisieme": 3, "trois": 3,
        "quatrieme": 4, "quatre": 4,
        "cinquieme": 5, "cinq": 5,
        "sixieme": 6, "six": 6,
        "septieme": 7, "sept": 7,
        "huitieme": 8, "huit": 8,
        "neuvieme": 9, "neuf": 9,
        "dixieme": 10, "dix": 10,
    ]

    /// Les mots qui désignent la dernière option.
    static let lastWords: Set<String> = ["dernier", "derniere"]

    // --- liste des attentes (S-4) ------------------------------------------------
    public static let noPending = "Aucune demande ne vous attend."

    public static func pendingHeader(_ count: Int) -> String {
        count == 1 ? "1 demande vous attend : " : "\(count) demandes vous attendent : "
    }

    /// La source prononcée d'une attente sans sujet.
    static func pendingSource(_ nature: PendingNature) -> String {
        switch nature {
        case .question, .milestoneSpecs, .milestoneReview:
            return "pipeline"
        case .conduiteDialog:
            return "conduite de projet"
        case .sessionDialog:
            return "session OMP"
        case .auditEscalation:
            return "audit"
        }
    }

    static func pendingNature(_ nature: PendingNature) -> String {
        switch nature {
        case .question:
            return "question"
        case .milestoneSpecs:
            return "spécifications à valider"
        case .milestoneReview:
            return "revue à accepter"
        case .conduiteDialog:
            return "dialogue de conduite"
        case .sessionDialog:
            return "dialogue de session"
        case .auditEscalation:
            return "escalade d’audit"
        }
    }

    /// « source, nature « question » », ou « source, nature » sans question.
    static func pendingItem(source: String, nature: String, question: String) -> String {
        question.isEmpty ? "\(source), \(nature)" : "\(source), \(nature) « \(question) »"
    }

    /// L'en-tête, les éléments séparés par « ; », puis la fin.
    static func pendingPhrase(count: Int, items: [String], more: Int) -> String {
        let end: String
        switch more {
        case ...0: end = "."
        case 1: end = " ; et 1 autre."
        default: end = " ; et \(more) autres."
        }
        return pendingHeader(count) + items.joined(separator: " ; ") + end
    }

    // --- conversation des attentes (siri-iphone-questions-en-attente, S-1) ------
    /// Le total annoncé en tête de la conversation.
    public static func walkCount(_ count: Int) -> String {
        count == 1 ? "1 demande en attente." : "\(count) demandes en attente."
    }

    /// La présentation de la première attente, `item` étant `VoicePendingSummary.item`.
    public static func walkFirst(_ item: String) -> String {
        "La première : \(item)."
    }

    public static func walkNext(_ item: String) -> String {
        "La suivante : \(item)."
    }

    /// La présentation d'une attente dont la question a été remplacée.
    public static func walkReplaced(_ item: String) -> String {
        "La nouvelle question : \(item)."
    }

    /// Tous les choix d'une question, sans plafond.
    public static func choices(_ labels: [String]) -> String {
        "Choix possibles : \(list(labels, more: 0))."
    }

    public static let otherAnswerOffer = "Ou dites « autre réponse »."

    /// Le mot ENTENDU qui ouvre la dictée d'un texte libre, comparé après
    /// normalisation (`VoiceSpeech.normalized`).
    public static let otherAnswer = "autre réponse"

    public static let dictate = "Dictez votre réponse."

    /// Une attente qui ne se règle pas à la voix.
    public static let appOnly = "Elle est à traiter dans l’app, pas à la voix."

    public static let nextPrompt = "Passer à la suivante ?"

    /// La fin d'une conversation refusée ou abandonnée avant la suivante.
    public static let walkStopped = "D’accord, j’arrête là."

    /// Les options prononcées d'un dialogue `confirm`.
    public static let yes = "Oui"
    public static let no = "Non"

    /// Les phrases non vides de `phrases`, séparées par une espace : ce que Siri
    /// dit d'une traite.
    static func joined(_ phrases: [String]) -> String {
        phrases.filter { !$0.isEmpty }.joined(separator: " ")
    }

    // --- pilotage des pipelines -----------------------------------------------------
    /// La désignation de la feature d'un geste : les 3 premières éligibles, puis
    /// « et N autres ».
    public static func pilotAsk(_ gesture: VoicePilotGesture, titles: [String], more: Int) -> String {
        switch gesture {
        case .resume:
            return "Quelle feature reprendre ? \(list(titles, more: more))."
        case .stop:
            return "Quelle feature arrêter ? \(list(titles, more: more))."
        case .validateSpecs:
            return "De quelle feature valider les specs ? \(list(titles, more: more))."
        case .acceptReview:
            return "De quelle feature accepter la revue ? \(list(titles, more: more))."
        }
    }

    /// L'absence de feature éligible à un geste : rien n'est demandé.
    public static func pilotNone(_ gesture: VoicePilotGesture) -> String {
        switch gesture {
        case .resume:
            return "Aucune feature à reprendre."
        case .stop:
            return "Aucune feature à arrêter."
        case .validateSpecs:
            return "Aucune feature n’attend la validation de ses specs."
        case .acceptReview:
            return "Aucune feature n’attend l’acceptation de sa revue."
        }
    }

    /// Le choix du dépôt d'un lancement : TOUS les dépôts, sans plafond.
    public static func launchRepoAsk(labels: [String]) -> String {
        "Sur quel dépôt ? \(list(labels, more: 0))."
    }

    public static let launchTitleAsk = "Quel titre pour la feature ?"

    public static let launchNeedAsk = "Quel est le besoin ?"

    public static let launchNoRepo = "Le Mac ne connaît aucun dépôt, rien n’a été lancé."

    // --- issue d'un geste (S-5) --------------------------------------------------
    public static func issue(_ issue: VoiceIssue) -> String {
        switch issue {
        case let .sent(gesture, target):
            return sent(gesture, target: target.trimmingCharacters(in: .whitespacesAndNewlines))
        case .cancelled:
            return VoiceGestureText.cancelled
        case .misconfigured:
            return VoiceGestureText.misconfigured
        case .staleQuestion:
            return "La question a changé entre-temps, rien n’a été envoyé."
        case .invalidOption:
            return "Le Mac n’a pas accepté cette option, rien n’a été envoyé."
        case let .macRefused(motive):
            let m = motive.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !m.isEmpty else { return "Le Mac a refusé la demande." }
            return "Le Mac a refusé la demande : \(m)" + (endsSentence(m) ? "" : ".")
        case .notPaired:
            return "Cet appareil n’est appairé à aucun Mac. Ouvrez OMP Console pour l’appairer."
        case .macUnreachable:
            return "Le Mac est injoignable. Vérifiez qu’OMP Console y est ouvert et que le réseau est disponible."
        case let .incompatibleVersion(local, remote):
            guard let remote, remote != local else {
                return "OMP Console n’a pas la même version sur cet appareil et sur le Mac. Mettez à jour l’app la plus ancienne."
            }
            return local < remote
                ? "L’app de cet appareil est plus ancienne que celle du Mac. Mettez-la à jour."
                : "OMP Console sur le Mac est plus ancien que l’app de cet appareil. Mettez-le à jour."
        case .deviceLocked:
            return "Cet appareil est verrouillé. Déverrouillez-le, puis réessayez."
        case .stateUnreadable:
            return "OMP Console n’a pas pu lire l’état du Mac à temps, rien n’a été envoyé. Réessayez dans un instant."
        }
    }

    /// Le succès d'un geste, qui nomme le geste et sa cible `t` (déjà épurée).
    /// La cible d'un arrêt est le DÉPÔT : `card.stop` arrête toutes ses pipelines.
    /// Un message dicté à la session se dit « Reçu. », cible vide comprise.
    private static func sent(_ gesture: VoiceGesture, target t: String) -> String {
        if gesture == .promptHostedSession { return "Reçu." }
        guard !t.isEmpty else { return "C’est fait." }
        switch gesture {
        case .stopFeature:
            return "Les pipelines de \(t) sont arrêtées."
        case .validateSpecs:
            return "Les specs de la feature \(t) sont validées."
        case .acceptReview:
            return "La revue de la feature \(t) est acceptée."
        case .launchPipeline:
            return "La pipeline \(t) est lancée."
        case .answerOption:
            return "Votre choix est envoyé à \(t)."
        case .answerText:
            return "Votre réponse est envoyée à \(t)."
        case .answerProjectDialog:
            return "Votre réponse au dialogue de conduite \(t) est envoyée."
        case .answerHostedDialog:
            return "Votre réponse au dialogue de session \(t) est envoyée."
        case .answerAuditEscalation:
            return "Votre réponse à l’escalade d’audit \(t) est envoyée."
        case .promptHostedSession:
            return "Reçu."
        case .resume:
            return "La pipeline \(t) est reprise."
        case .consult:
            return "Consultation de \(t) terminée."
        }
    }

    /// Vrai si `text` finit déjà une phrase : point, point d'exclamation, point
    /// d'interrogation ou points de suspension (U+002E, U+0021, U+003F, U+2026).
    private static func endsSentence(_ text: String) -> Bool {
        guard let last = text.unicodeScalars.last else { return false }
        return [0x2E, 0x21, 0x3F, 0x2026].contains(last.value)
    }

    // --- dictée vers la session OMP ---------------------------------------------
    /// La question posée quand l'intent n'a reçu aucun message.
    public static let dictationPrompt = "Quel message ?"
    /// L'issue d'une dictée restée vide : rien n'est envoyé.
    public static let dictationEmpty = "Aucun message n’a été envoyé."

    // --- énumération --------------------------------------------------------------
    /// « a », « a et b », « a, b et c » ; avec `more > 0`, tous les éléments puis
    /// « et N autre(s) ».
    static func list(_ items: [String], more: Int) -> String {
        if more > 0 {
            let rest = more == 1 ? "1 autre" : "\(more) autres"
            return items.isEmpty ? rest : "\(items.joined(separator: ", ")) et \(rest)"
        }
        guard let last = items.last else { return "" }
        guard items.count > 1 else { return last }
        return "\(items.dropLast().joined(separator: ", ")) et \(last)"
    }
}
