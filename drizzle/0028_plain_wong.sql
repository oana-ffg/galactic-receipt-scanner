CREATE TABLE `processing_batch_lease_events` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`outcome` text NOT NULL,
	`expires` integer,
	`ray_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `processing_batch_lease_events_batch_created` ON `processing_batch_lease_events` (`batch_id`,`created_at`);