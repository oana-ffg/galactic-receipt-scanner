CREATE TABLE `source_review_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`assessment_id` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`assessment_id`) REFERENCES `jev_assessments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `source_review_assessment_created` ON `source_review_decisions` (`assessment_id`,`created_at`);