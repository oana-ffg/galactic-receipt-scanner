CREATE TABLE `processing_batch_documents` (
	`document_id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `processing_batch_lease` ADD `client_sha256` text;--> statement-breakpoint
CREATE INDEX `processing_batch_client_expires` ON `processing_batch_lease` (`client_sha256`,`expires`);--> statement-breakpoint
CREATE INDEX `processing_batch_expires` ON `processing_batch_lease` (`expires`);--> statement-breakpoint
ALTER TABLE `processing_lock` ADD `client_sha256` text;--> statement-breakpoint
ALTER TABLE `processing_lock` ADD `batch_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `processing_lock_document_id_unique` ON `processing_lock` (`document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `processing_lock_token_unique` ON `processing_lock` (`token`);--> statement-breakpoint
CREATE INDEX `processing_lock_client_expires` ON `processing_lock` (`client_sha256`,`expires`);--> statement-breakpoint
CREATE INDEX `processing_lock_expires` ON `processing_lock` (`expires`);