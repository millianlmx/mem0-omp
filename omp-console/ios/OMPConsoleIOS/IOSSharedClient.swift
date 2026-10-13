import AppIntents
import ConsoleClient

/// La racine de composition du client distant : l'instance UNIQUE de l'app,
/// enregistrée pour les App Intents (S-1 de client-ios-possede-par-la-vue).
///
/// `OMPConsoleIOSApp.init()` — qui tourne à chaque lancement du processus, y
/// compris un lancement à froid par Siri — crée le client par
/// `ConsoleClientModel.live()`, l'enregistre ici, puis passe aux vues l'instance
/// même que les intents résolvent par `AppDependency`. Aucun second client, aucun
/// second trousseau.
enum IOSSharedClient {
    /// Enregistre `client` comme dépendance de `manager` (un seul enregistrement,
    /// clé par défaut = le type) et le rend TEL QUEL, pour que l'app passe aux
    /// vues l'instance même que les intents résolvent. L'autoclosure capture
    /// l'instance : chaque résolution rend le même objet, jamais une copie.
    @MainActor
    static func install(_ client: ConsoleClientModel, in manager: AppDependencyManager) -> ConsoleClientModel {
        manager.add(dependency: client)
        return client
    }
}
