ALTER TABLE `jev_jobs` ADD `eligibility_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `jev_jobs` ADD `ineligible_reason` text;