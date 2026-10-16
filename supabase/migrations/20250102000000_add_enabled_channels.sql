-- Add enabled_channels array column to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS enabled_channels text[] NOT NULL DEFAULT ARRAY['twitter', 'reddit', 'google'];
