ALTER TABLE `memories` ADD `key` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `status` text DEFAULT 'current' NOT NULL;