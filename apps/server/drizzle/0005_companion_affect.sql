CREATE TABLE `companion_affect` (
	`id` text PRIMARY KEY NOT NULL,
	`valence` real NOT NULL,
	`arousal` real NOT NULL,
	`warmth` real NOT NULL,
	`curiosity` real NOT NULL,
	`cause` text DEFAULT '' NOT NULL,
	`expression` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
