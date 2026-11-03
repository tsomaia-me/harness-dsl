CREATE TABLE `leases` (
	`resource` text NOT NULL,
	`attempt_id` text NOT NULL,
	`mode` text NOT NULL,
	PRIMARY KEY(`resource`, `attempt_id`)
);
--> statement-breakpoint
CREATE TABLE `ledger_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`unit_id` text,
	`attempt_id` text,
	`at_ms` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ledger_events_unit` ON `ledger_events` (`unit_id`);--> statement-breakpoint
CREATE INDEX `ledger_events_attempt` ON `ledger_events` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `ledger_events_type` ON `ledger_events` (`type`);--> statement-breakpoint
CREATE TABLE `loops` (
	`unit_id` text NOT NULL,
	`loop` text NOT NULL,
	`attempt_id` text NOT NULL,
	`iteration` integer NOT NULL,
	`span` text NOT NULL,
	`carry` text,
	PRIMARY KEY(`unit_id`, `loop`)
);
--> statement-breakpoint
CREATE TABLE `step_outputs` (
	`attempt_id` text NOT NULL,
	`address` text NOT NULL,
	`unit_id` text NOT NULL,
	`output` text NOT NULL,
	PRIMARY KEY(`attempt_id`, `address`)
);
--> statement-breakpoint
CREATE TABLE `timers` (
	`timer_id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`owner` text NOT NULL,
	`fire_at_ms` integer NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `units` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`lane` text NOT NULL,
	`parent_id` text,
	`state` text NOT NULL,
	`state_position` text NOT NULL,
	`position` text NOT NULL,
	`verdict` text,
	`attributes` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`attempt_id` text,
	`attempt_number` integer,
	`attempt_status` text,
	`attempt_step` text,
	`blocked_on` text,
	`halt` text,
	`attempt_started_at_ms` integer,
	`cursor_step` text,
	`cursor_iteration` integer,
	`flow_version` text,
	`not_before_ms` integer
);
--> statement-breakpoint
CREATE TABLE `writer` (
	`id` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`expires_at_ms` integer NOT NULL
);
