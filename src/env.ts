// Backend picker: env vars choose the store, the blobs, and the gate.
//
// Leave the vendor vars unset and the pack runs local: a JSON file,
// a bodies dir, and an open gate. Set a full group and that vendor
// takes over. A half-set group throws instead of guessing.

import { AccessGate } from "./access.js";
import { D1QueueStore } from "./d1.js";
import { FileBlobStore, FileQueueStore, resolveDataDir } from "./local.js";
import { R2BlobStore } from "./r2.js";
import { OpenGate, type BlobStore, type QueueStore, type ReviewerGate } from "./store.js";

export interface Backends {
  store: QueueStore;
  blobs: BlobStore;
  gate: ReviewerGate;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  return value;
}

function needAll(names: string[], values: (string | undefined)[], label: string): string[] | null {
  const set = values.filter((value): value is string => value !== undefined);
  if (set.length === 0) return null;
  if (set.length !== names.length) {
    const missing = names.filter((name, index) => values[index] === undefined);
    throw new Error(`${label} needs ${missing.join(", ")} too`);
  }
  return set;
}

export function resolveBackends(env: NodeJS.ProcessEnv = process.env): Backends {
  const d1Vars = ["APPROVE_D1_ACCOUNT_ID", "APPROVE_D1_DATABASE_ID", "APPROVE_D1_API_TOKEN"].map(
    (name) => read(env, name),
  );
  const r2Vars = [
    "APPROVE_R2_ACCOUNT_ID",
    "APPROVE_R2_BUCKET",
    "APPROVE_R2_ACCESS_KEY_ID",
    "APPROVE_R2_SECRET_ACCESS_KEY",
  ].map((name) => read(env, name));
  const accessVars = ["APPROVE_ACCESS_TEAM", "APPROVE_ACCESS_AUD"].map((name) => read(env, name));

  const d1 = needAll(
    ["APPROVE_D1_ACCOUNT_ID", "APPROVE_D1_DATABASE_ID", "APPROVE_D1_API_TOKEN"],
    d1Vars,
    "D1",
  );
  const r2 = needAll(
    [
      "APPROVE_R2_ACCOUNT_ID",
      "APPROVE_R2_BUCKET",
      "APPROVE_R2_ACCESS_KEY_ID",
      "APPROVE_R2_SECRET_ACCESS_KEY",
    ],
    r2Vars,
    "R2",
  );
  const access = needAll(["APPROVE_ACCESS_TEAM", "APPROVE_ACCESS_AUD"], accessVars, "Access gate");

  const dataDir = resolveDataDir(env);
  const store: QueueStore =
    d1 === null
      ? new FileQueueStore(dataDir)
      : new D1QueueStore({ accountId: d1[0] as string, databaseId: d1[1] as string, apiToken: d1[2] as string });
  const blobs: BlobStore =
    r2 === null
      ? new FileBlobStore(dataDir)
      : new R2BlobStore({
          accountId: r2[0] as string,
          bucket: r2[1] as string,
          accessKeyId: r2[2] as string,
          secretAccessKey: r2[3] as string,
        });
  const gate: ReviewerGate =
    access === null
      ? new OpenGate()
      : new AccessGate({ teamDomain: access[0] as string, audience: access[1] as string });
  return { store, blobs, gate };
}
