import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { GuardError, VendorError } from "agentic-core";
import { AccessGate } from "./access.js";

const TEAM = "team.cloudflareaccess.com";
const AUD = "policy-aud";

function toUrl(part: string | object): string {
  const text = typeof part === "string" ? part : JSON.stringify(part);
  return Buffer.from(text, "utf8").toString("base64url");
}

function setup() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1" };
  const fetchFn = (async (url: unknown) => {
    expect(String(url)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  }) as typeof fetch;
  const sign = (payload: object, kid = "key-1"): string => {
    const header = toUrl({ alg: "RS256", kid, typ: "JWT" });
    const body = toUrl(payload);
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${body}`);
    return `${header}.${body}.${signer.sign(privateKey, "base64url")}`;
  };
  return { fetchFn, sign };
}

function payload(overrides: object = {}): Record<string, object | string | number> {
  return {
    iss: `https://${TEAM}`,
    aud: AUD,
    exp: Math.floor(Date.now() / 1000) + 300,
    email: "ruth@example.com",
    ...overrides,
  };
}

describe("AccessGate", () => {
  test("accepts a token with good claims and a good signature", async () => {
    const { fetchFn, sign } = setup();
    const gate = new AccessGate({ teamDomain: TEAM, audience: AUD, fetchFn });
    await expect(gate.check("ruth", sign(payload()))).resolves.toBeUndefined();
  });

  test("denies missing, malformed, and expired tokens", async () => {
    const { fetchFn, sign } = setup();
    const gate = new AccessGate({ teamDomain: TEAM, audience: AUD, fetchFn });
    await expect(gate.check("ruth")).rejects.toThrow(/needs an Access token/);
    await expect(gate.check("  ", sign(payload()))).rejects.toThrow(/actor name/);
    await expect(gate.check("ruth", "not-a-jwt")).rejects.toThrow(/not a JWT/);
    await expect(
      gate.check("ruth", sign(payload({ iss: "https://evil.example.com" }))),
    ).rejects.toThrow(/bad issuer/);
    await expect(gate.check("ruth", sign(payload({ aud: "other" })))).rejects.toThrow(/bad audience/);
    await expect(
      gate.check("ruth", sign(payload({ exp: Math.floor(Date.now() / 1000) - 10 }))),
    ).rejects.toThrow(/expired/);
  });

  test("denies a token signed by an unknown key", async () => {
    const { fetchFn } = setup();
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = toUrl({ alg: "RS256", kid: "key-1", typ: "JWT" });
    const body = toUrl(payload());
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${body}`);
    const forged = `${header}.${body}.${signer.sign(other.privateKey, "base64url")}`;
    const gate = new AccessGate({ teamDomain: TEAM, audience: AUD, fetchFn });
    await expect(gate.check("ruth", forged)).rejects.toThrow(GuardError);
  });

  test("throws VendorError when the certs endpoint is down", async () => {
    const { sign } = setup();
    const token = sign(payload());
    const down = new AccessGate({
      teamDomain: TEAM,
      audience: AUD,
      fetchFn: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.check("ruth", token)).rejects.toThrow(VendorError);
    const badStatus = new AccessGate({
      teamDomain: TEAM,
      audience: AUD,
      fetchFn: (async () => new Response("down", { status: 500 })) as typeof fetch,
    });
    await expect(badStatus.check("ruth", token)).rejects.toThrow(VendorError);
  });
});
