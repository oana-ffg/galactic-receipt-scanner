ALTER TABLE `captures` ADD `receipt_id` text;--> statement-breakpoint
ALTER TABLE `captures` ADD `retake_of` text REFERENCES captures(id);--> statement-breakpoint
ALTER TABLE `captures` ADD `take_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `captures_receipt_take` ON `captures` (`receipt_id`,`take_number`);