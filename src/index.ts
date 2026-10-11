export { VERSION } from "./version.js";
export {
  defineBrand,
  createLogger,
  GuardError,
  VendorError,
  createGuards,
  LocalRouterAdapter,
  HttpRouterAdapter,
  recordCost,
  getCostReport,
  resetCosts,
  createDryRunResult,
  dispatchText,
  summarizeText,
} from "agentic-core";
export type {
  BrandConfig,
  LogLevel,
  Logger,
  LoggerOptions,
  CapsConfig,
  QuietHoursConfig,
  GuardsConfig,
  Guards,
  DispatchReceipt,
  RouterAdapter,
  HttpRouterOptions,
  CostEntry,
  CostReport,
  DispatchOptions,
  DispatchResult,
  TopWord,
  TextSummary,
  SummarizeOptions,
} from "agentic-core";

export {
  ApproveError,
  MemoryBlobStore,
  MemoryQueueStore,
  OpenGate,
  pendingOnly,
} from "./store.js";
export type {
  AuditAction,
  AuditEntry,
  BlobStore,
  Decision,
  ItemStatus,
  QueueItem,
  QueueStore,
  ReviewerGate,
  StoredItem,
} from "./store.js";
export { QueueService, MAX_BODY_CHARS, MAX_TITLE_CHARS } from "./service.js";
export type {
  DecisionOptions,
  EditPatch,
  ItemResult,
  MutateOptions,
  ServiceDeps,
  SubmitInput,
} from "./service.js";
export { FileBlobStore, FileQueueStore, resolveDataDir } from "./local.js";
export { D1QueueStore } from "./d1.js";
export type { D1Config } from "./d1.js";
export { R2BlobStore, sha256Hex, signAwsV4 } from "./r2.js";
export type { R2Config, SignInput, SignedRequest } from "./r2.js";
export { AccessGate } from "./access.js";
export type { AccessConfig } from "./access.js";
export { resolveBackends } from "./env.js";
export type { Backends } from "./env.js";

import { defineBrand, type BrandConfig } from "agentic-core";
import { VERSION } from "./version.js";

export const DEFAULT_BRAND: BrandConfig = defineBrand({
  name: "Agentic approve",
  command: "agentic-approve",
  description: "Review queue for agent output: edit, approve, reject, audit.",
  keywords: ["approval", "review-queue", "agentic-suite", "claude-code", "codex", "cli", "mcp"],
  version: VERSION,
});
