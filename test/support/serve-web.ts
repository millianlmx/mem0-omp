// Un serveur `node:http` RÉEL sur 127.0.0.1 qui livre à une fonction web standard
// (`Request` → `Response`) l'adresse du pair lue sur la socket — ce que `server.requestIP`
// fait sous Bun. Sert les tests du protocole distant du VPS sous `node --test`.
import assert from "node:assert/strict";
import * as http from "node:http";

export function serveWeb(
  handler: (req: Request, source: string | null) => Promise<Response>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i] ?? "", incoming.rawHeaders[i + 1] ?? "");
    const method = incoming.method ?? "GET";
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const response = await handler(request, incoming.socket.remoteAddress ?? null);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  const { promise, resolve } = Promise.withResolvers<{ url: string; close: () => Promise<void> }>();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    resolve({
      url: `http://127.0.0.1:${address.port}`,
      close: () => {
        const done = Promise.withResolvers<void>();
        server.closeAllConnections();
        server.close(() => done.resolve());
        return done.promise;
      },
    });
  });
  return promise;
}
