CREATE TABLE `consolidation_receipts` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`payload_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`occurred_on` text NOT NULL,
	`created_at` text NOT NULL
);
