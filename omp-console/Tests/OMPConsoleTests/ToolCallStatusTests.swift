// Preuves de S-7 de mac-finitions-hig : un appel d'outil sans résultat se lit
// « Interrompu » dans une session finie, « en cours » dans une session vivante.
// La décision est la fonction partagée `ToolCallStatus.of` ; la fin de session
// des fils Session OMP et Projet est `ServiceSessionModel.State.isOver`.

import ConsoleCore
import Testing
@testable import OMPConsole

private let okResult = ToolResultRow(callId: "c1", name: "read", text: "ok", diff: nil, isError: false)
private let errorResult = ToolResultRow(callId: "c1", name: "read", text: "boom", diff: nil, isError: true)

@Test("mac-finitions-hig/AC-8 : un appel sans résultat d'une session finie est « Interrompu », jamais « en cours »")
func toolCallWithoutResultInEndedSessionIsInterrupted() {
    #expect(ToolCallStatus.of(nil, sessionEnded: true) == .interrupted)
    #expect(ConversationText.toolInterrupted == "Interrompu")
    #expect(ConversationText.toolInterruptedSymbol == "stop.circle")
    // Un résultat arrivé garde son état, session finie ou non.
    #expect(ToolCallStatus.of(okResult, sessionEnded: true) == .done)
    #expect(ToolCallStatus.of(errorResult, sessionEnded: true) == .failed)

    // La fin d'une session hébergée (Session OMP, Projet) : les 7 états.
    let table: [(ServiceSessionModel.State, Bool)] = [
        (.idle, false),
        (.launching, false),
        (.running, false),
        (.stopping, false),
        (.stopped, true),
        (.dead, true),
        (.failed(message: "x"), true),
    ]
    for (state, over) in table {
        #expect(state.isOver == over, "\(state)")
    }
}

@Test("mac-finitions-hig/AC-9 : un appel en attente d'une session vivante garde son indicateur « en cours »")
func toolCallWithoutResultInLiveSessionIsRunning() {
    #expect(ToolCallStatus.of(nil, sessionEnded: false) == .running)
    #expect(ToolCallStatus.of(nil, sessionEnded: ServiceSessionModel.State.running.isOver) == .running)
    #expect(ToolCallStatus.of(nil, sessionEnded: ServiceSessionModel.State.stopping.isOver) == .running)
    #expect(ToolCallStatus.of(okResult, sessionEnded: false) == .done)
    #expect(ToolCallStatus.of(errorResult, sessionEnded: false) == .failed)
}
