CREATE INDEX `artifacts_capture_kind_created` ON `artifacts` (`capture_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `captures_created_id` ON `captures` (`created_at`,`id`);