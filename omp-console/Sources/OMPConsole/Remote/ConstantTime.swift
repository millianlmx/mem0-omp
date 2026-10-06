// La comparaison à temps constant d'un secret (S-3) : le jeton d'appareil est un
// secret, et `==` sort au premier octet différent — un attaquant qui mesure le
// temps peut alors le reconstituer caractère par caractère.

import Foundation

enum ConstantTime {
    /// Vrai quand les deux chaînes ont exactement les mêmes octets UTF-8. Le
    /// parcours est TOUJOURS complet : ni sortie anticipée, ni comparaison de
    /// longueur avant le parcours.
    static func equal(_ left: String, _ right: String) -> Bool {
        let a = Array(left.utf8)
        let b = Array(right.utf8)
        var difference = UInt8(a.count == b.count ? 0 : 1)
        let count = max(a.count, b.count)
        for index in 0..<count {
            let x = index < a.count ? a[index] : 0
            let y = index < b.count ? b[index] : 0
            difference |= x ^ y
        }
        return difference == 0
    }
}
