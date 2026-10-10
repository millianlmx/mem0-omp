// Un échec présenté en deux faces (S-1 de jargon-technique-expose-mac-et-ios) :
// - `message` : la phrase AFFICHÉE — une conséquence, puis un geste ; ni pid, ni
//   chemin, ni commande, ni code HTTP ;
// - `diagnostic` : le détail BRUT, que seul « Copier le diagnostic » emporte.
//
// Invariant : `diagnostic` n'est jamais vide — un bouton de copie désactivé faute
// de détail laisserait l'utilisateur sans rien à joindre. Un appelant qui n'a pas
// de brut à fournir retombe sur la phrase elle-même.

import Foundation

struct ReadableFailure: Equatable, Sendable {
    let message: String
    let diagnostic: String

    init(message: String, diagnostic: String) {
        self.message = message
        self.diagnostic = diagnostic.isEmpty ? message : diagnostic
    }
}
