// L'« OS agentique » : la liste des FILS, partagée par le Mac et l'iPhone/iPad. En tête,
// la seule entrée (⌘L) : ce qu'on y tape filtre les fils, et ⏎ le demande à l'OS (la
// Demande du serveur). Puis le lieu, « Maintenant », les automatismes, le bac des
// décisions (« Trier », ⌘T) et les fils, de ce qui vous attend à ce qui est fini ; les
// fils arrêtés restent repliés. Le style de la liste (barre latérale sur le Mac) est
// posé par la coque.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSThreadList: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var pulse: OSPulse
    @ObservedObject var workspace: OSWorkspace
    let threads: [OSThread]
    /// Les lieux : les dépôts, puis le Poste (`OSWorkspace.postePlace`).
    let places: [String]
    /// Le nom de chaque navigateur du poste, par identifiant.
    let browsers: [String: String]
    let decisions: Int

    @State private var draft = ""
    @State private var sending = false
    @State private var showsStopped = false

    /// `threads` : les fils du lieu retenu. `places` : les dépôts, puis le Poste
    /// (`OSWorkspace.postePlace`). `browsers` : le nom de chaque navigateur du poste, par
    /// identifiant. `decisions` : le nombre de décisions qui attendent.
    public init(
        server: HarnessModel, intakes: HarnessIntakes, pulse: OSPulse, workspace: OSWorkspace,
        threads: [OSThread], places: [String], browsers: [String: String], decisions: Int
    ) {
        self.server = server
        self.intakes = intakes
        self.pulse = pulse
        self.workspace = workspace
        self.threads = threads
        self.places = places
        self.browsers = browsers
        self.decisions = decisions
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
            placePicker
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
            List(selection: $workspace.selection) {
                Section {
                    Label(OSText.now, systemImage: "dot.radiowaves.left.and.right")
                        .tag(OSWorkspace.now)
                    Label(OSText.automations, systemImage: "gearshape.arrow.triangle.2.circlepath")
                        .tag(OSWorkspace.automations)
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
                if decisions > 0 {
                    Section {
                        Button {
                            workspace.triage = true
                        } label: {
                            HStack {
                                Image(systemName: "rectangle.stack.fill")
                                Text(OSText.decisions(decisions)).fontWeight(.semibold)
                                Spacer()
                                Text(triageHint).font(.caption).foregroundStyle(.secondary)
                            }
                            .foregroundStyle(.orange)
                        }
                        .buttonStyle(.plain)
                        .keyboardShortcut("t", modifiers: .command)
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
        }
    }

    /// « Trier ⌘T » sur le Mac, où le raccourci se lit ; « Trier » ailleurs.
    private var triageHint: String {
        #if os(macOS)
        OSText.triage + " ⌘T"
        #else
        OSText.triage
        #endif
    }

    private func rows(_ items: [OSThread]) -> some View {
        ForEach(items) { thread in
            OSThreadRow(thread: thread, pulse: pulse, browsers: browsers)
                .tag(thread.id)
        }
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
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Le composeur « Demander » : une ligne de saisie (⌘L y pose le curseur) ; ⏎ envoie la
/// saisie au serveur comme une Demande. La saisie appartient à l'écran qui le pose : la
/// liste des fils s'en sert aussi de filtre.
public struct OSAskComposer: View {
    @ObservedObject var intakes: HarnessIntakes
    @Binding var draft: String
    @Binding var sending: Bool
    @FocusState private var composing: Bool

    public init(intakes: HarnessIntakes, draft: Binding<String>, sending: Binding<Bool>) {
        self.intakes = intakes
        _draft = draft
        _sending = sending
    }

    public var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .foregroundStyle(Color.accentColor)
            TextField(OSText.ask, text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .focused($composing)
                .onSubmit { Self.send($draft, sending: $sending, intakes: intakes) }
                .disabled(sending)
            if sending { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(composing ? Color.accentColor.opacity(0.6) : .clear))
        .background {
            Button("") { composing = true }
                .keyboardShortcut("l", modifiers: .command)
                .hidden()
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

/// Une ligne de fil : son état, son titre, et ce qui s'y passe maintenant.
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

    public var body: some View {
        HStack(alignment: .top, spacing: 8) {
            OSPhaseMark(phase: thread.phase, size: 13)
            VStack(alignment: .leading, spacing: 2) {
                Text(thread.title)
                    .lineLimit(1)
                    .foregroundStyle(thread.phase == .stopped ? .secondary : .primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(thread.phase == .yours ? Color.orange : .secondary)
                    .lineLimit(1)
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

    /// Où, puis ce qui s'y passe : « mem0-omp · ↳ relance la suite », « Poste · Perso · livré ».
    private var subtitle: String {
        let place: String
        if let request = thread.request {
            place = OSText.poste + " · " + (request.browserId.flatMap { browsers[$0] } ?? request.browserId ?? OSText.defaultBrowser)
        } else {
            place = thread.repo ?? OSText.vps
        }
        if thread.phase == .working {
            if let run = thread.runs.last(where: { $0.phase == .running || $0.phase == .merging }),
               let activity = pulse.current(.run(run.id)) {
                return place + " · ↳ " + activity.line
            }
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
