CREATE TABLE `processing_drafts` (
	`token` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`model` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
