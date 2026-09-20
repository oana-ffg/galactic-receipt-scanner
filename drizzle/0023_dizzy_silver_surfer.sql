CREATE TABLE `processing_batch_lease` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`owner` text NOT NULL,
	`expires` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processing_batch_lease_batch_id_unique` ON `processing_batch_lease` (`batch_id`);