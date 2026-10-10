// Preuves du texte de l'alerte « Quitter arrêtera… » (mac-quitter-sans-confirmation,
// S-3) : ce qui déclenche l'alerte, l'ordre fixe des lignes et l'effet vrai de
// la sortie (s'arrête / continue dans OMP).

import Foundation
import Testing
@testable import OMPConsole

@Test("mac-quitter-sans-confirmation/AC-7 : une session seule ne cite ni pilotage, ni Terminal, ni pipeline")
func quitPromptSessionAlone() throws {
    let prompt = try #require(QuitPrompt.make([.session(name: "mem0-omp")]))
    #expect(prompt.title == "Quitter arrêtera des activités en cours.")
    #expect(prompt.message == "La session OMP de « mem0-omp » s'arrêtera.")
    for word in ["pilotage", "Terminal", "pipeline"] {
        #expect(!prompt.message.contains(word))
    }
}

@Test("mac-quitter-sans-confirmation/AC-6 : session, commande du Terminal et pilotage sont cités, nommés, dans l'ordre fixe")
func quitPromptThreeActivities() throws {
    let prompt = try #require(QuitPrompt.make([
        .pilotage(name: "mon-projet"),
        .terminalCommand(name: "sleep"),
        .session(name: "mem0-omp"),
    ]))
    let lines = prompt.message.components(separatedBy: "\n")
    #expect(lines == [
        "La session OMP de « mem0-omp » s'arrêtera.",
        "La commande « sleep » du Terminal s'arrêtera.",
        "Le pilotage de « mon-projet » continue dans OMP : vous le retrouverez en pilotant de nouveau ce projet.",
    ])
    #expect(lines[2].contains("continue dans OMP"))
    #expect(lines[2].contains("en pilotant de nouveau ce projet"))
}

@Test("mac-quitter-sans-confirmation/AC-5 : une session et des pipelines en cours tiennent dans UNE alerte qui cite les deux")
func quitPromptSessionAndPipelines() throws {
    let prompt = try #require(QuitPrompt.make([.pipelines(count: 2), .session(name: "x")]))
    #expect(prompt.message.components(separatedBy: "\n") == [
        "La session OMP de « x » s'arrêtera.",
        "2 pipelines en cours continuent dans OMP.",
    ])
}

@Test("mac-quitter-sans-confirmation/AC-1 : une commande du Terminal seule déclenche l'alerte")
func quitPromptTerminalAlone() throws {
    let prompt = try #require(QuitPrompt.make([.terminalCommand(name: "sleep")]))
    #expect(prompt.message == "La commande « sleep » du Terminal s'arrêtera.")
}

@Test("mac-quitter-sans-confirmation/AC-8 : rien qui s'arrête, aucune alerte — même avec un pilotage et des pipelines")
func quitPromptNothingStops() {
    #expect(QuitPrompt.make([]) == nil)
    #expect(QuitPrompt.make([.pilotage(name: "p"), .pipelines(count: 3)]) == nil)
    #expect(QuitPrompt.make([.pilotage(name: nil)]) == nil)
}

@Test("mac-quitter-sans-confirmation/AC-6 : sans nom lisible, chaque ligne prend sa variante générique")
func quitPromptUnnamedVariants() throws {
    let prompt = try #require(QuitPrompt.make([
        .session(named: "  "),
        .terminalCommand(named: ""),
        .pilotage(named: nil),
    ]))
    #expect(prompt.message.components(separatedBy: "\n") == [
        "La session OMP s'arrêtera.",
        "La commande en cours dans le Terminal s'arrêtera.",
        "Le pilotage en cours continue dans OMP : vous le retrouverez en pilotant de nouveau ce projet.",
    ])
}

@Test("mac-quitter-sans-confirmation/AC-5 : « pipeline » s'accorde au nombre")
func quitPromptPipelinePlural() throws {
    let one = try #require(QuitPrompt.make([.session(name: nil), .pipelines(count: 1)]))
    let three = try #require(QuitPrompt.make([.session(name: nil), .pipelines(count: 3)]))
    #expect(one.message.hasSuffix("\n1 pipeline en cours continue dans OMP."))
    #expect(three.message.hasSuffix("\n3 pipelines en cours continuent dans OMP."))
}
