import { describe, expect, test } from "vitest";
import { resolveBackends } from "./env.js";

describe("resolveBackends", () => {
  test("defaults to file stores and an open gate", () => {
    const backends = resolveBackends({ APPROVE_DATA_DIR: "/tmp/approve-test-data" });
    expect(backends.store.name).toBe("file");
    expect(backends.blobs.name).toBe("file");
    expect(backends.gate.name).toBe("open");
  });

  test("full vendor groups pick the vendor adapters", () => {
    const backends = resolveBackends({
      APPROVE_D1_ACCOUNT_ID: "a",
      APPROVE_D1_DATABASE_ID: "b",
      APPROVE_D1_API_TOKEN: "c",
      APPROVE_R2_ACCOUNT_ID: "a",
      APPROVE_R2_BUCKET: "bucket",
      APPROVE_R2_ACCESS_KEY_ID: "k",
      APPROVE_R2_SECRET_ACCESS_KEY: "s",
      APPROVE_ACCESS_TEAM: "team.cloudflareaccess.com",
      APPROVE_ACCESS_AUD: "aud",
    });
    expect(backends.store.name).toBe("d1");
    expect(backends.blobs.name).toBe("r2");
    expect(backends.gate.name).toBe("access");
  });

  test("a half-set group throws instead of guessing", () => {
    expect(() =>
      resolveBackends({ APPROVE_D1_ACCOUNT_ID: "a", APPROVE_D1_DATABASE_ID: "b" }),
    ).toThrow(/APPROVE_D1_API_TOKEN/);
    expect(() => resolveBackends({ APPROVE_R2_BUCKET: "bucket" })).toThrow(/APPROVE_R2_ACCOUNT_ID/);
    expect(() => resolveBackends({ APPROVE_ACCESS_TEAM: "t" })).toThrow(/APPROVE_ACCESS_AUD/);
  });
});
