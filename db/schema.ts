import { sql } from "drizzle-orm";
import {
  sqliteTable,
  check,
  text,
  integer,
  index,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
export const agentConnections = sqliteTable("agent_connections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  scope: text("scope").notNull(),
  token_sha256: text("token_sha256").notNull().unique(),
  created_at: integer("created_at").notNull(),
  expires_at: integer("expires_at").notNull(),
  revoked_at: integer("revoked_at"),
  last_used_at: integer("last_used_at"),
  request_hash: text("request_hash").notNull(),
  envelope: text("envelope").notNull(),
});
export const captures = sqliteTable(
  "captures",
  {
    id: text("id").primaryKey(),
    receipt_id: text("receipt_id"),
    retake_of: text("retake_of").references((): AnySQLiteColumn => captures.id),
    take_number: integer("take_number").notNull().default(1),
    created_at: text("created_at").notNull(),
    sha256: text("sha256").notNull(),
    raw_key: text("raw_key").notNull(),
    content_type: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    status: text("status").notNull(),
    metadata: text("metadata").notNull(),
  },
  (table) => [
    index("captures_created_id").on(table.created_at, table.id),
    uniqueIndex("captures_receipt_take").on(
      table.receipt_id,
      table.take_number,
    ),
  ],
);
export const artifacts = sqliteTable(
  "artifacts",
  {
    key: text("key").primaryKey(),
    capture_id: text("capture_id")
      .notNull()
      .references(() => captures.id),
    kind: text("kind").notNull(),
    sha256: text("sha256").notNull(),
    created_at: text("created_at").notNull(),
    content_type: text("content_type").notNull(),
  },
  (table) => [
    index("artifacts_capture_kind_created").on(
      table.capture_id,
      table.kind,
      table.created_at,
    ),
  ],
);
export const station = sqliteTable("station", {
  id: integer("id").primaryKey(),
  camera: text("camera"),
  expires: integer("expires").notNull().default(0),
  command: text("command").notNull().default("pause"),
  sequence: integer("sequence").notNull().default(0),
  state: text("state"),
  preview_key: text("preview_key"),
  preview_session: text("preview_session"),
  preview_requested_until: integer("preview_requested_until")
    .notNull()
    .default(0),
  updated: integer("updated").notNull().default(0),
});

export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    status: text("status").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    context: text("context").notNull(),
    screenshot_key: text("screenshot_key").notNull(),
    sha256: text("sha256").notNull(),
    fingerprint: text("fingerprint").notNull(),
  },
  (table) => [index("issues_created_id").on(table.created_at, table.id)],
);
export const issueUpdates = sqliteTable(
  "issue_updates",
  {
    id: text("id").primaryKey(),
    issue_id: text("issue_id")
      .notNull()
      .references(() => issues.id),
    status: text("status").notNull(),
    note: text("note").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("issue_updates_issue_created").on(table.issue_id, table.created_at),
  ],
);

// Processing records are independent of immutable captures and their artifact history.
export const documentVersions = sqliteTable(
  "document_versions",
  {
    document_id: text("document_id").notNull(),
    revision: integer("revision").notNull(),
    payload: text("payload").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("document_version").on(table.document_id, table.revision),
  ],
);
export const documentHeads = sqliteTable("document_heads", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
});
export const documentPages = sqliteTable("document_pages", {
  page_index: integer("page_index"),
  type: text("type"),
  capture_id: text("capture_id")
    .primaryKey()
    .references(() => captures.id),
  document_id: text("document_id").notNull(),
});
export const documentFiles = sqliteTable("document_files", {
  key: text("key").primaryKey(),
  document_id: text("document_id").notNull(),
  revision: integer("revision").notNull(),
  sha256: text("sha256").notNull(),
  filename: text("filename").notNull(),
  created_at: text("created_at").notNull(),
});
export const documentNames = sqliteTable("document_names", {
  filename: text("filename").primaryKey(),
  document_id: text("document_id").notNull(),
});

export const purchaseCategories = sqliteTable("purchase_categories", {
  id: text("id").primaryKey(),
  normalized_name: text("normalized_name").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  created_at: text("created_at").notNull(),
});
export const processingLock = sqliteTable("processing_lock", {
  id: integer("id").primaryKey(),
  token: text("token").notNull(),
  stage: text("stage").notNull(),
  document_id: text("document_id").notNull(),
  revision: integer("revision").notNull(),
  expires: integer("expires").notNull(),
  draft: text("draft"),
});
export const processingAttempts = sqliteTable("processing_attempts", {
  token: text("token").primaryKey(),
  document_id: text("document_id").notNull(),
  revision: integer("revision").notNull(),
  stage: text("stage").notNull(),
  model: text("model").notNull(),
  payload: text("payload").notNull(),
  created_at: text("created_at").notNull(),
});
export const rejectedAssociations = sqliteTable("rejected_associations", {
  id: text("id").primaryKey(),
  capture_id: text("capture_id").notNull(),
  document_id: text("document_id").notNull(),
  reason: text("reason").notNull(),
  created_at: text("created_at").notNull(),
});
export const processingCommits = sqliteTable(
  "processing_commits",
  {
    token: text("token").primaryKey(),
    valid: integer("valid").notNull(),
  },
  (table) => [check("processing_commit_valid", sql`${table.valid} = 1`)],
);
export const processingDrafts = sqliteTable("processing_drafts", {
  token: text("token").primaryKey(),
  document_id: text("document_id").notNull(),
  revision: integer("revision").notNull(),
  model: text("model").notNull(),
  payload: text("payload").notNull(),
  created_at: text("created_at").notNull(),
});
