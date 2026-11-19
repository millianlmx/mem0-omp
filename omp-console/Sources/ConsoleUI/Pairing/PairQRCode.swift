// Le QR code d'un lien d'appairage, dessiné avec CoreImage (ni AppKit, ni UIKit : l'image est un
// `CGImage`, que SwiftUI montre tel quel).

import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

public enum PairQRCode {
    /// Les modules de silence autour du code : la norme en demande quatre, dont un que le générateur de
    /// CoreImage dessine déjà.
    private static let quietModules: CGFloat = 4
    private static let generatedQuietModules: CGFloat = 1

    /// Le QR code de `text` : correction d'erreur M, chaque module agrandi SANS lissage (`moduleSize`
    /// pixels de côté, des bords nets), quatre modules de silence autour. Toujours des modules noirs sur
    /// fond blanc, quel que soit le mode clair ou sombre : un scanner lit un code sombre sur clair.
    /// `nil` si le texte ne tient pas dans un QR code.
    public static func image(for text: String, moduleSize: Int = 8) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scale = CGFloat(max(1, moduleSize))
        let modules = output.samplingNearest().transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let margin = (quietModules - generatedQuietModules) * scale
        let canvas = modules.extent.insetBy(dx: -margin, dy: -margin)
        let paper = CIImage(color: .white).cropped(to: canvas)
        return CIContext().createCGImage(modules.composited(over: paper), from: canvas)
    }
}
