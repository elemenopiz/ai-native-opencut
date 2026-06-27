-- Store the frame orientation on each generation set so promoting a winning
-- take to 1080p reproduces the exact same shape (portrait/landscape/square),
-- not just the same seed. Run after 0002_board_image_items.sql

ALTER TABLE "generation_sets" ADD COLUMN IF NOT EXISTS "orientation" text NOT NULL DEFAULT 'landscape';
