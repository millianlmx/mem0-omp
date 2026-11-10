// L'« OS agentique » : la liste des FILS, partagée par le Mac et l'iPhone/iPad. En tête,
// la seule entrée (⌘L) : ce qu'on y tape filtre les fils, et ⏎ le demande à l'OS (la
// Demande du serveur). Puis l'espace (un client) et, dedans, le lieu ; les entrées fixes
// — « Maintenant », les décisions à trier (⌘T), les propositions des agents, les
// automatismes, le savoir — et les fils, de ce qui vous attend à ce qui est fini ; les
// fils arrêtés restent repliés. Une session omp locale est un fil comme un autre. Le
// style de la liste (barre latérale sur le Mac) est posé par la coque.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSThreadList: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var pulse: OSPulse
    @ObservedObject var workspace: OSWorkspace
    @ObservedObject var spaces: HarnessSpacesModel
    @ObservedObject var proposals: HarnessProposalsModel
    let threads: [OSThread]
    /// Les lieux : les dépôts, puis le Poste (`OSWorkspace.postePlace`).
    let places: [String]
    /// Le nom de chaque navigateur du poste, par identifiant.
    let browsers: [String: String]
    let decisions: Int
    /// Les brouillons de la coque : sur l'iPhone et l'iPad, l'appui long sur un fil ouvre
    /// les gestes de sa feature (les mêmes que la liste des features).
    let drafts: HarnessDrafts?
    /// Les outils de l'entrée « Outils », au pied de la liste (Mac) ; aucun : pas d'entrée.
    let tools: [OSTool]

    @State private var draft = ""
    @State private var sending = false
    @State private var showsStopped = false

    /// `threads` : les fils de l'espace et du lieu retenus (`OSThreadScope.threads`).
    /// `places` : les lieux proposés (`OSThreadScope.places`). `browsers` : le nom de chaque
    /// navigateur du poste, par identifiant. `decisions` : le nombre de décisions qui attendent.
    /// `drafts` : les brouillons de la coque, pour le menu contextuel d'un fil (iPhone, iPad).
    /// `tools` : les écrans classiques de l'entrée « Outils » (Mac).
    public init(
        server: HarnessModel, intakes: HarnessIntakes, pulse: OSPulse, workspace: OSWorkspace,
        threads: [OSThread], places: [String], browsers: [String: String], decisions: Int, drafts: HarnessDrafts? = nil,
        tools: [OSTool] = []
    ) {
        self.server = server
        self.intakes = intakes
        self.pulse = pulse
        self.workspace = workspace
        _spaces = ObservedObject(wrappedValue: server.spaces)
        _proposals = ObservedObject(wrappedValue: server.proposals)
        self.threads = threads
        self.places = places
        self.browsers = browsers
        self.decisions = decisions
        self.drafts = drafts
        self.tools = tools
    }

    private var shown: [OSThread] {
        let words = draft.split(whereSeparator: \.isWhitespace).map { $0.lowercased() }
        guard !words.isEmpty else { return threads }
        return threads.filter { thread in
            let haystack = ([thread.title, thread.repo ?? "", thread.request?.instruction ?? ""] + thread.runs.map(\.title)).joined(separator: " ").lowercased()
            return words.allSatisfy { haystack.contains($0) }
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            OSAskComposer(intakes: intakes, draft: $draft, sending: $sending)
                .padding(.horizontal, 10)
                .padding(.top, 10)
            scope
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            // Sur le Mac, la liste porte la sélection du détail. Sur l'iPhone et l'iPad, un fil
            // touché s'ouvre (la coque le pousse dans sa pile), et les entrées fixes sont les
            // onglets de la coque.
            #if os(macOS)
            List(selection: $workspace.selection) { content }
            if !tools.isEmpty { OSToolsEntry(workspace: workspace, tools: tools) }
            #else
            List { content }
            #endif
        }
        .task(id: server.address) {
            await spaces.refresh()
            await proposals.refresh()
        }
        // Un espace supprimé ailleurs ne retient plus rien.
        .onChange(of: spaces.spaces.map(\.id)) { _, ids in
            if spaces.availability == .available, let chosen = workspace.spaceId, !ids.contains(chosen) {
                workspace.choose(space: nil)
            }
        }
    }

    /// « Demander : « … » » : la saisie de la liste, prête à partir.
    @ViewBuilder
    private var askRow: some View {
        if !draft.trimmingCharacters(in: .whitespaces).isEmpty {
            Button {
                OSAskComposer.send($draft, sending: $sending, intakes: intakes)
            } label: {
                Label(OSText.askThis(draft), systemImage: "return")
                    .lineLimit(2)
                    .foregroundStyle(Color.accentColor)
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var content: some View {
        #if os(iOS)
        if !draft.trimmingCharacters(in: .whitespaces).isEmpty {
            Section { askRow }
        }
        #else
        Section {
            Label(OSText.now, systemImage: "dot.radiowaves.left.and.right")
                .tag(OSWorkspace.now)
            Button {
                workspace.triage = true
            } label: {
                Label(OSWatchText.decisions, systemImage: "rectangle.stack.fill")
                    .foregroundStyle(decisions > 0 ? Color.orange : Color.primary)
            }
            .buttonStyle(.plain)
            .badge(decisions)
            .disabled(decisions == 0)
            .keyboardShortcut("t", modifiers: .command)
            if proposals.isServed {
                Label(OSWatchText.proposals, systemImage: "lightbulb")
                    .badge(proposals.proposals.count)
                    .tag(OSWorkspace.proposals)
            }
            Label(OSText.automations, systemImage: "gearshape.arrow.triangle.2.circlepath")
                .tag(OSWorkspace.automations)
            Label(OSWatchText.knowledge, systemImage: "books.vertical")
                .tag(OSWorkspace.knowledge)
            askRow
        }
        #endif
        let waiting = intakes.open.filter { $0.isClassifying }
        if !waiting.isEmpty {
            Section {
                ForEach(waiting) { intake in
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(intake.text).lineLimit(1).foregroundStyle(.secondary)
                    }
                }
            }
        }
        ForEach(OSThreads.sections(shown), id: \.0) { section, items in
            if section == .stopped {
                Section(isExpanded: $showsStopped) {
                    rows(items)
                } header: {
                    Text(section.title + " · \(items.count)")
                }
            } else {
                Section(section.title) {
                    rows(items)
                }
            }
        }
    }

    private func rows(_ items: [OSThread]) -> some View {
        ForEach(items) { thread in
            #if os(macOS)
            OSThreadRow(thread: thread, pulse: pulse, browsers: browsers)
                .tag(thread.id)
            #else
            Button {
                workspace.open(thread.id)
            } label: {
                HStack(spacing: 8) {
                    OSThreadRow(thread: thread, pulse: pulse, browsers: browsers)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, minHeight: ConsolePlatform.minimumTarget, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu { menu(thread) }
            #endif
        }
    }

    #if os(iOS)
    /// L'appui long sur un fil : « Comprendre », puis les gestes de sa feature.
    @ViewBuilder
    private func menu(_ thread: OSThread) -> some View {
        if let run = thread.focusRun {
            Button(OSText.understand, systemImage: "text.magnifyingglass") {
                workspace.open(thread.id)
                workspace.understand(runId: run.id, level: .summary)
            }
            if let drafts {
                RunMenuItems(server: server, drafts: drafts, run: run, includesOpen: false)
            }
        }
    }
    #endif

    /// L'espace, puis le lieu : côte à côte quand la colonne est assez large, sinon l'un sous l'autre.
    private var scope: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                spacePicker
                placePicker
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 4) {
                spacePicker
                placePicker
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// L'espace des fils montrés : tous, ou un espace — dont « i » ouvre la page. Rien sur
    /// un serveur sans espaces, ni tant qu'aucun n'existe.
    @ViewBuilder
    private var spacePicker: some View {
        if spaces.isServed, !spaces.spaces.isEmpty {
            HStack(spacing: 2) {
                Picker(OSWatchText.space, selection: chosenSpace) {
                    Label(OSWatchText.allSpaces, systemImage: "square.stack.3d.up").tag(String?.none)
                    Divider()
                    ForEach(spaces.spaces) { space in
                        Label(space.name, systemImage: "building.2").tag(String?.some(space.id))
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .osFixedSize()
                if let id = workspace.spaceId {
                    Button {
                        workspace.selection = OSWorkspace.space(id)
                    } label: {
                        Image(systemName: "info.circle")
                    }
                    .osBorderless()
                    .help(OSWatchText.openSpace)
                    .accessibilityLabel(OSWatchText.openSpace)
                }
            }
        }
    }

    private var chosenSpace: Binding<String?> {
        Binding(
            get: { workspace.spaceId },
            set: { id in workspace.choose(space: spaces.spaces.first { $0.id == id }) }
        )
    }

    /// Le lieu des fils montrés : partout, un dépôt, ou le Poste.
    private var placePicker: some View {
        Picker(OSText.places, selection: $workspace.place) {
            Label(OSText.everywhere, systemImage: "square.grid.2x2").tag(String?.none)
            Divider()
            ForEach(places, id: \.self) { place in
                if place == OSWorkspace.postePlace {
                    Label(OSText.poste, systemImage: "globe").tag(String?.some(place))
                } else {
                    Label(place, systemImage: "shippingbox").tag(String?.some(place))
                }
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .osFixedSize()
    }
}

/// Le composeur « Demander » : une ligne de saisie (⌘L y pose le curseur) ; ⏎ envoie la
/// saisie au serveur comme une Demande. La saisie appartient à l'écran qui le pose : la
/// liste des fils s'en sert aussi de filtre.
public struct OSAskComposer: View {
    @ObservedObject var intakes: HarnessIntakes
    @Binding var draft: String
    @Binding var sending: Bool
    let focusShortcut: Bool
    @FocusState private var composing: Bool

    /// `focusShortcut` : ce composeur prend ⌘L. Un seul par écran : la liste des fils le
    /// garde quand « Maintenant » pose le sien à côté.
    public init(intakes: HarnessIntakes, draft: Binding<String>, sending: Binding<Bool>, focusShortcut: Bool = true) {
        self.intakes = intakes
        _draft = draft
        _sending = sending
        self.focusShortcut = focusShortcut
    }

    public var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            TextField(OSText.ask, text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .focused($composing)
                .onSubmit { Self.send($draft, sending: $sending, intakes: intakes) }
                .disabled(sending)
            if sending { ProgressView().controlSize(.small) }
            // Sans touche ⏎ sous le doigt, la saisie part par son bouton.
            #if os(iOS)
            if !sending, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button {
                    Self.send($draft, sending: $sending, intakes: intakes)
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(OSTouchLinkStyle())
                .accessibilityLabel(OSText.send)
            }
            #endif
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: ConsolePlatform.minimumTarget)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(composing ? Color.accentColor.opacity(0.6) : .clear))
        .background {
            if focusShortcut {
                Button("") { composing = true }
                    .keyboardShortcut("l", modifiers: .command)
                    .hidden()
            }
        }
    }

    /// Envoie la saisie comme une Demande ; elle n'est vidée que si le serveur l'a prise.
    @MainActor
    public static func send(_ draft: Binding<String>, sending: Binding<Bool>, intakes: HarnessIntakes) {
        let text = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending.wrappedValue = true
        Task {
            if (try? await intakes.submit(text: text, source: intakeSource)) != nil { draft.wrappedValue = "" }
            sending.wrappedValue = false
        }
    }
}

/// Une ligne de fil : son état, son titre, et ce qui s'y passe maintenant. Le fil d'une
/// session omp locale porte un ordinateur portable, teinté par son état.
public struct OSThreadRow: View {
    let thread: OSThread
    @ObservedObject var pulse: OSPulse
    let browsers: [String: String]

    /// `browsers` : le nom de chaque navigateur du poste, par identifiant.
    public init(thread: OSThread, pulse: OSPulse, browsers: [String: String]) {
        self.thread = thread
        self.pulse = pulse
        self.browsers = browsers
    }

    /// Le titre tient sur une ligne dans la colonne du Mac, sur deux sur l'iPhone et l'iPad.
    #if os(macOS)
    private static let titleLines = 1
    #else
    private static let titleLines = 2
    #endif

    public var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if thread.isLocalSession {
                Image(systemName: "laptopcomputer")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(thread.phase.color)
                    .frame(width: 19, height: 19)
                    .accessibilityLabel(thread.phase.label)
            } else {
                OSPhaseMark(phase: thread.phase, size: 13)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(thread.title)
                    .lineLimit(Self.titleLines)
                    .foregroundStyle(thread.phase == .stopped ? .secondary : .primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(thread.phase == .yours ? Color.orange : .secondary)
                    .lineLimit(Self.titleLines)
            }
            Spacer(minLength: 0)
            if max(thread.runs.count, thread.requests.count) > 1 {
                Text("\(max(thread.runs.count, thread.requests.count))")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    /// Où, puis ce qui s'y passe : « mem0-omp · ↳ relance la suite », « Poste · Perso · livré »,
    /// « MacBook-Pro · feat/inscription · ↳ valide le courriel ».
    private var subtitle: String {
        if thread.isLocalSession, let session = thread.localSession {
            let now = session.isLive ? thread.osActivity(pulse).map { "↳ " + $0 } : thread.updatedAt.osRelative
            return [session.host, session.branch, now].compactMap { $0 }.joined(separator: " · ")
        }
        let place: String
        if let request = thread.request {
            place = OSText.poste + " · " + (request.browserId.flatMap { browsers[$0] } ?? request.browserId ?? OSText.defaultBrowser)
        } else {
            place = thread.repo ?? OSText.vps
        }
        if thread.phase == .working {
            if let activity = thread.osActivity(pulse) { return place + " · ↳ " + activity }
            if let run = thread.focusRun { return place + " · " + run.osState }
        }
        if thread.phase == .yours {
            if thread.audit?.isProposed == true { return place + " · " + OSText.kindProposals }
            if let run = thread.focusRun { return place + " · " + run.osState }
        }
        let date = thread.updatedAt.osRelative
        if let request = thread.request { return place + " · " + OSThreads.phase(of: request).label + " · " + date }
        return place + " · " + date
    }
}

extension OSThread {
    /// Le fil est celui d'une session omp locale qu'aucune feature n'a reprise.
    var isLocalSession: Bool { localSession != nil && runs.isEmpty }

    /// Ce que l'agent du fil fait à l'instant (son pouls) : l'intention de la session
    /// locale, de la feature qui tourne ou du poste ; `nil` quand personne n'y agit.
    @MainActor
    func osActivity(_ pulse: OSPulse, now: Date = Date()) -> String? {
        if isLocalSession, let session = localSession {
            return pulse.current(.localSession(session.id), now: now)?.line ?? session.intent
        }
        if let run = runs.last(where: { $0.phase == .running || $0.phase == .merging }) {
            return pulse.current(.run(run.id), now: now)?.line
        }
        if request?.state == .running { return pulse.workstation(now: now)?.activity.line }
        return nil
    }
}
