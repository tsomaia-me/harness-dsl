CREATE TABLE `account_quota_windows` (
	`account_id` text NOT NULL,
	`window_id` text NOT NULL,
	`utilization` real DEFAULT 0 NOT NULL,
	`resets_at_ms` integer,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`account_id`, `window_id`)
);
--> statement-breakpoint
CREATE TABLE `account_quotas` (
	`account_id` text PRIMARY KEY NOT NULL,
	`project_share_used` real DEFAULT 0 NOT NULL,
	`window_tokens_used` integer DEFAULT 0 NOT NULL,
	`cooldown_until_ms` integer,
	`unavailable_reason` text,
	`probed_at_ms` integer,
	`acquired_at_ms` integer
);
--> statement-breakpoint
CREATE TABLE `file_leases` (
	`pattern` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`acquired_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `head_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`transcript_path` text,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`handoff_note` text,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`iteration` integer NOT NULL,
	`step_name` text NOT NULL,
	`actor_name` text NOT NULL,
	`actor_kind` text NOT NULL,
	`account_id` text,
	`model_id` text,
	`runner_id` text,
	`session_id` text,
	`started_at_ms` integer NOT NULL,
	`finished_at_ms` integer,
	`duration_ms` integer,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`actual_cost_usd` real,
	`equivalent_cost_usd` real,
	`status` text NOT NULL,
	`output_json` text,
	`error_text` text
);
--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_name` text NOT NULL,
	`ticket_id` text,
	`status` text NOT NULL,
	`iteration` integer DEFAULT 0 NOT NULL,
	`current_step` text,
	`work_dir` text NOT NULL,
	`input_json` text NOT NULL,
	`state_json` text NOT NULL,
	`blocker_reason` text,
	`blocker_resolution_json` text,
	`started_at_ms` integer NOT NULL,
	`finished_at_ms` integer
);
