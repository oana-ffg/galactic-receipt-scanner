CREATE TABLE `artifacts` (
	`key` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`kind` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	`content_type` text NOT NULL,
	FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `captures` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`sha256` text NOT NULL,
	`raw_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`status` text NOT NULL,
	`metadata` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `station` (
	`id` integer PRIMARY KEY NOT NULL,
	`camera` text,
	`expires` integer DEFAULT 0 NOT NULL,
	`command` text DEFAULT 'pause' NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`state` text,
	`preview_key` text,
	`updated` integer DEFAULT 0 NOT NULL
);
