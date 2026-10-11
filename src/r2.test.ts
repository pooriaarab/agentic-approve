import { describe, expect, test } from "vitest";
import { VendorError } from "agentic-core";
import { R2BlobStore, sha256Hex, signAwsV4 } from "./r2.js";
import { ApproveError } from "./store.js";

describe("sha256Hex", () => {
  test("hashes the empty string to the known digest", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("signAwsV4", () => {
  const input = {
    method: "PUT" as const,
    url: new URL("https://acct.r2.cloudflarestorage.com/bucket/bodies/a1.txt"),
    payloadHash: sha256Hex("hello"),
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    amzDate: "20260102T030405Z",
  };

  test("is deterministic and binds method, payload, and time", () => {
    const first = signAwsV4(input);
    expect(signAwsV4(input).authorization).toBe(first.authorization);
    // This exact signature matches botocore S3SigV4Auth for the same
    // method, URL, payload, key, and timestamp, checked by hand.
    expect(first.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKID/20260102/auto/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=78afe8e920f9714f9f867436a163afa24fd96ebecc8dc74a3c3d891b7af747c8",
    );
    expect(first.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20260102\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(signAwsV4({ ...input, method: "GET" }).authorization).not.toBe(first.authorization);
    expect(signAwsV4({ ...input, payloadHash: sha256Hex("other") }).authorization).not.toBe(
      first.authorization,
    );
    expect(signAwsV4({ ...input, amzDate: "20260103T030405Z" }).authorization).not.toBe(
      first.authorization,
    );
  });
});

describe("R2BlobStore", () => {
  const config = { accountId: "acct", bucket: "bucket", accessKeyId: "AKID", secretAccessKey: "S" };

  test("put and get round-trip over signed calls", async () => {
    const seen: { url: string; auth: string; date: string }[] = [];
    const blobs = new Map<string, string>();
    const store = new R2BlobStore({
      ...config,
      fetchFn: (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        const href = String(url);
        seen.push({
          url: href,
          auth: init?.headers?.authorization ?? "",
          date: init?.headers?.["x-amz-date"] ?? "",
        });
        const key = new URL(href).pathname.replace("/bucket/", "");
        if (init?.body !== undefined) {
          blobs.set(key, init.body);
          return new Response("", { status: 200 });
        }
        const text = blobs.get(key);
        if (text === undefined) return new Response("missing", { status: 404 });
        return new Response(text, { status: 200 });
      }) as typeof fetch,
    });
    await store.put("bodies/a1.txt", "hello");
    expect(await store.get("bodies/a1.txt")).toBe("hello");
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe("https://acct.r2.cloudflarestorage.com/bucket/bodies/a1.txt");
    for (const call of seen) {
      expect(call.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//);
      expect(call.date).toMatch(/^\d{8}T\d{6}Z$/);
    }
    await expect(store.get("bodies/missing.txt")).rejects.toThrow(ApproveError);
  });

  test("throws VendorError on non-2xx and on network failure", async () => {
    const failing = new R2BlobStore({
      ...config,
      fetchFn: (async () => new Response("down", { status: 503 })) as typeof fetch,
    });
    const error = await failing.put("k", "v").then(
      () => null,
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).status).toBe(503);
    await expect(failing.get("k")).rejects.toThrow(VendorError);

    const down = new R2BlobStore({
      ...config,
      fetchFn: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.put("k", "v")).rejects.toThrow(VendorError);
  });

  test("rejects blank config and bad keys", () => {
    expect(() => new R2BlobStore({ ...config, bucket: " " })).toThrow(/bucket/);
    const store = new R2BlobStore(config);
    return expect(store.get("../escape")).rejects.toThrow(/bad blob key/);
  });
});
