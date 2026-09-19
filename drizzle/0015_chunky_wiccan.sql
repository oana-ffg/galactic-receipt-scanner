CREATE TABLE `capture_keeps` (
	`capture_id` text PRIMARY KEY NOT NULL,
	`source_sha256` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE no action
);
