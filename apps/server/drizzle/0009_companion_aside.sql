CREATE TABLE `companion_asides` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`left_at` text NOT NULL,
	`matter_key` text NOT NULL,
	`matter_revision` text NOT NULL,
	`heard` text DEFAULT 'false' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `companion_aside_spoken` (
	`matter_key` text NOT NULL,
	`matter_revision` text NOT NULL,
	`spoken_at` text NOT NULL,
	PRIMARY KEY(`matter_key`, `matter_revision`)
);
--> statement-breakpoint
CREATE TABLE `companion_voice` (
	`id` text PRIMARY KEY NOT NULL,
	`left_at` text NOT NULL
);
