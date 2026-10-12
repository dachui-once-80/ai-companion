CREATE TABLE `companion_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`previous_names` text DEFAULT '[]' NOT NULL,
	`personality` text NOT NULL,
	`updated_at` text NOT NULL
);
