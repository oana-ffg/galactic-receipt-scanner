CREATE TABLE `processing_attempts` (
	`token` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`stage` text NOT NULL,
	`model` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `processing_commits` (
	`token` text PRIMARY KEY NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT "processing_commit_valid" CHECK("processing_commits"."valid" = 1)
);
--> statement-breakpoint
CREATE TABLE `processing_lock` (
	`id` integer PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`stage` text NOT NULL,
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`expires` integer NOT NULL,
	`draft` text
);
--> statement-breakpoint
CREATE TABLE `purchase_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`normalized_name` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_categories_normalized_name_unique` ON `purchase_categories` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `rejected_associations` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`document_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL
);
