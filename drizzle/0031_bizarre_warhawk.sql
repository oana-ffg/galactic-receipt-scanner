CREATE TABLE `capture_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `capture_notes_receipt_created` ON `capture_notes` (`receipt_id`,`created_at`);