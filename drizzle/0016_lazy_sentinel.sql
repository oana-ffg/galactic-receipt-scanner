CREATE TABLE `jev_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_revision` integer,
	`candidate_id` text,
	`candidate_revision` integer,
	`model` text NOT NULL,
	`input_sha256` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jev_assessment_input` ON `jev_assessments` (`task`,`input_sha256`);--> statement-breakpoint
CREATE INDEX `jev_assessment_subject_created` ON `jev_assessments` (`subject_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `jev_document_heads` (
	`document_id` text PRIMARY KEY NOT NULL,
	`document_revision` integer NOT NULL,
	`page_fingerprint` text NOT NULL,
	`role` text NOT NULL,
	`role_probability` integer NOT NULL,
	`role_confidence` integer NOT NULL,
	`category_id` text,
	`category_probability` integer,
	`category_confidence` integer,
	`model` text NOT NULL,
	`assessment_id` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jev_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`ocr_sha256` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jev_job_ocr` ON `jev_jobs` (`capture_id`,`ocr_sha256`);--> statement-breakpoint
CREATE INDEX `jev_job_status_created` ON `jev_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `jev_page_heads` (
	`capture_id` text PRIMARY KEY NOT NULL,
	`source_sha256` text NOT NULL,
	`ocr_sha256` text NOT NULL,
	`role` text NOT NULL,
	`probability` integer NOT NULL,
	`confidence` integer NOT NULL,
	`model` text NOT NULL,
	`assessment_id` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE no action
);
