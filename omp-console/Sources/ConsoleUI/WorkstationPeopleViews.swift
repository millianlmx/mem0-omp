// La page Personnes du Poste, écrite une fois pour le Mac et l'iPhone/iPad : les collègues
// du graphe que tient le serveur (nom, adresses, rôle, niveau de délégation), et pour
// chacune une page qui corrige chaque champ.
//
// Corriger un champ le fige contre la lecture des canaux ; « Relâcher » le rend aux
// suggestions. La correction part avec la révision lue : si la personne a changé depuis,
// le serveur refuse (412), la liste est relue et l'humain recommence sur la valeur fraîche.
// Le refus d'un jeton non approbateur revient au geste, sans bandeau global. Le modèle est
// `server.people` (`WorkstationPeopleModel`) ; les mots viennent de `PeopleText`.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct WorkstationPeopleSections: View {
    @ObservedObject var people: WorkstationPeopleModel

    public init(people: WorkstationPeopleModel) {
        self.people = people
    }

    public var body: some View {
        Group {
            if let failure = people.failure {
                ConsoleFailureBanner(failure: failure)
            }
            Section {
                if people.people.isEmpty {
                    Text(PeopleText.empty).foregroundStyle(.secondary)
                }
                ForEach(people.people) { person in
                    NavigationLink {
                        WorkstationPersonPage(people: people, id: person.id)
                    } label: {
                        WorkstationPersonRow(person: person)
                    }
                    .consoleID("workstation.person." + person.id)
                }
            } footer: {
                Text(PeopleText.hint)
            }
        }
    }
}

/// Une personne dans la liste : son nom (ou sa première adresse), son rôle et son niveau.
struct WorkstationPersonRow: View {
    let person: WorkstationPerson

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(person.name ?? person.emails.first ?? person.slackIds.first ?? PeopleText.unnamed)
            Text(details)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var details: String {
        let parts = [person.role, person.team, PeopleText.delegation(person.delegation)].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.joined(separator: " · ")
    }
}

/// La page d'une personne : un champ par section, sa valeur à corriger, et s'il est corrigé.
struct WorkstationPersonPage: View {
    @ObservedObject var people: WorkstationPeopleModel
    let id: String
    @State private var drafts: [WorkstationPerson.Field: String] = [:]
    @State private var failure: HarnessFailure?

    var body: some View {
        Form {
            if let person = people.person(id) {
                content(person)
            }
        }
        .formStyle(.grouped)
        .navigationTitle(people.person(id).flatMap(\.name) ?? PeopleText.title)
        .consoleInlineTitle()
    }

    @ViewBuilder
    private func content(_ person: WorkstationPerson) -> some View {
        if let failure {
            Section {
                Text(failure == .approverOnly ? PeopleText.approverOnly : failure.message)
                    .foregroundStyle(.red)
            }
        }
        ForEach(WorkstationPerson.Field.allCases, id: \.self) { field in
            Section {
                editor(field, person)
                if person.isCorrected(field) {
                    HStack {
                        Label(PeopleText.corrected, systemImage: PeopleText.correctedSymbol)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        Button(PeopleText.release) {
                            Task { await send(person, [field: .release]) }
                        }
                        .disabled(people.busy.contains(person.id))
                        .consoleID("workstation.person.release." + field.rawValue)
                    }
                }
            } header: {
                Text(PeopleText.field(field.rawValue))
            } footer: {
                if field.isList { Text(PeopleText.listHint) }
            }
        }
        Section {
            Button(PeopleText.save) {
                Task { await send(person, changes(person)) }
            }
            .disabled(changes(person).isEmpty || people.busy.contains(person.id))
            .consoleID("workstation.person.save")
        } footer: {
            Text(PeopleText.releaseHint)
        }
    }

    @ViewBuilder
    private func editor(_ field: WorkstationPerson.Field, _ person: WorkstationPerson) -> some View {
        let binding = Binding(
            get: { drafts[field] ?? person.text(field) },
            set: { drafts[field] = $0 }
        )
        if field == .delegation {
            Picker(PeopleText.field(field.rawValue), selection: binding) {
                ForEach(WorkstationPerson.delegations, id: \.self) { level in
                    Text(PeopleText.delegation(level)).tag(level)
                }
            }
            .consoleID("workstation.person.field.delegation")
        } else {
            TextField(PeopleText.field(field.rawValue), text: binding, axis: field.isList ? .vertical : .horizontal)
                .consoleID("workstation.person.field." + field.rawValue)
        }
    }

    /// Les champs que l'humain a changés par rapport à la personne lue : eux seuls partent.
    private func changes(_ person: WorkstationPerson) -> [WorkstationPerson.Field: WorkstationPersonChange] {
        var out: [WorkstationPerson.Field: WorkstationPersonChange] = [:]
        for (field, text) in drafts where text != person.text(field) {
            out[field] = .set(text)
        }
        return out
    }

    private func send(_ person: WorkstationPerson, _ changes: [WorkstationPerson.Field: WorkstationPersonChange]) async {
        do {
            try await people.correct(person, changes)
            drafts = [:]
            failure = nil
        } catch {
            failure = error as? HarnessFailure
            // Relue après un 412 : les champs reprennent la valeur du serveur.
            if failure == .stale { drafts = [:] }
        }
    }
}
