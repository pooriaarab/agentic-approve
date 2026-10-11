// Access gate: only reviewers behind Cloudflare Access can decide.
//
// Docs: https://developers.cloudflare.com/cloudflare-one/ — an app
// behind Access receives a JWT (or a service token exchange) that this
// gate verifies: issuer, audience, expiry, and RS256 signature against
// the team certs at <team>.cloudflareaccess.com/cdn-cgi/access/certs.
// Denial throws GuardError. An unreachable certs endpoint throws
// VendorError, so an outage never reads as a quiet denial.

import { createPublicKey, createVerify } from "node:crypto";
import { GuardError, VendorError } from "agentic-core";
import { ApproveError } from "./store.js";
import type { ReviewerGate } from "./store.js";

export interface AccessConfig {
  teamDomain: string;
  audience: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

interface CertsPayload {
  keys?: Jwk[];
}

interface JwtPayload {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  email?: unknown;
}

function decodePart(part: string): Record<string, unknown> {
  let json: string;
  try {
    json = Buffer.from(part, "base64url").toString("utf8");
  } catch {
    throw new GuardError("access denied: the token is not valid base64url");
  }
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new GuardError("access denied: the token holds bad JSON");
  }
}

export class AccessGate implements ReviewerGate {
  readonly name = "access";
  private readonly teamDomain: string;
  private readonly audience: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private certsCache: { at: number; keys: Jwk[] } | null = null;

  constructor(config: AccessConfig) {
    if (config.teamDomain.trim().length === 0) throw new Error("Access gate needs a team domain");
    if (config.audience.trim().length === 0) throw new Error("Access gate needs an audience");
    this.teamDomain = config.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.audience = config.audience;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchFn = config.fetchFn ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  private certsUrl(): string {
    return `https://${this.teamDomain}/cdn-cgi/access/certs`;
  }

  private async loadKeys(): Promise<Jwk[]> {
    const fresh = this.certsCache !== null && Date.now() - this.certsCache.at < 5 * 60 * 1000;
    if (fresh && this.certsCache !== null) return this.certsCache.keys;
    let response: Response;
    try {
      response = await this.fetchFn(this.certsUrl(), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new VendorError(`Access certs request failed: ${String(error)}`, { cause: error });
    }
    if (!response.ok) {
      throw new VendorError(`Access certs got status ${response.status}`, { status: response.status });
    }
    const payload = (await response.json()) as CertsPayload;
    if (!Array.isArray(payload.keys) || payload.keys.length === 0) {
      throw new VendorError("Access certs returned no keys");
    }
    this.certsCache = { at: Date.now(), keys: payload.keys };
    return payload.keys;
  }

  private checkClaims(payload: JwtPayload): void {
    const issuer = `https://${this.teamDomain}`;
    if (payload.iss !== issuer) {
      throw new GuardError(`access denied: bad issuer "${String(payload.iss)}"`);
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(this.audience)) {
      throw new GuardError("access denied: bad audience");
    }
    if (typeof payload.exp !== "number") {
      throw new GuardError("access denied: the token carries no expiry");
    }
    if (payload.exp * 1000 <= this.now().getTime()) {
      throw new GuardError("access denied: the token is expired");
    }
  }

  async check(actor: string, token?: string): Promise<void> {
    if (actor.trim().length === 0) {
      throw new ApproveError("a decision needs an actor name");
    }
    if (token === undefined || token.trim().length === 0) {
      throw new GuardError("access denied: a decision needs an Access token");
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new GuardError("access denied: the token is not a JWT");
    }
    const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];
    const header = decodePart(encodedHeader);
    const payload = decodePart(encodedPayload) as JwtPayload;
    this.checkClaims(payload);
    if (typeof header.kid !== "string" || typeof header.alg !== "string") {
      throw new GuardError("access denied: the token header lacks kid or alg");
    }
    if (header.alg !== "RS256") {
      throw new GuardError(`access denied: bad alg "${header.alg}"`);
    }
    const keys = await this.loadKeys();
    const jwk = keys.find((key) => key.kid === header.kid);
    if (jwk?.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
      throw new GuardError("access denied: no matching key for this token");
    }
    let keyObject: ReturnType<typeof createPublicKey>;
    try {
      keyObject = createPublicKey({ key: jwk as { kty: string; n: string; e: string }, format: "jwk" });
    } catch {
      throw new GuardError("access denied: the signing key is bad");
    }
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    let valid: boolean;
    try {
      valid = verifier.verify(keyObject, Buffer.from(signature, "base64url"));
    } catch {
      throw new GuardError("access denied: the signature is bad");
    }
    if (!valid) {
      throw new GuardError("access denied: the signature is bad");
    }
  }
}
