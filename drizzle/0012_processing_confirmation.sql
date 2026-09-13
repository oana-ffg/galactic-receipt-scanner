CREATE TABLE `processing_confirmations` (
	`token` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`request` text NOT NULL,
	`payload` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL
);
