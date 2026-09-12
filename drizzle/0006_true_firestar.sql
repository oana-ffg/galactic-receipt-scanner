CREATE TABLE `document_files` (
	`key` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`sha256` text NOT NULL,
	`filename` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_heads` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_names` (
	`filename` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_pages` (
	`capture_id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `document_versions` (
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_version` ON `document_versions` (`document_id`,`revision`);