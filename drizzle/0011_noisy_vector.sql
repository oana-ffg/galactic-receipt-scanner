CREATE TABLE `capture_outlines` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `capture_outlines_capture_created` ON `capture_outlines` (`capture_id`,`created_at`,`id`);