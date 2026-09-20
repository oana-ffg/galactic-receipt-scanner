CREATE TABLE `processing_claim_requests` (
	`token` text PRIMARY KEY NOT NULL,
	`request_sha256` text NOT NULL,
	`stage` text NOT NULL,
	`document_id` text,
	`revision` integer,
	`outcome_reason` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `processing_lock` ADD `request_sha256` text;