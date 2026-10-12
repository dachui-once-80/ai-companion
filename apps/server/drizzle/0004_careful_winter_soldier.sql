CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_at` text,
	`reminder_at` text,
	`reminder_sent` text DEFAULT 'false' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
