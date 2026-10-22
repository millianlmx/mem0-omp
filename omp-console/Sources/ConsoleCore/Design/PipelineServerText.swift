// Le vocabulaire du SERVEUR DE PIPELINES (omp-harness, sur le VPS), partagé par la
// coque Mac et l'app iOS : titres, états, gestes et messages d'échec. Les écrans
// n'écrivent aucune phrase eux-mêmes (règles `design-ios`, `typographie-et-glossaire-francais`).
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?, « » avec espaces insécables) et glossaire GLOSSAIRE.md.

public enum PipelineServerText {
    public static let title = "Serveur de pipelines"
    public static let open = "Serveur"
    public static let close = "Fermer"
    public static let refresh = "Actualiser"

    // MARK: - Configuration

    public static let setupTitle = "Relier le serveur"
    public static let setupExplanation =
        "Le serveur conduit les features de bout en bout sur le VPS. Collez le code d’appairage qu’affiche harness.sh pair : il porte l’adresse, le jeton et la mémoire du serveur. À défaut, saisissez l’adresse publiée par Tailscale et le jeton d’accès."
    public static let addressLabel = "Code d’appairage ou adresse"
    public static let addressPrompt = "omp1:… ou vps.exemple.ts.net"
    public static let tokenLabel = "Jeton d’accès"
    public static let save = "Relier"
    public static let forget = "Oublier ce serveur"
    public static let forgetConfirm = "Oublier ce serveur ?"
    public static let forgetMessage = "L’adresse et le jeton d’accès sont effacés de cet appareil. Le serveur, lui, continue."
    /// Les symboles SF de l'état du flux et du choix d'une option.
    public static let liveSymbol = "dot.radiowaves.left.and.right"
    public static let offlineSymbol = "wifi.slash"
    public static let chosenSymbol = "checkmark.circle.fill"
    public static let optionSymbol = "circle"
    public static let live = "Mises à jour en direct"
    public static let offline = "Hors ligne : dernière boîte reçue"

    // MARK: - Sections

    public static let toDecide = "À trancher"
    public static let toDecideHint = "Des décisions irréversibles que les agents n’ont pas prises. La feature reprend quand toutes ont leur réponse."
    public static let toValidateHint = "Revue terminée : le serveur attend votre accord pour fusionner."
    public static let toReview = "Décisions prises seules"
    public static let toReviewHint = "Chaque choix est un point de reprise. Le renverser fait reprendre la feature à cet endroit."
    public static let inProgress = "Features en cours"
    public static let nothingPending = "Rien n’attend votre décision."
    public static let nothingInProgress = "Aucune feature en cours."

    // MARK: - Gestes

    public static let answer = "Répondre"
    public static let answerPlaceholder = "Votre réponse"
    public static let approve = "Valider et fusionner"
    public static let refuse = "Refuser"
    public static let accept = "Accepter"
    public static let reverse = "Renverser…"
    public static let reverseTitle = "Renverser la décision"
    public static let reverseOption = "Choix retenu"
    public static let reasonLabel = "Raison"
    public static let reasonHint = "La raison rejoint la mémoire du projet : les agents ne rouvriront plus la question."
    public static let refuseTitle = "Refuser le verdict"
    public static let send = "Envoyer"
    public static let cancel = "Annuler"
    public static let stopFeature = "Arrêter la feature"
    public static let stopConfirm = "Arrêter cette feature ?"
    public static let stopMessage = "Le travail en cours s’arrête. La branche reste, pour inspection."
    public static let acceptRecommended = "Accepter les recommandations"
    public static let reasonOptional = "Raison (facultatif)"
    public static let acceptAll = "Tout accepter"
    public static let retry = "Relancer"
    public static let retryConfirm = "Relancer cette feature ?"
    public static let retryMessage = "La feature repart de son étape en cours, sur sa branche."
    public static let revertFeature = "Annuler la feature"
    public static let revertConfirm = "Annuler cette feature fusionnée ?"
    public static let revertMessage = "Ses changements sont retirés de la branche principale. Une feature de suite reprend ce qui doit l’être."
    /// Une décision tranchée par le serveur à l'échéance d'une escalade restée sans réponse.
    public static let decidedAtDeadline = "Tranchée à l’échéance"
    /// Une décision prise par l'agent, non validée par l'humain.
    public static let decidedByAgent = "Choix de l’agent, non validé"

    // MARK: - Lignes

    /// « n° 3 · Séparateur CSV → virgule »
    public static func decisionLine(seq: Int, question: String, chosen: String) -> String {
        "n° \(seq) · \(question) → \(chosen)"
    }

    /// Le motif donné par l'agent.
    public static func rationale(_ text: String) -> String { "Motif : \(text)" }

    /// La proposition de l'agent, pour une escalade.
    public static func proposal(_ text: String) -> String { "Proposé par l’agent : \(text)" }

    /// L'option recommandée par l'agent, pour une escalade.
    public static func recommended(_ text: String) -> String { "Recommandé : \(text)" }

    /// « Tout accepter : Export CSV », quand plusieurs features ont des décisions à relire.
    public static func acceptAllLine(_ title: String) -> String { "Tout accepter : \(title)" }

    /// La reprise différée d'une feature en file : « Reprise à 14:05 ».
    public static func resumeAt(_ time: String) -> String { "Reprise à \(time)" }

    /// « Dernier échec : limite de débit »
    public static func lastFailure(_ cause: String) -> String { "Dernier échec : \(cause)" }

    /// Le statut d'une décision prise seule, quand il mérite un mot ; `nil` pour le cas ordinaire.
    public static func decisionStatus(_ raw: String) -> String? {
        switch raw {
        case "auto_timeout": decidedAtDeadline
        case "auto": decidedByAgent
        default: nil
        }
    }

    /// La cause d'un échec d'étape, telle que le serveur la classe.
    public static func failCause(_ raw: String) -> String {
        switch raw {
        case "timeout": "délai dépassé"
        case "rate_limit": "limite de débit"
        case "network": "réseau"
        case "provider": "fournisseur indisponible"
        case "context": "contexte dépassé"
        case "runner": "agent interrompu"
        case "missing_output": "livrable absent"
        case "aborted": "interrompu"
        default: "autre cause"
        }
    }

    public static func modules(_ list: [String]) -> String { "Modules : \(list.joined(separator: ", "))" }

    public static func fixes(_ count: Int) -> String { count == 1 ? "1 correction" : "\(count) corrections" }

    public static func pending(_ count: Int) -> String {
        count == 0 ? nothingPending : (count == 1 ? "1 décision attend" : "\(count) décisions attendent")
    }

    // MARK: - États

    public static func state(_ raw: String) -> String {
        switch raw {
        case "queued": "En file"
        case "running": "En cours"
        case "escalated": "Escaladée"
        case "awaiting_human": "À valider"
        case "merging": "Fusion en cours"
        case "merged": "Fusionnée"
        case "failed": "En échec"
        case "cancelled": "Arrêtée"
        default: "État inconnu"
        }
    }

    /// Les étapes, sous leur nom de commande (la correspondance avec les valeurs du
    /// serveur vit dans ConsoleClient, `HarnessRun.stepLabel`).
    public static let stepReq = "/req"
    public static let stepSpecs = "/specs"
    public static let stepImpl = "/impl"
    public static let stepReview = "/review"
    public static let stepFix = "Correction"

    public static func category(_ raw: String) -> String {
        switch raw {
        case "schema": "Schéma de données"
        case "public_api": "Protocole public"
        case "deletion": "Suppression"
        default: "Décision"
        }
    }

    public static func risk(_ raw: String) -> String {
        switch raw {
        case "low": "Risque faible"
        case "medium": "Risque moyen"
        case "high": "Risque élevé"
        default: "Risque inconnu"
        }
    }

    public static let weakVerdict = "Verdict faible : lisez les différences, pas seulement le verdict."
    public static let blockers = "Bloquants"
    public static let risks = "Risques"
    public static let unverified = "Non vérifié"

    // MARK: - Accueil

    public static let notConfigured = "Aucun serveur relié. Les pipelines tournent sur le serveur du VPS : reliez-le pour les voir et les lancer."
    public static let configure = "Relier le serveur…"
    public static let specsToValidate = "Specs à valider"
    public static let specsToValidateHint = "Les specs sont écrites : la feature attend votre accord avant /impl."
    public static let verdictsToValidate = "Verdicts à valider"

    /// Les compteurs du résumé de l'accueil.
    public static func countLine(_ count: Int, one: String, many: String) -> String {
        count == 1 ? "1 \(one)" : "\(count) \(many)"
    }

    public static func escalationCount(_ count: Int) -> String { countLine(count, one: "question à trancher", many: "questions à trancher") }
    public static func specsCount(_ count: Int) -> String { countLine(count, one: "specs à valider", many: "specs à valider") }
    public static func verdictCount(_ count: Int) -> String { countLine(count, one: "verdict à valider", many: "verdicts à valider") }
    public static func decisionCount(_ count: Int) -> String { countLine(count, one: "décision à relire", many: "décisions à relire") }
    public static func activeCount(_ count: Int) -> String { countLine(count, one: "feature en cours", many: "features en cours") }
    public static func auditCount(_ count: Int) -> String { countLine(count, one: "audit à trier", many: "audits à trier") }

    // MARK: - Specs

    public static let readSpecs = "Lire les specs"
    public static let approveSpecs = "Valider les specs"
    public static let refuseSpecsTitle = "Refuser les specs"
    public static let specsHint = "Le refus et sa raison font réécrire les specs ; la raison rejoint la mémoire du projet."

    // MARK: - Lancements

    public static let repoLabel = "Dépôt"
    public static let noRepo = "Le serveur ne déclare aucun dépôt. Ajoutez-en un à sa configuration."
    public static let launchRunTitle = "Nouvelle feature"
    public static let launchRunHint = "Le serveur la conduit seul : besoins, specs (à valider), implémentation, revue, fusion."
    public static let titleLabel = "Titre"
    public static let requestLabel = "Demande"
    /// Les chemins que la feature touchera : ce sont eux qui décident du parallélisme.
    public static let modulesLabel = "Modules touchés (facultatif, ex. src/api, docs)"
    /// Un jeton en lecture seule : la boîte se lit, les gestes se font ailleurs.
    public static let readOnly = "Cet appareil a un accès en lecture seule : les gestes et les lancements se font depuis un appareil opérateur."
    public static let launch = "Lancer"
    public static let allRuns = "Toutes les features"
    public static let noRun = "Aucune feature sur ce serveur."

    // MARK: - Projets

    public static let projectsTitle = "Projets"
    public static let launchProjectTitle = "Nouveau projet"
    public static let launchProjectHint = "Chaque feature part en pipeline ; celles dont les modules sont disjoints tournent en parallèle."
    public static let projectTitleLabel = "Nom du projet"
    public static let addFeature = "Ajouter une feature"
    public static let removeFeature = "Retirer"
    public static let noProject = "Aucun projet sur ce serveur."
    public static let projectDone = "Terminé"
    public static let projectActive = "En cours"

    /// « 3 features · 1 fusionnée »
    public static func projectLine(total: Int, merged: Int) -> String {
        "\(countLine(total, one: "feature", many: "features")) · \(countLine(merged, one: "fusionnée", many: "fusionnées"))"
    }

    // MARK: - Audits

    public static let launchAuditTitle = "Nouvel audit"
    public static let launchAuditHint = "Un agent lit la branche principale sans rien modifier, puis propose des faiblesses à corriger et des features."
    public static let focusLabel = "Périmètre"
    public static let focusPrompt = "Vide : le dépôt entier"
    public static let noAudit = "Aucun audit sur ce serveur."
    public static let launchProposals = "Lancer la sélection en projet"
    public static let cancelAudit = "Annuler l’audit"
    public static let weakness = "Faiblesse"
    public static let feature = "Feature"
    public static let wholeRepo = "Dépôt entier"

    public static func auditState(_ raw: String) -> String {
        switch raw {
        case "queued": "En file"
        case "analysing": "Analyse en cours"
        case "proposed": "Propositions à trier"
        case "launched": "Lancé en projet"
        case "failed": "En échec"
        case "cancelled": "Annulé"
        default: "État inconnu"
        }
    }

    /// Le titre par défaut du projet issu d'un audit.
    public static func auditProjectTitle(_ focus: String) -> String {
        focus.isEmpty ? "Audit du dépôt" : "Audit : \(focus)"
    }

    // MARK: - Statistiques

    public static let noStats = "Les statistiques arrivent avec le premier échange du serveur."
    public static let statsRuns = "Features"
    public static let statsSteps = "Étapes"
    public static let statsTests = "Tests"
    public static let statsCapacity = "Capacité du serveur"
    public static let total = "Total"
    public static let mergedWeek = "Fusionnées sur 7 jours"
    public static let mergeRate = "Taux de fusion"
    public static let leadTime = "Délai médian jusqu’à la fusion"
    public static let fixesPerMerge = "Corrections par fusion"
    public static let testsCached = "Résultats repris du cache"
    public static let testsRetried = "Relancés après un manque de mémoire"
    public static let runners = "Agents"
    public static let heavySlots = "Jobs de tests"
    public static let memoryFree = "Mémoire disponible"
    public static let notAvailable = "—"

    public static func percent(_ ratio: Double) -> String { "\(Int((ratio * 100).rounded())) %" }

    /// Une durée en secondes, arrondie à l'unité utile.
    public static func duration(_ seconds: Double) -> String {
        let value = Int(seconds.rounded())
        if value < 60 { return "\(value) s" }
        if value < 3600 { return "\(value / 60) min" }
        return "\(value / 3600) h \(value % 3600 / 60) min"
    }

    public static func slots(used: Int, capacity: Int) -> String { "\(used) sur \(capacity)" }

    public static func mebibytes(_ value: Double) -> String { "\(Int(value.rounded())) Mio" }

    /// « /impl · 12 · 1 en échec · médiane 4 min »
    public static func stepLine(label: String, count: Int, failed: Int, median: Double?) -> String {
        var parts = [label, "\(count)"]
        if failed > 0 { parts.append("\(failed) en échec") }
        if let median { parts.append("médiane \(duration(median))") }
        return parts.joined(separator: " · ")
    }

    // MARK: - Fournisseurs et modèles (admin)

    public static let providersOpen = "Fournisseurs et modèles"
    public static let providersTitle = "Fournisseurs et modèles"
    public static let providersHint =
        "Les clés partent vers le serveur et n’en reviennent jamais. Chaque agent lancé ensuite reçoit les fournisseurs et les modèles déclarés ici."
    public static let chainsTitle = "Modèles par niveau"
    public static let chainsHint =
        "Pour chaque niveau, les modèles à essayer dans l’ordre, sous la forme fournisseur/modèle, séparés par des virgules. Un fournisseur à court de débit fait passer au suivant ; un niveau vide prend celui du dessus."
    public static let chainsPrompt = "anthropic/claude-sonnet-5-5"
    public static let chainsFromApps = "Modèles choisis depuis les apps"
    public static let chainsFromServer = "Modèles de la configuration du serveur"
    public static let saveChains = "Enregistrer les modèles"
    public static let resetChains = "Revenir aux modèles du serveur"
    public static let invalidChain = "Chaque modèle s’écrit fournisseur/modèle, séparé du suivant par une virgule."
    public static let providersSection = "Fournisseurs"
    public static let noProvider = "Aucun fournisseur déclaré."
    public static let addProvider = "Ajouter un fournisseur…"
    public static let newProviderTitle = "Nouveau fournisseur"
    public static let editProvider = "Modifier"
    public static let removeProvider = "Retirer"
    public static let removeProviderConfirm = "Retirer ce fournisseur ?"
    public static let removeProviderMessage = "Sa clé est effacée du serveur. Un fournisseur encore nommé dans les modèles par niveau ne peut pas partir."
    public static let providerFromServer = "Déclaré par la configuration du serveur"
    public static let kindLabel = "Fournisseur"
    public static let providerNameLabel = "Nom"
    public static let providerNamePrompt = "vps-ollama"
    public static let providerAddressLabel = "Adresse"
    public static let providerAddressPrompt = "Adresse du service, souvent terminée par /v1"
    public static let protocolLabel = "Protocole"
    public static let providerModelsLabel = "Modèles"
    public static let providerModelsPrompt = "qwen3-coder, llama3.3"
    public static let keyLabel = "Clé"
    public static let keyPrompt = "Clé du fournisseur"
    public static let removeKey = "Effacer la clé déclarée"
    public static let noKey = "Sans clé"
    public static let limitTitle = "Débit (facultatif)"
    public static let capacityLabel = "Requêtes d’avance"
    public static let refillLabel = "Requêtes par minute"
    public static let limitHint = "Vide : sans limite. Au-delà, les agents attendent ou passent au modèle suivant."
    public static let saveProvider = "Enregistrer"
    public static let compatibleHint = "Un service compatible OpenAI (Ollama, vLLM, LiteLLM…) joint par le serveur, par exemple l’Ollama du VPS ou un oMLX publié par Tailscale."

    // Ce qui empêche un fournisseur de partir.
    public static let providerNameProblem = "Le nom s’écrit en minuscules, chiffres et tirets, une lettre d’abord, 32 caractères au plus."
    public static let providerReservedProblem = "Ce nom est réservé au serveur oMLX du Mac : choisissez-en un autre."
    public static let providerAddressProblem = "L’adresse commence par http ou https, sans espace."
    public static let providerModelsProblem = "Indiquez au moins un modèle."
    public static let providerKeyProblem = "La clé compte au moins 8 caractères, sans espace."
    public static let providerLimitProblem = "Le débit demande les deux nombres, chacun au moins égal à 1."

    /// L'origine des modèles par niveau, puis la règle de saisie.
    public static func chainsFooter(fromApps: Bool) -> String {
        "\(fromApps ? chainsFromApps : chainsFromServer). \(chainsHint)"
    }

    /// Le nom d'un niveau de modèles.
    public static func tier(_ raw: String) -> String {
        switch raw {
        case "fast": "Rapide"
        case "standard": "Standard"
        case "heavy": "Approfondi"
        default: raw
        }
    }

    /// Le nom d'une sorte de fournisseur.
    public static func providerKind(_ raw: String) -> String {
        switch raw {
        case "anthropic": "Anthropic"
        case "openai": "OpenAI"
        case "openrouter": "OpenRouter"
        case "google": "Google Gemini"
        case "mistral": "Mistral"
        case "xai": "xAI"
        case "openai-compatible": "Compatible OpenAI"
        default: raw
        }
    }

    /// Le nom d'un protocole d'un fournisseur compatible.
    public static func providerProtocol(_ raw: String) -> String {
        switch raw {
        case "openai-completions": "Complétions OpenAI"
        case "openai-responses": "Réponses OpenAI"
        case "anthropic-messages": "Messages Anthropic"
        default: raw
        }
    }

    /// L'état de la clé : « Clé ••••9f3c » ou « Sans clé ».
    public static func keyState(hasKey: Bool, hint: String?) -> String {
        guard hasKey else { return noKey }
        return hint.map { "Clé ••••\($0)" } ?? keyLabel
    }

    /// L'invite du champ de clé d'un fournisseur qui en a déjà une.
    public static func keepKeyPrompt(_ hint: String) -> String { "Vide : la clé ••••\(hint) reste" }

    /// « Compatible OpenAI · 2 modèles · Clé ••••9f3c »
    public static func providerLine(kind: String, models: Int, key: String) -> String {
        var parts = [providerKind(kind)]
        if models > 0 { parts.append(countLine(models, one: "modèle", many: "modèles")) }
        parts.append(key)
        return parts.joined(separator: " · ")
    }

    // MARK: - Échecs (cause, puis remède)

    public static let invalidAddress = "Cette adresse n’est pas valide. Saisissez le nom du serveur publié par Tailscale."
    public static let unauthorized = "Le serveur refuse ce jeton d’accès. Copiez-le de nouveau depuis le serveur."
    public static let unreachable = "Le serveur de pipelines ne répond pas. Vérifiez qu’il tourne et que Tailscale est connecté."
    public static let timedOut = "Le serveur de pipelines met trop de temps à répondre. Réessayez dans un instant."
    public static let unreadable = "La réponse du serveur est illisible pour cette version de l’app. Mettez l’app à jour."

    /// Un geste refusé par le serveur, avec son motif quand il en donne un.
    public static func rejected(_ motive: String) -> String {
        motive.isEmpty ? "Le serveur a refusé ce geste." : "Le serveur a refusé ce geste : \(motive)"
    }

    /// Un geste que l'accès de cet appareil ne permet pas (lecture seule, ou autre dépôt).
    public static func forbidden(_ motive: String) -> String {
        motive.isEmpty
            ? "L’accès de cet appareil ne permet pas ce geste. Demandez un accès opérateur à l’administrateur du serveur."
            : "L’accès de cet appareil ne permet pas ce geste : \(motive)"
    }

    /// Un autre appareil a agi sur la feature entre-temps : rien n'a été fait, la boîte est relue.
    public static let stale = "Cette feature a changé depuis votre dernière lecture. La boîte vient d’être relue : refaites le geste si besoin."
}
