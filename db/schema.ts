import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
export const captures = sqliteTable(
  "captures",
  {
    id: text("id").primaryKey(),
    created_at: text("created_at").notNull(),
    sha256: text("sha256").notNull(),
    raw_key: text("raw_key").notNull(),
    content_type: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    status: text("status").notNull(),
    metadata: text("metadata").notNull(),
  },
  (table) => [index("captures_created_id").on(table.created_at, table.id)],
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
  updated: integer("updated").notNull().default(0),
});
