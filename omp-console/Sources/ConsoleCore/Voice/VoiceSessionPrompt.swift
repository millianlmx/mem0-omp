import Foundation

/// Le déroulé partagé d'une dictée vers la session OMP hébergée, commun à
/// l'intent de l'iPhone et à celui du Mac : un seul envoi, aucun second tour.
@MainActor
public enum VoiceSessionPrompt {
    /// `ready` rend le motif qui empêche tout envoi (`nil` si l'appareil peut
    /// envoyer) ; `ask` demande le message quand l'intent n'en a pas reçu ;
    /// `deliver` envoie le message trimé et rend son issue. Rend la phrase à dire.
    public static func run(
        message: String?,
        ready: @MainActor () async -> VoiceIssue?,
        ask: @MainActor (String) async throws -> String,
        deliver: @MainActor (String) async throws -> VoiceIssue
    ) async throws -> String {
        if let issue = await ready() { return issue.phrase }
        var text = trim(message ?? "")
        if text.isEmpty {
            let answer: String
            do {
                answer = try await ask(VoiceSpeechText.dictationPrompt)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                answer = ""
            }
            text = trim(answer)
        }
        guard !text.isEmpty else { return VoiceSpeechText.dictationEmpty }
        return try await deliver(text).phrase
    }

    private static func trim(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
