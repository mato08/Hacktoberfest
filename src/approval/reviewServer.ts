import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ApprovalError, type ApprovalRecord } from "./approvalStore.js";

const decisionSchema = z.strictObject({ decision: z.enum(["approve", "deny"]), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
const assets = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/style.css", { name: "style.css", type: "text/css; charset=utf-8" }],
]);

export async function startReviewServer(options: {
  port: number;
  list: () => ApprovalRecord[];
  decide: (id: string, fingerprint: string, decision: "approve" | "deny") => Promise<ApprovalRecord>;
}) {
  const token = randomBytes(32).toString("hex");
  const credential = Buffer.from(`Bearer ${token}`);
  let origin = "";
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };
  const body = async (req: IncomingMessage) => {
    if (req.headers["content-type"] !== "application/json") throw new ApprovalError("JSON content type required.", 415);
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw new ApprovalError("Review request is too large.", 413);
      chunks.push(chunk);
    }
    try { return decisionSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { throw new ApprovalError("Expected only decision and the stored fingerprint.", 400); }
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      // Loopback binding plus exact Host prevents DNS rebinding to a private API.
      if (req.headers.host !== new URL(origin).host) throw new ApprovalError("Invalid review host.", 403);
      const path = new URL(req.url ?? "/", origin).pathname;
      if (path.startsWith("/api/")) {
        const supplied = Buffer.from(req.headers.authorization ?? "");
        if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) throw new ApprovalError("Open the private review link printed by the gateway.", 401);
        if (req.headers.origin && req.headers.origin !== origin) throw new ApprovalError("Cross-origin access is not allowed.", 403);
        if (req.method === "GET" && path === "/api/state") return json(res, 200, { approvals: options.list() });
        const match = /^\/api\/approvals\/([a-f0-9-]{36})\/decision$/.exec(path);
        if (req.method === "POST" && match) {
          if (req.headers.origin !== origin) throw new ApprovalError("A same-origin review is required.", 403);
          const input = await body(req);
          return json(res, 200, await options.decide(match[1], input.fingerprint, input.decision));
        }
        return json(res, 404, { error: "Review endpoint not found." });
      }
      const asset = assets.get(path);
      if (req.method !== "GET" || !asset) return json(res, 404, { error: "Not found." });
      const content = await readFile(new URL(`../../review-ui/${asset.name}`, import.meta.url));
      res.writeHead(200, { "Content-Type": asset.type });
      res.end(content);
    } catch (error) {
      json(res, error instanceof ApprovalError ? error.statusCode : 500,
        { error: error instanceof ApprovalError ? error.message : "Review failed. Refresh the action status before trying anything else." });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing review address"));
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  return {
    origin,
    url: `${origin}/#token=${token}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}
