CREATE TABLE `agent_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`token_sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer,
	`request_hash` text NOT NULL,
	`envelope` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_connections_token_sha256_unique` ON `agent_connections` (`token_sha256`);