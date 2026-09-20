CREATE TABLE `jev_pipeline_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`phase` text NOT NULL,
	`snapshot_created_at` text NOT NULL,
	`snapshot_capture_id` text NOT NULL,
	`cursor` text,
	`step_token` text,
	`step_started_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jev_pipeline_phase_created` ON `jev_pipeline_runs` (`phase`,`created_at`);