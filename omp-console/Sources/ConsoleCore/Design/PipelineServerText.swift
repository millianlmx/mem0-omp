// Le vocabulaire du SERVEUR DE PIPELINES (omp-harness, sur le VPS), partagé par la
// coque Mac et l'app iOS : titres, états, gestes et messages d'échec. Les écrans
// n'écrivent aucune phrase eux-mêmes (règles `design-ios`, `typographie-et-glossaire-francais`).
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?, « » avec espaces insécables) et glossaire GLOSSAIRE.md.

public enum PipelineServerText {
    public static let title = L10n.text("Serveur de pipelines")
    public static let open = L10n.text("Serveur")
    public static let close = L10n.text("Fermer")
    public static let refresh = L10n.text("Actualiser")

    // MARK: - Configuration

    public static let setupTitle = L10n.text("Relier le serveur")
    public static let setupExplanation =
        L10n.text("Le serveur conduit les features de bout en bout sur le VPS. Collez le code d’appairage qu’affiche harness.sh pair : il porte l’adresse, le jeton et la mémoire du serveur. À défaut, saisissez l’adresse publiée par Tailscale et le jeton d’accès.")
    public static let addressLabel = L10n.text("Code d’appairage ou adresse")
    public static let addressPrompt = L10n.text("omp1:… ou vps.exemple.ts.net")
    public static let tokenLabel = L10n.text("Jeton d’accès")
    public static let save = L10n.text("Relier")
    public static let forget = L10n.text("Oublier ce serveur")
    public static let forgetConfirm = L10n.text("Oublier ce serveur ?")
    public static let forgetMessage = L10n.text("L’adresse et le jeton d’accès sont effacés de cet appareil. Le serveur, lui, continue.")
    /// Les symboles SF de l'état du flux et du choix d'une option.
    public static let liveSymbol = "dot.radiowaves.left.and.right"
    public static let offlineSymbol = "wifi.slash"
    public static let chosenSymbol = "checkmark.circle.fill"
    public static let optionSymbol = "circle"
    public static let live = L10n.text("Mises à jour en direct")
    public static let offline = L10n.text("Hors ligne : dernière boîte reçue")

    // MARK: - Sections

    public static let toDecide = L10n.text("À trancher")
    public static let toDecideHint = L10n.text("Des décisions irréversibles que les agents n’ont pas prises. La feature reprend quand toutes ont leur réponse.")
    public static let toValidateHint = L10n.text("Revue terminée : le serveur attend votre accord pour fusionner.")
    public static let toReview = L10n.text("Décisions prises seules")
    public static let toReviewHint = L10n.text("Chaque choix est un point de reprise. Le renverser fait reprendre la feature à cet endroit.")
    public static let inProgress = L10n.text("Features en cours")
    public static let nothingPending = L10n.text("Rien n’attend votre décision.")
    public static let nothingInProgress = L10n.text("Aucune feature en cours.")

    // MARK: - Gestes

    public static let answer = L10n.text("Répondre")
    public static let answerPlaceholder = L10n.text("Votre réponse")
    public static let approve = L10n.text("Valider et fusionner")
    public static let refuse = L10n.text("Refuser")
    public static let accept = L10n.text("Accepter")
    public static let reverse = L10n.text("Renverser…")
    public static let reverseTitle = L10n.text("Renverser la décision")
    public static let reverseOption = L10n.text("Choix retenu")
    public static let reasonLabel = L10n.text("Raison")
    public static let reasonHint = L10n.text("La raison rejoint la mémoire du projet : les agents ne rouvriront plus la question.")
    public static let refuseTitle = L10n.text("Refuser le verdict")
    public static let send = L10n.text("Envoyer")
    public static let cancel = L10n.text("Annuler")
    public static let stopFeature = L10n.text("Arrêter la feature")
    public static let stopConfirm = L10n.text("Arrêter cette feature ?")
    public static let stopMessage = L10n.text("Le travail en cours s’arrête. La branche reste, pour inspection.")
    public static let acceptRecommended = L10n.text("Accepter les recommandations")
    public static let reasonOptional = L10n.text("Raison (facultatif)")
    public static let acceptAll = L10n.text("Tout accepter")
    public static let retry = L10n.text("Relancer")
    public static let retryConfirm = L10n.text("Relancer cette feature ?")
    public static let retryMessage = L10n.text("La feature repart de son étape en cours, sur sa branche.")
    public static let revertFeature = L10n.text("Annuler la feature")
    public static let revertConfirm = L10n.text("Annuler cette feature fusionnée ?")
    public static let revertMessage = L10n.text("Ses changements sont retirés de la branche principale. Une feature de suite reprend ce qui doit l’être.")
    /// Une décision tranchée par le serveur à l'échéance d'une escalade restée sans réponse.
    public static let decidedAtDeadline = L10n.text("Tranchée à l’échéance")
    /// Une décision prise par l'agent, non validée par l'humain.
    public static let decidedByAgent = L10n.text("Choix de l’agent, non validé")

    // MARK: - Lignes

    /// « n° 3 · Séparateur CSV → virgule »
    public static func decisionLine(seq: Int, question: String, chosen: String) -> String {
        L10n.format("n° %lld · %@ → %@", seq, question, chosen)
    }

    /// Le motif donné par l'agent.
    public static func rationale(_ text: String) -> String { L10n.format("Motif : %@", text) }

    /// La proposition de l'agent, pour une escalade.
    public static func proposal(_ text: String) -> String { L10n.format("Proposé par l’agent : %@", text) }

    /// L'option recommandée par l'agent, pour une escalade.
    public static func recommended(_ text: String) -> String { L10n.format("Recommandé : %@", text) }

    /// « Tout accepter : Export CSV », quand plusieurs features ont des décisions à relire.
    public static func acceptAllLine(_ title: String) -> String { L10n.format("Tout accepter : %@", title) }

    /// La reprise différée d'une feature en file : « Reprise à 14:05 ».
    public static func resumeAt(_ time: String) -> String { L10n.format("Reprise à %@", time) }

    /// « Dernier échec : limite de débit »
    public static func lastFailure(_ cause: String) -> String { L10n.format("Dernier échec : %@", cause) }

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
        case "timeout": L10n.text("délai dépassé")
        case "rate_limit": L10n.text("limite de débit")
        case "network": L10n.text("réseau")
        case "provider": L10n.text("fournisseur indisponible")
        case "context": L10n.text("contexte dépassé")
        case "runner": L10n.text("agent interrompu")
        case "missing_output": L10n.text("livrable absent")
        case "aborted": L10n.text("interrompu")
        default: L10n.text("autre cause")
        }
    }

    public static func modules(_ list: [String]) -> String { L10n.format("Modules : %@", list.joined(separator: ", ")) }

    public static func fixes(_ count: Int) -> String { count == 1 ? L10n.text("1 correction") : L10n.format("%lld corrections", count) }

    public static func pending(_ count: Int) -> String {
        count == 0 ? nothingPending : (count == 1 ? L10n.text("1 décision attend") : L10n.format("%lld décisions attendent", count))
    }

    // MARK: - Direct d'une session

    /// Le titre de la feuille et le geste qui l'ouvre, sur une feature.
    public static let sessionTitle = L10n.text("Session en direct")
    /// Le symbole SF du geste « Session en direct ».
    public static let sessionSymbol = "text.bubble"
    public static let sessionWorking = L10n.text("Un agent travaille sur cette feature.")
    public static let sessionIdle = L10n.text("Aucun agent ne travaille sur cette feature en ce moment.")
    public static let sessionConnecting = L10n.text("Connexion au direct…")
    public static let sessionReconnecting = L10n.text("Direct interrompu : reconnexion…")
    public static let sessionEmpty = L10n.text("Rien à montrer pour l’instant : le direct commence au prochain message de l’agent.")
    public static let sessionThinking = L10n.text("Raisonnement")
    public static let sessionResult = L10n.text("Résultat")
    public static let sessionFollowEnd = L10n.text("Suivre la fin")
    public static let sessionFollowEndSymbol = "arrow.down.to.line"

    /// L'outil que l'agent emploie à l'instant.
    public static func sessionNow(_ tool: String) -> String { L10n.format("En cours : %@", tool) }

    /// L'en-tête d'un groupe d'entrées : « Étape /impl ».
    public static func sessionStep(_ label: String) -> String { L10n.format("Étape %@", label) }

    /// Un signal de la session, d'après son code serveur.
    public static func sessionNotice(_ code: String) -> String {
        switch code {
        case "compaction": L10n.text("L’agent compacte son contexte.")
        case "retry": L10n.text("Erreur passagère du fournisseur : l’agent réessaie.")
        default: L10n.text("Signal de la session")
        }
    }

    /// L'état d'un outil, pour VoiceOver.
    public static func toolStatus(_ raw: String?) -> String {
        switch raw {
        case "running": L10n.text("en cours")
        case "ok": L10n.text("terminé")
        case "error": L10n.text("en échec")
        default: L10n.text("état inconnu")
        }
    }

    /// « bash, en échec : npm test », la ligne d'un outil lue par VoiceOver.
    public static func toolLine(tool: String, status: String?, text: String) -> String {
        text.isEmpty ? L10n.format("%@, %@", tool, toolStatus(status)) : L10n.format("%@, %@ : %@", tool, toolStatus(status), text)
    }

    /// Le symbole SF d'une entrée du direct, selon sa sorte et l'état d'un outil.
    public static func sessionEntrySymbol(kind: String, status: String?) -> String {
        switch (kind, status) {
        case ("tool", "error"): "xmark.octagon"
        case ("tool", "ok"): "checkmark.circle"
        case ("tool", _): "gearshape"
        case ("thinking", _): "brain"
        case ("notice", _): "info.circle"
        default: "text.bubble"
        }
    }

    // MARK: - États

    public static func state(_ raw: String) -> String {
        switch raw {
        case "queued": L10n.text("En file")
        case "running": L10n.text("En cours")
        case "escalated": L10n.text("Escaladée")
        case "awaiting_human": L10n.text("À valider")
        case "merging": L10n.text("Fusion en cours")
        case "merged": L10n.text("Fusionnée")
        case "failed": L10n.text("En échec")
        case "cancelled": L10n.text("Arrêtée")
        default: L10n.text("État inconnu")
        }
    }

    /// Les étapes, sous leur nom de commande (la correspondance avec les valeurs du
    /// serveur vit dans ConsoleClient, `HarnessRun.stepLabel`).
    public static let stepReq = "/req"
    public static let stepSpecs = "/specs"
    public static let stepImpl = "/impl"
    public static let stepReview = "/review"
    public static let stepFix = L10n.text("Correction")

    public static func category(_ raw: String) -> String {
        switch raw {
        case "schema": L10n.text("Schéma de données")
        case "public_api": L10n.text("Protocole public")
        case "deletion": L10n.text("Suppression")
        default: L10n.text("Décision")
        }
    }

    public static func risk(_ raw: String) -> String {
        switch raw {
        case "low": L10n.text("Risque faible")
        case "medium": L10n.text("Risque moyen")
        case "high": L10n.text("Risque élevé")
        default: L10n.text("Risque inconnu")
        }
    }

    public static let weakVerdict = L10n.text("Verdict faible : lisez les différences, pas seulement le verdict.")
    public static let blockers = L10n.text("Bloquants")
    public static let risks = L10n.text("Risques")
    public static let unverified = L10n.text("Non vérifié")

    // MARK: - Accueil

    public static let notConfigured = L10n.text("Aucun serveur relié. Les pipelines tournent sur le serveur du VPS : reliez-le pour les voir et les lancer.")
    public static let configure = L10n.text("Relier le serveur…")
    public static let specsToValidate = L10n.text("Specs à valider")
    public static let specsToValidateHint = L10n.text("Les specs sont écrites : la feature attend votre accord avant /impl.")
    public static let verdictsToValidate = L10n.text("Verdicts à valider")

    /// Les compteurs du résumé de l'accueil.
    public static func countLine(_ count: Int, one: String, many: String) -> String {
        count == 1 ? "1 \(one)" : "\(count) \(many)"
    }

    public static func escalationCount(_ count: Int) -> String { countLine(count, one: L10n.text("question à trancher"), many: L10n.text("questions à trancher")) }
    public static func specsCount(_ count: Int) -> String { countLine(count, one: L10n.text("specs à valider"), many: L10n.text("specs à valider")) }
    public static func verdictCount(_ count: Int) -> String { countLine(count, one: L10n.text("verdict à valider"), many: L10n.text("verdicts à valider")) }
    public static func decisionCount(_ count: Int) -> String { countLine(count, one: L10n.text("décision à relire"), many: L10n.text("décisions à relire")) }
    public static func activeCount(_ count: Int) -> String { countLine(count, one: L10n.text("feature en cours"), many: L10n.text("features en cours")) }
    public static func auditCount(_ count: Int) -> String { countLine(count, one: L10n.text("audit à trier"), many: L10n.text("audits à trier")) }

    // MARK: - Specs

    public static let readSpecs = L10n.text("Lire les specs")
    public static let approveSpecs = L10n.text("Valider les specs")
    public static let refuseSpecsTitle = L10n.text("Refuser les specs")
    public static let specsHint = L10n.text("Le refus et sa raison font réécrire les specs ; la raison rejoint la mémoire du projet.")

    // MARK: - Lancements

    public static let repoLabel = L10n.text("Dépôt")
    public static let noRepo = L10n.text("Le serveur ne déclare aucun dépôt. Ajoutez-en un à sa configuration.")
    public static let launchRunTitle = L10n.text("Nouvelle feature")
    public static let launchRunHint = L10n.text("Le serveur la conduit seul : besoins, specs (à valider), implémentation, revue, fusion.")
    public static let titleLabel = L10n.text("Titre")
    public static let requestLabel = L10n.text("Demande")
    /// Les chemins que la feature touchera : ce sont eux qui décident du parallélisme.
    public static let modulesLabel = L10n.text("Modules touchés (facultatif, ex. src/api, docs)")
    /// Un jeton en lecture seule : la boîte se lit, les gestes se font ailleurs.
    public static let readOnly = L10n.text("Cet appareil a un accès en lecture seule : les gestes et les lancements se font depuis un appareil opérateur.")
    public static let launch = L10n.text("Lancer")
    public static let allRuns = L10n.text("Toutes les features")
    public static let noRun = L10n.text("Aucune feature sur ce serveur.")

    // MARK: - Projets

    public static let projectsTitle = L10n.text("Projets")
    public static let launchProjectTitle = L10n.text("Nouveau projet")
    public static let launchProjectHint = L10n.text("Chaque feature part en pipeline ; celles dont les modules sont disjoints tournent en parallèle.")
    public static let projectTitleLabel = L10n.text("Nom du projet")
    public static let addFeature = L10n.text("Ajouter une feature")
    public static let removeFeature = L10n.text("Retirer")
    public static let noProject = L10n.text("Aucun projet sur ce serveur.")
    public static let projectDone = L10n.text("Terminé")
    public static let projectActive = L10n.text("En cours")

    /// « 3 features · 1 fusionnée »
    public static func projectLine(total: Int, merged: Int) -> String {
        let features = countLine(total, one: L10n.text("feature"), many: L10n.text("features"))
        let mergedLine = countLine(merged, one: L10n.text("fusionnée"), many: L10n.text("fusionnées"))
        return "\(features) · \(mergedLine)"
    }

    // MARK: - Audits

    public static let launchAuditTitle = L10n.text("Nouvel audit")
    public static let launchAuditHint = L10n.text("Un agent lit la branche principale sans rien modifier, puis propose des faiblesses à corriger et des features.")
    public static let focusLabel = L10n.text("Périmètre")
    public static let focusPrompt = L10n.text("Vide : le dépôt entier")
    public static let noAudit = L10n.text("Aucun audit sur ce serveur.")
    public static let launchProposals = L10n.text("Lancer la sélection en projet")
    public static let cancelAudit = L10n.text("Annuler l’audit")
    public static let weakness = L10n.text("Faiblesse")
    public static let feature = L10n.text("Feature")
    public static let wholeRepo = L10n.text("Dépôt entier")

    public static func auditState(_ raw: String) -> String {
        switch raw {
        case "queued": L10n.text("En file")
        case "analysing": L10n.text("Analyse en cours")
        case "proposed": L10n.text("Propositions à trier")
        case "launched": L10n.text("Lancé en projet")
        case "failed": L10n.text("En échec")
        case "cancelled": L10n.text("Annulé")
        default: L10n.text("État inconnu")
        }
    }

    /// Le titre par défaut du projet issu d'un audit.
    public static func auditProjectTitle(_ focus: String) -> String {
        focus.isEmpty ? L10n.text("Audit du dépôt") : L10n.format("Audit : %@", focus)
    }

    // MARK: - Statistiques

    public static let noStats = L10n.text("Les statistiques arrivent avec le premier échange du serveur.")
    public static let statsRuns = L10n.text("Features")
    public static let statsSteps = L10n.text("Étapes")
    public static let statsTests = L10n.text("Tests")
    public static let statsCapacity = L10n.text("Capacité du serveur")
    public static let total = L10n.text("Total")
    public static let mergedWeek = L10n.text("Fusionnées sur 7 jours")
    public static let mergeRate = L10n.text("Taux de fusion")
    public static let leadTime = L10n.text("Délai médian jusqu’à la fusion")
    public static let fixesPerMerge = L10n.text("Corrections par fusion")
    public static let testsCached = L10n.text("Résultats repris du cache")
    public static let testsRetried = L10n.text("Relancés après un manque de mémoire")
    public static let runners = L10n.text("Agents")
    public static let heavySlots = L10n.text("Jobs de tests")
    public static let memoryFree = L10n.text("Mémoire disponible")
    public static let notAvailable = "—"

    public static func percent(_ ratio: Double) -> String { L10n.format("%lld %%", Int((ratio * 100).rounded())) }

    /// Une durée en secondes, arrondie à l'unité utile.
    public static func duration(_ seconds: Double) -> String {
        let value = Int(seconds.rounded())
        if value < 60 { return "\(value) s" }
        if value < 3600 { return "\(value / 60) min" }
        return "\(value / 3600) h \(value % 3600 / 60) min"
    }

    public static func slots(used: Int, capacity: Int) -> String { L10n.format("%lld sur %lld", used, capacity) }

    public static func mebibytes(_ value: Double) -> String { L10n.format("%lld Mio", Int(value.rounded())) }

    /// « /impl · 12 · 1 en échec · médiane 4 min »
    public static func stepLine(label: String, count: Int, failed: Int, median: Double?) -> String {
        var parts = [label, "\(count)"]
        if failed > 0 { parts.append(L10n.format("%lld en échec", failed)) }
        if let median { parts.append(L10n.format("médiane %@", duration(median))) }
        return parts.joined(separator: " · ")
    }

    // MARK: - Fournisseurs et modèles (admin)

    public static let providersOpen = L10n.text("Fournisseurs et modèles")
    public static let providersTitle = L10n.text("Fournisseurs et modèles")
    public static let providersHint =
        L10n.text("Les clés partent vers le serveur et n’en reviennent jamais. Chaque agent lancé ensuite reçoit les fournisseurs et les modèles déclarés ici.")
    public static let chainsTitle = L10n.text("Modèles par niveau")
    public static let chainsHint =
        L10n.text("Pour chaque niveau, les modèles à essayer dans l’ordre, sous la forme fournisseur/modèle, séparés par des virgules. Un fournisseur à court de débit fait passer au suivant ; un niveau vide prend celui du dessus.")
    public static let chainsPrompt = "anthropic/claude-sonnet-5-5"
    public static let chainsFromApps = L10n.text("Modèles choisis depuis les apps")
    public static let chainsFromServer = L10n.text("Modèles de la configuration du serveur")
    public static let saveChains = L10n.text("Enregistrer les modèles")
    public static let resetChains = L10n.text("Revenir aux modèles du serveur")
    public static let invalidChain = L10n.text("Chaque modèle s’écrit fournisseur/modèle, séparé du suivant par une virgule.")
    public static let providersSection = L10n.text("Fournisseurs")
    public static let noProvider = L10n.text("Aucun fournisseur déclaré.")
    public static let addProvider = L10n.text("Ajouter un fournisseur…")
    public static let newProviderTitle = L10n.text("Nouveau fournisseur")
    public static let editProvider = L10n.text("Modifier")
    public static let removeProvider = L10n.text("Retirer")
    public static let removeProviderConfirm = L10n.text("Retirer ce fournisseur ?")
    public static let removeProviderMessage = L10n.text("Sa clé est effacée du serveur. Un fournisseur encore nommé dans les modèles par niveau ne peut pas partir.")
    public static let providerFromServer = L10n.text("Déclaré par la configuration du serveur")
    public static let kindLabel = L10n.text("Fournisseur")
    public static let providerNameLabel = L10n.text("Nom")
    public static let providerNamePrompt = "vps-ollama"
    public static let providerAddressLabel = L10n.text("Adresse")
    public static let providerAddressPrompt = L10n.text("Adresse du service, souvent terminée par /v1")
    public static let protocolLabel = L10n.text("Protocole")
    public static let providerModelsLabel = L10n.text("Modèles")
    public static let providerModelsPrompt = "qwen3-coder, llama3.3"
    public static let keyLabel = L10n.text("Clé")
    public static let keyPrompt = L10n.text("Clé du fournisseur")
    public static let removeKey = L10n.text("Effacer la clé déclarée")
    public static let noKey = L10n.text("Sans clé")
    public static let limitTitle = L10n.text("Débit (facultatif)")
    public static let capacityLabel = L10n.text("Requêtes d’avance")
    public static let refillLabel = L10n.text("Requêtes par minute")
    public static let limitHint = L10n.text("Vide : sans limite. Au-delà, les agents attendent ou passent au modèle suivant.")
    public static let saveProvider = L10n.text("Enregistrer")
    public static let compatibleHint = L10n.text("Un service compatible OpenAI (Ollama, vLLM, LiteLLM…) joint par le serveur, par exemple l’Ollama du VPS ou un oMLX publié par Tailscale.")

    // Les abonnements : connectés dans le navigateur, sans clé.
    public static let loginsSection = L10n.text("Abonnements")
    public static let loginsHint =
        L10n.text("Connectez un abonnement (Claude Pro ou Max, ChatGPT Plus ou Pro, Gemini…) à la place d’une clé. La connexion se fait dans votre navigateur ; ses identifiants restent sur le serveur, chez les agents.")
    public static let noLoginProvider = L10n.text("Le serveur ne propose aucun abonnement à connecter.")
    public static let loginConnect = L10n.text("Connecter")
    public static let loginReconnect = L10n.text("Reconnecter")
    public static let loginConnected = L10n.text("Connecté")
    public static let loginNotConnected = L10n.text("Non connecté")
    public static let loginStarting = L10n.text("Le serveur prépare la connexion…")
    public static let loginOpen = L10n.text("Ouvrir la page de connexion")
    public static let loginOpenHint =
        L10n.text("Connectez-vous sur la page qui s’ouvre. Si elle finit sur un code, ou sur une erreur à une adresse « localhost », copiez ce code ou cette adresse entière et collez-le ci-dessous.")
    public static let loginCodeLabel = L10n.text("Code ou adresse de la page finale")
    public static let loginCodePrompt = L10n.text("Collez le code ou l’adresse")
    public static let loginSend = L10n.text("Envoyer le code")
    public static let loginVerifying = L10n.text("Le serveur vérifie le code…")
    public static let loginDone = L10n.text("Abonnement connecté. Les agents s’en servent dès qu’un modèle par niveau le nomme.")
    public static let loginCancelled = L10n.text("Connexion abandonnée : rien n’a été enregistré.")
    public static let loginTerminalHint =
        L10n.text("Certains abonnements ne se connectent qu’au terminal du serveur : lancez-y omp avec le profil des agents, puis la commande de connexion.")
    public static let loginCancel = L10n.text("Abandonner")
    public static let loginClose = L10n.text("Fermer")
    public static let subscriptionKey = L10n.text("Connexion par abonnement")

    /// Le titre d'une connexion en cours.
    public static func loginTitle(_ name: String) -> String { L10n.format("Connexion à %@", name) }

    /// L'échec d'une connexion, avec le motif du serveur.
    public static func loginFailed(_ motive: String) -> String {
        motive.isEmpty ? L10n.text("La connexion a échoué.") : L10n.format("La connexion a échoué : %@", motive)
    }

    /// L'état d'un abonnement chez les agents du serveur.
    public static func loginState(connected: Bool) -> String { connected ? loginConnected : loginNotConnected }

    // Ce qui empêche un fournisseur de partir.
    public static let providerNameProblem = L10n.text("Le nom s’écrit en minuscules, chiffres et tirets, une lettre d’abord, 32 caractères au plus.")
    public static let providerReservedProblem = L10n.text("Ce nom est réservé au serveur oMLX du Mac : choisissez-en un autre.")
    public static let providerAddressProblem = L10n.text("L’adresse commence par http ou https, sans espace.")
    public static let providerModelsProblem = L10n.text("Indiquez au moins un modèle.")
    public static let providerKeyProblem = L10n.text("La clé compte au moins 8 caractères, sans espace.")
    public static let providerLimitProblem = L10n.text("Le débit demande les deux nombres, chacun au moins égal à 1.")

    /// L'origine des modèles par niveau, puis la règle de saisie.
    public static func chainsFooter(fromApps: Bool) -> String {
        "\(fromApps ? chainsFromApps : chainsFromServer). \(chainsHint)"
    }

    /// Le nom d'un niveau de modèles.
    public static func tier(_ raw: String) -> String {
        switch raw {
        case "fast": L10n.text("Rapide")
        case "standard": L10n.text("Standard")
        case "heavy": L10n.text("Approfondi")
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
        case "openai-compatible": L10n.text("Compatible OpenAI")
        case "oauth": L10n.text("Abonnement")
        default: raw
        }
    }

    /// Le nom d'un protocole d'un fournisseur compatible.
    public static func providerProtocol(_ raw: String) -> String {
        switch raw {
        case "openai-completions": L10n.text("Complétions OpenAI")
        case "openai-responses": L10n.text("Réponses OpenAI")
        case "anthropic-messages": L10n.text("Messages Anthropic")
        default: raw
        }
    }

    /// L'état de la clé : « Clé ••••9f3c » ou « Sans clé ».
    public static func keyState(hasKey: Bool, hint: String?) -> String {
        guard hasKey else { return noKey }
        return hint.map { L10n.format("Clé ••••%@", $0) } ?? keyLabel
    }

    /// L'invite du champ de clé d'un fournisseur qui en a déjà une.
    public static func keepKeyPrompt(_ hint: String) -> String { L10n.format("Vide : la clé ••••%@ reste", hint) }

    /// « Compatible OpenAI · 2 modèles · Clé ••••9f3c »
    public static func providerLine(kind: String, models: Int, key: String) -> String {
        var parts = [providerKind(kind)]
        if models > 0 { parts.append(countLine(models, one: L10n.text("modèle"), many: L10n.text("modèles"))) }
        parts.append(key)
        return parts.joined(separator: " · ")
    }

    // MARK: - Échecs (cause, puis remède)

    public static let invalidAddress = L10n.text("Cette adresse n’est pas valide. Saisissez le nom du serveur publié par Tailscale.")
    public static let unauthorized = L10n.text("Le serveur refuse ce jeton d’accès. Copiez-le de nouveau depuis le serveur.")
    public static let unreachable = L10n.text("Le serveur de pipelines ne répond pas. Vérifiez qu’il tourne et que Tailscale est connecté.")
    public static let timedOut = L10n.text("Le serveur de pipelines met trop de temps à répondre. Réessayez dans un instant.")
    public static let unreadable = L10n.text("La réponse du serveur est illisible pour cette version de l’app. Mettez l’app à jour.")

    /// Un geste refusé par le serveur, avec son motif quand il en donne un.
    public static func rejected(_ motive: String) -> String {
        motive.isEmpty ? L10n.text("Le serveur a refusé ce geste.") : L10n.format("Le serveur a refusé ce geste : %@", motive)
    }

    /// Un geste que l'accès de cet appareil ne permet pas (lecture seule, ou autre dépôt).
    public static func forbidden(_ motive: String) -> String {
        motive.isEmpty
            ? L10n.text("L’accès de cet appareil ne permet pas ce geste. Demandez un accès opérateur à l’administrateur du serveur.")
            : L10n.format("L’accès de cet appareil ne permet pas ce geste : %@", motive)
    }

    /// Un autre appareil a agi sur la feature entre-temps : rien n'a été fait, la boîte est relue.
    public static let stale = L10n.text("Cette feature a changé depuis votre dernière lecture. La boîte vient d’être relue : refaites le geste si besoin.")
}
