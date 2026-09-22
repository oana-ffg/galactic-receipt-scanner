CREATE TABLE `jev_continuity_edges` (
	`capture_id` text PRIMARY KEY NOT NULL,
	`scan_created_at` text NOT NULL,
	`source_sha256` text NOT NULL,
	`ocr_sha256` text NOT NULL,
	`previous_capture_id` text,
	`previous_source_sha256` text,
	`previous_ocr_sha256` text,
	`relationship` text,
	`assessment_id` text,
	`processed_at` text NOT NULL,
	FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jev_continuity_scan_order` ON `jev_continuity_edges` (`scan_created_at`,`capture_id`);--> statement-breakpoint
CREATE INDEX `jev_continuity_previous_capture` ON `jev_continuity_edges` (`previous_capture_id`);--> statement-breakpoint
DROP INDEX `jev_job_status_created`;--> statement-breakpoint
CREATE INDEX `jev_job_status_created` ON `jev_jobs` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `artifacts_kind_created_key` ON `artifacts` (`kind`,`created_at`,`key`);