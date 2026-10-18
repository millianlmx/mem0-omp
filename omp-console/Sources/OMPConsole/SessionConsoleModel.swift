// Modèle de la section « Session OMP » (S-10) : projet, prompt, dialogue, statut,
// disponibilités — et la conversation lisible de la session servie (S-15 de
// omp-console-redesign) : le fichier de session publié par l'API, suivi par un
// `SessionViewerModel` comme dans la visionneuse.
//
// Le modèle ne parle JAMAIS le protocole : il appelle la session servie et traduit
// ses erreurs en texte via `userMessage` — c'est le seul endroit qui produit du
// texte affiché pour un échec. Tout le reste de l'affichage est la donnée publiée
// par la session, montrée telle quelle.
//
// Deux invariants de S-9 sont tenus par la forme du code :
//   - le choix du projet n'est JAMAIS écrit en `UserDefaults` sans un geste
//     explicite : `select(projectRoot:)` est l'UNIQUE point d'écriture (appelé
//     par `chooseProject`, `launch(projectRoot:)` et le sélecteur des états
//     vides), `init` ne fait que LIRE ;
//   - la section « Session OMP » est à instance unique, donc « une seule session
//     servie » est structurellement vrai ; `canLaunch` est faux dès que l'état est
//     `launching|running|stopping`.
//
// Le modèle vit à l'échelle de l'APP (`@StateObject` sur la structure `App`), pas
// de la fenêtre : fermer la fenêtre pendant une session ne doit pas laisser de
// session orpheline, et l'accroche de terminaison doit exister avant la première
// ouverture de la fenêtre.

import AppKit
import Combine
import ConsoleCore
import Foundation

@MainActor
final class SessionConsoleModel: ObservableObject {
    /// Clé partagée avec la visionneuse de fichiers : elle vit dans `ProjectRoot`,
    /// seul propriétaire de la préférence.
    static let projectRootKey = ProjectRoot.defaultsKey

    let host: ServiceSessionModel

    @Published var projectRoot: URL?
    @Published var prompt: String = ""
    @Published var dialogText: String = ""
    @Published var selectedOptionIndex: Int?
    @Published var statusMessage: String = ""
    /// L'inspecteur « Détails techniques » (session et journal) est ouvert.
    @Published var technicalShown = false
    /// La conversation du fichier de session de la session servie ; `nil` tant
    /// qu'aucun fichier n'est connu.
    @Published private(set) var conversation: SessionViewerModel?

    // --- modèle et niveau de réflexion (model-selector-in-embedded-omp-session S-6) ---

    /// Le défaut OMP du projet choisi : lu par `GET /v1/projects/{root}/model` à
    /// chaque changement de projet et à chaque sortie de `.running` de l'hôte ;
    /// affiché tant qu'aucune session ne tourne.
    @Published private(set) var projectDefault = ServiceModelChoice(model: nil, thinkingLevel: nil)
    /// Le catalogue des modèles utilisables (`omp models --json`), ses noms
    /// lisibles et les efforts de chaque modèle.
    @Published private(set) var modelCatalog: ModelCatalogState = .loading
    @Published private(set) var modelNames: [String: String] = [:]
    @Published private(set) var modelThinking: [String: [String]] = [:]
    /// Le popover du sélecteur est ouvert ; le filtre, le brouillon et l'erreur
    /// vivent ici (aucun `@State` dans la vue).
    @Published var modelPickerShown = false
    @Published var modelFilter = ""
    @Published private(set) var draftModel: String?
    @Published var draftLevel: String?
    @Published private(set) var modelError: String?
    @Published private(set) var isApplyingModel = false

    private let defaults: UserDefaults
    private let fileManager: FileManager
    private let makeConversation: @MainActor (ViewerTarget) -> SessionViewerModel
    private let loadModelListing: @Sendable () async -> Result<ModelCatalogListing, ModelCatalogError>
    private var cancellables: Set<AnyCancellable> = []
    private var modelSelectorStarted = false
    private var hostWasRunning = false
    private var projectDefaultRoot: URL?

    init(
        host: ServiceSessionModel? = nil,
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default,
        makeConversation: @escaping @MainActor (ViewerTarget) -> SessionViewerModel = { SessionViewerModel(target: $0) },
        modelListingLoader: @escaping @Sendable () async -> Result<ModelCatalogListing, ModelCatalogError> = {
            await ModelCatalogLoader.loadListing()
        }
    ) {
        let host = host ?? ServiceSessionModel(purpose: "session")
        self.host = host
        self.defaults = defaults
        self.fileManager = fileManager
        self.makeConversation = makeConversation
        self.loadModelListing = modelListingLoader
        self.projectRoot = Self.restoredProjectRoot(defaults: defaults, fileManager: fileManager)
        self.statusMessage = Self.statusText(for: host.state)

        // Le statut suit l'ÉTAT, pas chaque trame : `removeDuplicates` évite qu'un
        // journal qui grandit écrase le message d'une commande expirée.
        host.$state
            .removeDuplicates()
            .sink { [weak self] _ in
                Task { @MainActor in self?.refreshStatus() }
            }
            .store(in: &cancellables)

        // … et le FICHIER de session : la conversation suit le fichier publié par
        // l'API. Une reprise garde le même fichier, donc la même conversation ; un
        // lancement neuf le remet à `nil`, puis en publie un autre.
        host.$sessionFile
            .removeDuplicates()
            .sink { [weak self] file in
                Task { @MainActor in self?.follow(sessionFile: file) }
            }
            .store(in: &cancellables)

        // Le défaut du projet est relu quand le projet change et quand la session
        // sort de `.running` (S-6) ; rien ne part tant que le sélecteur n'est pas
        // démarré (`startModelSelector`).
        $projectRoot
            .removeDuplicates()
            .sink { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.modelSelectorStarted else { return }
                    await self.refreshProjectDefault()
                }
            }
            .store(in: &cancellables)
        host.$state
            .removeDuplicates()
            .sink { [weak self] state in
                guard let self else { return }
                let running = state == .running
                let left = self.hostWasRunning && !running
                self.hostWasRunning = running
                guard left else { return }
                Task { @MainActor in
                    guard self.modelSelectorStarted else { return }
                    await self.refreshProjectDefault()
                }
            }
            .store(in: &cancellables)

        // Fermeture de l'app : l'unique chemin de sortie passe par la session.
        AppDelegate.terminateSession = { [weak self] in
            await self?.host.terminateForQuit()
        }
        // Inventaire du Quitter (mac-quitter-sans-confirmation, S-1).
        AppDelegate.sessionQuitActivity = { [weak self] in
            self?.quitActivity
        }
    }

    // MARK: - Persistance

    /// La règle vit dans `ProjectRoot` : la section « Session OMP » et la
    /// visionneuse de fichiers résolvent LE MÊME projet, avec la même préférence
    /// (`ProjectRoot.defaultsKey`) et la même règle de repli. Une clé PRÉSENTE mais
    /// invalide (dossier supprimé) ne déclenche pas le repli : l'utilisateur a
    /// choisi, et S-9 exige que ce choix ne soit pas réécrit tout seul.
    private static func restoredProjectRoot(defaults: UserDefaults, fileManager: FileManager) -> URL? {
        ProjectRoot.resolve(defaults: defaults, fileManager: fileManager)
    }

    // MARK: - Disponibilités (S-9)

    private var isProjectUsable: Bool {
        guard let projectRoot else { return false }
        var isDirectory: ObjCBool = false
        return fileManager.fileExists(atPath: projectRoot.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    /// L'état seul autorise un démarrage (S-1) : `canLaunch` y ajoute la
    /// disponibilité d'une racine de projet mémorisée. L'iPad, lui, apporte la
    /// sienne (`launch(projectRoot:)`), donc la route décide sur `canStart`.
    var canStart: Bool {
        switch host.state {
        case .idle, .stopped, .dead, .failed: return true
        default: return false
        }
    }

    var canLaunch: Bool { canStart && isProjectUsable }

    var canStop: Bool {
        switch host.state {
        case .launching, .running: return true
        default: return false
        }
    }

    /// La session vivante que le Quitter arrêtera, nommée par le dossier avec
    /// lequel ELLE a été lancée (`host.projectRoot`), pas par le projet choisi
    /// depuis (`projectRoot`), qui peut avoir changé.
    var quitActivity: QuitActivity? {
        guard canStop else { return nil }
        return .session(named: host.projectRoot?.lastPathComponent)
    }

    var canRelaunch: Bool {
        switch host.state {
        case .dead, .stopped, .failed: return true
        default: return false
        }
    }

    var canSendPrompt: Bool {
        promptRefusal(for: prompt) == nil
    }

    /// La SEULE règle d'acceptation d'un prompt, partagée par le champ de saisie et
    /// le geste `RemoteActions.prompt(message:)` (route distante, intent Mac). Le
    /// blanc est refusé avant tout contrôle d'état ; `nil` = le prompt peut partir.
    func promptRefusal(for message: String) -> GestureRefusal? {
        if message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .emptyText }
        switch host.state {
        case .idle:
            return .noHostedSession
        case .stopped, .dead, .failed:
            return .hostedSessionStopped
        case .launching, .stopping:
            return .sessionNotRunning
        case .running:
            break
        }
        if !host.dialogQueue.isEmpty { return .hostedDialogPending }
        return nil
    }

    var canAnswerDialog: Bool {
        guard let dialog = host.dialogQueue.first else { return false }
        switch dialog.method {
        case .select:
            guard let index = selectedOptionIndex else { return false }
            return dialog.options.indices.contains(index)
        case .confirm, .editor:
            return true
        case .input:
            return !dialogText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    /// Note de relance d'un état interrompu, dans l'inspecteur.
    var relaunchNote: String? {
        guard case .dead = host.state, let sessionFile = host.sessionFile else { return nil }
        return SessionConsoleText.relaunchNote(sessionFile: ConsoleFormat.path(sessionFile))
    }

    /// L'état de la session en un mot (S-15), lu par les détails techniques.
    var stateTitle: String {
        SessionConsoleText.stateTitle(host.state, hasProject: projectRoot != nil)
    }

    /// Le statut, quand il dit AUTRE chose que l'état ; `nil` quand il ne ferait
    /// que le répéter.
    var statusNotice: String? {
        statusMessage == Self.statusText(for: host.state) ? nil : statusMessage
    }

    /// Un dialogue en attente capte le raccourci d'arrêt.
    var hasPendingDialog: Bool { !host.dialogQueue.isEmpty }

    /// Action du raccourci ⌘. — dialogue en attente ⇒ annulation, sinon arrêt.
    func performStopShortcut() {
        if hasPendingDialog {
            cancelDialog()
        } else {
            stop()
        }
    }

    // MARK: - Actions (S-9)

    /// L'UNIQUE écrivain du projet choisi de l'app (S-3 de
    /// mac-etats-vides-sans-issue) : la section publiée et la préférence partagée
    /// avec Mémoire, Fichiers et Terminal. Le panneau de Session OMP, la route
    /// distante et le sélecteur des états vides passent tous par ici, donc un
    /// choix a le même effet d'où qu'il vienne.
    func select(projectRoot url: URL) {
        projectRoot = url
        defaults.set(url.path, forKey: Self.projectRootKey)
    }

    /// `true` quand un dossier a été choisi ; un panneau annulé n'écrit rien.
    @discardableResult
    func chooseProject() -> Bool {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "Choisir"
        panel.message = "Choisissez le dossier du projet à héberger."
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        select(projectRoot: url)
        return true
    }

    func launch() {
        guard canLaunch, let projectRoot else { return }
        Task { @MainActor in
            do {
                try await host.start(projectRoot: projectRoot, resumeFile: nil)
            } catch {
                present(error)
            }
        }
    }

    /// Le lancement piloté par la route distante (S-1) : la racine vient de la
    /// liste des dépôts connus de la coque, et elle devient la préférence
    /// mémorisée — même effet que le geste « Choisir un dossier… ». C'est une
    /// session NEUVE : aucun fichier à reprendre.
    func launch(projectRoot url: URL) async throws {
        guard canStart else { throw ServiceSessionError.alreadyRunning }
        select(projectRoot: url)
        try await host.start(projectRoot: url, resumeFile: nil)
    }

    /// La relance MANUELLE de la route distante (S-1) : la règle `canRelaunch` du
    /// Mac, qui REPREND le même fichier de session — `host.relaunch()` décide.
    func relaunchSession() async throws {
        guard canRelaunch else { throw ServiceSessionError.notRunning }
        try await host.relaunch()
    }

    func relaunch() {
        guard canRelaunch else { return }
        Task { @MainActor in
            do {
                try await host.relaunch()
            } catch {
                present(error)
            }
        }
    }

    func stop() {
        Task { @MainActor in
            await host.stop()
        }
    }

    /// L'arrêt qui ATTEND la fin de la séquence (S-7) : la route distante rend
    /// l'état APRÈS l'arrêt, pas un `running` transitoire. Le bouton macOS, lui,
    /// garde `stop()` (il suit l'état publié).
    func stopSession() async {
        await host.stop()
    }

    func sendPrompt() {
        guard canSendPrompt else { return }
        let text = prompt
        Task { @MainActor in
            do {
                try await host.send(prompt: text)
                prompt = ""
            } catch {
                present(error)
            }
        }
    }

    func answerSelectedOption() {
        guard
            let dialog = host.dialogQueue.first,
            dialog.method == .select,
            let index = selectedOptionIndex,
            dialog.options.indices.contains(index)
        else { return }
        answer(.value(id: dialog.id, value: dialog.options[index]))
    }

    func answerDialogText() {
        guard let dialog = host.dialogQueue.first, dialog.method == .input || dialog.method == .editor else { return }
        answer(.value(id: dialog.id, value: dialogText))
    }

    func confirmDialog(_ confirmed: Bool) {
        guard let dialog = host.dialogQueue.first, dialog.method == .confirm else { return }
        answer(.confirmed(id: dialog.id, confirmed: confirmed))
    }

    func cancelDialog() {
        guard let dialog = host.dialogQueue.first else { return }
        answer(.cancelled(id: dialog.id))
    }

    /// Un dialogue qui apparaît remet les contrôles à son état initial : `editor`
    /// part de son `prefill` (S-6), rien d'autre n'hérite du dialogue précédent.
    func dialogAppeared(_ dialog: RpcDialogRequest) {
        dialogText = dialog.method == .editor ? (dialog.prefill ?? "") : ""
        selectedOptionIndex = nil
    }

    func applicationWillTerminate() async {
        await host.terminateForQuit()
    }

    // MARK: - Modèle et niveau de réflexion (model-selector-in-embedded-omp-session S-6)

    /// Démarre le sélecteur : charge le catalogue UNE fois et lit le défaut du projet.
    /// Idempotent ; appelé à la création du modèle de l'app (les tests l'appellent
    /// avec leurs doublures).
    func startModelSelector() {
        guard !modelSelectorStarted else { return }
        modelSelectorStarted = true
        Task { @MainActor in await loadModelCatalog() }
        // Au lancement le service peut ne pas encore répondre : quelques essais
        // espacés, jusqu'à ce que le défaut du projet soit lu.
        Task { @MainActor in
            for _ in 0..<5 {
                await refreshProjectDefault()
                if projectRoot == nil || projectDefaultRoot == projectRoot { return }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// Charge `omp models --json` : sélecteurs authentifiés, noms et efforts.
    func loadModelCatalog() async {
        modelCatalog = .loading
        switch await loadModelListing() {
        case .success(let listing):
            modelNames = listing.names
            modelThinking = listing.thinking
            modelCatalog = .loaded(listing.selectors)
        case .failure(let error):
            modelCatalog = .failed(error.reason)
        }
    }

    func retryModelCatalog() {
        Task { @MainActor in await loadModelCatalog() }
    }

    /// Relit le défaut du projet choisi. Un échec garde la valeur déjà lue POUR LE
    /// MÊME projet ; pour un autre projet, le défaut retombe sur « aucun ».
    func refreshProjectDefault() async {
        guard let root = projectRoot else {
            projectDefault = ServiceModelChoice(model: nil, thinkingLevel: nil)
            projectDefaultRoot = nil
            return
        }
        do {
            let choice = try await host.projectModel(root: root)
            guard projectRoot == root else { return }
            projectDefault = choice
            projectDefaultRoot = root
        } catch {
            guard projectRoot == root, projectDefaultRoot != root else { return }
            projectDefault = ServiceModelChoice(model: nil, thinkingLevel: nil)
        }
    }

    /// La valeur affichée : le modèle et le niveau de la session vivante, sinon le
    /// défaut du projet.
    var displayedModel: ServiceModelChoice {
        host.state == .running
            ? ServiceModelChoice(model: host.model, thinkingLevel: host.thinkingLevel)
            : projectDefault
    }

    /// Le libellé de la valeur affichée : nom lisible (repli : le sélecteur) et
    /// niveau ; « défaut OMP » sans modèle.
    var modelLabel: String {
        let shown = displayedModel
        let name = shown.model.map { ModelCatalog.displayName($0, names: modelNames) }
            ?? SessionConsoleText.Model.defaultModel
        return SessionConsoleText.Model.label(name: name, level: shown.thinkingLevel)
    }

    /// Pourquoi le sélecteur est indisponible ; `nil` quand il est utilisable. La
    /// route distante et le bouton du Mac partagent CETTE règle.
    var modelRefusal: GestureRefusal? {
        guard projectRoot != nil else { return .noProject }
        switch host.state {
        case .launching, .stopping: return .sessionNotRunning
        case .running where host.turnRunning: return .turnRunning
        default: break
        }
        if isApplyingModel { return .modelRefused(SessionConsoleText.Model.applyingHelp) }
        return nil
    }

    var canChangeModel: Bool { modelRefusal == nil }

    /// L'aide du bouton : la raison quand il est désactivé, sinon le libellé complet.
    var modelHelp: String {
        switch modelRefusal {
        case .noProject: return SessionConsoleText.Model.noProject
        case .turnRunning: return SessionConsoleText.Model.busyHelp
        case .modelRefused: return SessionConsoleText.Model.applyingHelp
        default: return modelLabel
        }
    }

    /// Les sélecteurs du catalogue qui passent le filtre (insensible à la casse,
    /// sur le nom lisible ET le sélecteur) ; aucun hors catalogue chargé.
    var visibleModels: [String] {
        guard case .loaded(let selectors) = modelCatalog else { return [] }
        let needle = modelFilter.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return selectors }
        return selectors.filter { selector in
            selector.range(of: needle, options: .caseInsensitive) != nil
                || ModelCatalog.displayName(selector, names: modelNames).range(of: needle, options: .caseInsensitive) != nil
        }
    }

    /// Le libellé de chaque modèle de la liste (nom lisible, complété si deux
    /// modèles se lisent pareil).
    var modelChoiceLabels: [String: String] {
        guard case .loaded(let selectors) = modelCatalog else { return [:] }
        return ModelCatalog.choiceLabels(selectors, names: modelNames)
    }

    /// Les niveaux proposés pour le modèle du brouillon : aucun sans modèle ou sans
    /// efforts (le réglage de réflexion est alors masqué).
    var draftLevels: [String] {
        guard let draftModel else { return [] }
        return ModelCatalog.thinkingChoices(for: draftModel, thinking: modelThinking)
    }

    var canApplyModel: Bool {
        guard draftModel != nil, case .loaded = modelCatalog else { return false }
        return canChangeModel
    }

    /// Ouvre le sélecteur : le brouillon part de la valeur affichée.
    func openModelPicker() {
        guard canChangeModel else { return }
        let shown = displayedModel
        modelFilter = ""
        modelError = nil
        draftModel = shown.model
        draftLevel = nil
        if let selector = shown.model {
            draftLevel = ModelCatalog.retainedLevel(
                shown.thinkingLevel,
                offered: ModelCatalog.thinkingChoices(for: selector, thinking: modelThinking)
            )
        }
        modelPickerShown = true
    }

    /// Ferme le sélecteur sans rien appliquer.
    func cancelModelPicker() {
        modelPickerShown = false
        modelError = nil
    }

    /// Choisit un modèle dans le brouillon : le niveau est conservé s'il est
    /// proposé, sinon le plus haut proposé qui ne le dépasse pas, sinon le premier.
    func selectDraftModel(_ selector: String?) {
        draftModel = selector
        guard let selector else {
            draftLevel = nil
            return
        }
        draftLevel = ModelCatalog.retainedLevel(
            draftLevel,
            offered: ModelCatalog.thinkingChoices(for: selector, thinking: modelThinking)
        )
    }

    /// « Appliquer » : le geste du bouton, sans attendre sa fin.
    func commitModelDraft() {
        Task { @MainActor in await applyModelDraft() }
    }

    /// Applique le brouillon. Succès ⇒ sélecteur fermé ; refus ⇒ sélecteur ouvert,
    /// raison du service mot pour mot, valeur affichée RELUE (jamais le brouillon).
    func applyModelDraft() async {
        guard canApplyModel, let selector = draftModel else { return }
        let level = draftLevels.isEmpty ? nil : draftLevel
        modelError = nil
        do {
            try await applyModel(selector, thinkingLevel: level)
            modelPickerShown = false
        } catch {
            modelError = ServiceSessionModel.userMessage(of: error)
            await refreshDisplayedModel()
        }
    }

    /// L'application d'un choix, partagée par le bouton et la route distante :
    /// session vivante ⇒ `POST /v1/sessions/{id}/model` (sans relancer) ; sinon
    /// `POST /v1/projects/{racine}/model` (B-5). Les refus du service remontent.
    func applyModel(_ model: String, thinkingLevel: String?) async throws {
        guard !isApplyingModel else { return }
        isApplyingModel = true
        defer { isApplyingModel = false }
        if host.state == .running {
            try await host.setModel(model, thinkingLevel: thinkingLevel)
            return
        }
        guard let root = projectRoot else { throw ServiceSessionError.notRunning }
        let choice = try await host.setProjectModel(root: root, model: model, thinkingLevel: thinkingLevel)
        projectDefault = choice
        projectDefaultRoot = root
    }

    /// Relit la valeur RÉELLE après un refus : la session vivante, sinon le défaut.
    func refreshDisplayedModel() async {
        if host.state == .running {
            await host.refreshModel()
        } else {
            await refreshProjectDefault()
        }
    }

    // MARK: - Conversation (S-15)

    private func follow(sessionFile file: String?) {
        guard let file else {
            conversation?.stop()
            conversation = nil
            return
        }
        guard file != conversation?.target.sessionFile else { return }
        conversation?.stop()
        conversation = makeConversation(ViewerTarget(sessionFile: file, title: projectRoot?.lastPathComponent ?? ""))
    }

    // MARK: - Statut

    private func refreshStatus() {
        statusMessage = Self.statusText(for: host.state)
    }

    /// Le statut détaillé d'un état : ni pid ni identifiant, qui ont leurs
    /// propres lignes dans l'inspecteur.
    static func statusText(for state: ServiceSessionModel.State) -> String {
        switch state {
        case .idle:
            return SessionConsoleText.Status.idle
        case .launching:
            return SessionConsoleText.Status.launching
        case .running:
            return SessionConsoleText.Status.running
        case .stopping:
            return SessionConsoleText.Status.stopping
        case .stopped:
            return SessionConsoleText.Status.stopped
        case .dead:
            return SessionConsoleText.Status.dead
        case .failed(let message):
            return message
        }
    }

    /// Répond à un dialogue SI ET SEULEMENT SI c'est encore la TÊTE de la file
    /// (S-5) : le contrôle d'identité et l'écriture sont faits dans la MÊME
    /// exécution du `@MainActor`, donc la file ne peut pas glisser entre les deux.
    /// Miroir exact de `ProjectConsoleModel.answer(dialogId:response:)`.
    func answer(dialogId: String, response: RpcDialogResponse) -> Bool {
        guard host.dialogQueue.first?.id == dialogId else { return false }
        answer(response)
        return true
    }

    private func answer(_ response: RpcDialogResponse) {
        Task { @MainActor in
            do {
                try await host.answer(response)
                dialogText = ""
                selectedOptionIndex = nil
            } catch {
                present(error)
            }
        }
    }

    private func present(_ error: Error) {
        statusMessage = ServiceSessionModel.userMessage(of: error)
    }
}
