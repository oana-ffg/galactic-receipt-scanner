CREATE TABLE `purchase_category_revisions` (
	`category_id` text NOT NULL,
	`revision` integer NOT NULL,
	`previous` text NOT NULL,
	`updated` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_category_revision` ON `purchase_category_revisions` (`category_id`,`revision`);