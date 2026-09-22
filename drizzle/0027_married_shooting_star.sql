CREATE TABLE `jev_payment_candidate_runs` (
	`pipeline_run_id` text PRIMARY KEY NOT NULL,
	`document_count` integer NOT NULL,
	`purchase_count` integer NOT NULL,
	`payment_count` integer NOT NULL,
	`next_payment_index` integer DEFAULT 0 NOT NULL,
	`built_at` text
);
--> statement-breakpoint
CREATE TABLE `jev_payment_candidates` (
	`pipeline_run_id` text NOT NULL,
	`rank` integer NOT NULL,
	`pass` text NOT NULL,
	`payment_document_id` text NOT NULL,
	`purchase_document_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jev_payment_candidate_rank` ON `jev_payment_candidates` (`pipeline_run_id`,`rank`);--> statement-breakpoint
CREATE TABLE `jev_payment_index_chunks` (
	`pipeline_run_id` text NOT NULL,
	`kind` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jev_payment_index_chunk` ON `jev_payment_index_chunks` (`pipeline_run_id`,`kind`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `document_files_document_created` ON `document_files` (`document_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `document_pages_document_id_page_index` ON `document_pages` (`document_id`,`page_index`);--> statement-breakpoint
CREATE INDEX `jev_payment_index_pending` ON `jev_page_heads` (`updated_at`,`capture_id`) WHERE "jev_page_heads"."date_candidates" IS NULL OR "jev_page_heads"."payment_match_index" IS NULL;