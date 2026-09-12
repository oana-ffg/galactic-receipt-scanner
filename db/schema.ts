import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
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
