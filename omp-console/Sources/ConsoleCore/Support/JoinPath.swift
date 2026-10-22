// `path.join` de Node : le séparateur n'est jamais doublé, jamais absent.

public func joinPath(_ base: String, _ name: String) -> String {
    if base.isEmpty { return name }
    return base.hasSuffix("/") ? base + name : base + "/" + name
}
