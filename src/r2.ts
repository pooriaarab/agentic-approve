// R2 backend: queue bodies in Cloudflare R2 over the S3 API.
//
// Docs: https://developers.cloudflare.com/r2/api/s3/api/ — R2 speaks
// S3 at <account>.r2.cloudflarestorage.com with region "auto". This
// adapter signs each call with AWS Signature V4 and plain node:crypto,
// so it needs no AWS SDK. Failures throw VendorError.

import { createHash, createHmac } from "node:crypto";
import { VendorError } from "agentic-core";
import type { BlobStore } from "./store.js";
import { ApproveError } from "./store.js";

export function sha256Hex(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function hmac(key: Buffer | string, text: string): Buffer {
  return createHmac("sha256", key).update(text, "utf8").digest();
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => {
    const hex = char.charCodeAt(0).toString(16).toUpperCase();
    return `%${hex}`;
  });
}

export interface SignInput {
  method: "GET" | "PUT";
  url: URL;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  amzDate?: string;
}

export interface SignedRequest {
  authorization: string;
  amzDate: string;
  payloadHash: string;
}

export function signAwsV4(input: SignInput): SignedRequest {
  const region = input.region ?? "auto";
  const amzDate =
    input.amzDate ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = input.url.pathname
    .split("/")
    .map((segment) => encodeSegment(segment))
    .join("/");
  const params = [...input.url.searchParams.entries()]
    .map(([key, value]) => [encodeSegment(key), encodeSegment(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const canonicalQuery = params.map(([key, value]) => `${key}=${value}`).join("&");
  const canonicalHeaders =
    `host:${input.url.host}\n` +
    `x-amz-content-sha256:${input.payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    payloadHash: input.payloadHash,
  };
}

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class R2BlobStore implements BlobStore {
  readonly name = "r2";
  private readonly accountId: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: R2Config) {
    if (config.accountId.trim().length === 0) throw new Error("R2 needs an account id");
    if (config.bucket.trim().length === 0) throw new Error("R2 needs a bucket");
    if (config.accessKeyId.trim().length === 0) throw new Error("R2 needs an access key id");
    if (config.secretAccessKey.trim().length === 0) throw new Error("R2 needs a secret access key");
    this.accountId = config.accountId;
    this.bucket = config.bucket;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  private urlFor(key: string): URL {
    if (key.length === 0 || key.includes("..")) {
      throw new ApproveError(`bad blob key "${key}"`);
    }
    const clean = key.replace(/^\/+/, "");
    return new URL(
      `https://${this.accountId}.r2.cloudflarestorage.com/${this.bucket}/${clean}`,
    );
  }

  private async send(method: "GET" | "PUT", key: string, body?: string): Promise<Response> {
    const url = this.urlFor(key);
    const payloadHash = sha256Hex(body ?? "");
    const signed = signAwsV4({
      method,
      url,
      payloadHash,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
    });
    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        method,
        headers: {
          authorization: signed.authorization,
          "x-amz-content-sha256": signed.payloadHash,
          "x-amz-date": signed.amzDate,
          ...(method === "PUT" ? { "content-type": "text/plain; charset=utf-8" } : {}),
        },
        body: method === "PUT" ? (body ?? "") : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new VendorError(`R2 request failed: ${String(error)}`, { cause: error });
    }
    return response;
  }

  async put(key: string, text: string): Promise<void> {
    const response = await this.send("PUT", key, text);
    if (!response.ok) {
      throw new VendorError(`R2 put got status ${response.status} for key "${key}"`, {
        status: response.status,
      });
    }
  }

  async get(key: string): Promise<string> {
    const response = await this.send("GET", key);
    if (response.status === 404) {
      throw new ApproveError(`no blob at key "${key}"`);
    }
    if (!response.ok) {
      throw new VendorError(`R2 get got status ${response.status} for key "${key}"`, {
        status: response.status,
      });
    }
    return response.text();
  }
}
