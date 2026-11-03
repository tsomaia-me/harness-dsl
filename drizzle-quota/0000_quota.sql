CREATE TABLE `quota_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`account` text NOT NULL,
	`harness` text NOT NULL,
	`at_ms` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quota_events_account` ON `quota_events` (`account`);--> statement-breakpoint
CREATE INDEX `quota_events_at` ON `quota_events` (`at_ms`);--> statement-breakpoint
CREATE TABLE `quota_members` (
	`harness` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`expires_at_ms` integer NOT NULL
);
