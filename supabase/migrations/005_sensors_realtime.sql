-- Migration 005 — enable Supabase Realtime on the sensors table.
-- This lets the Origin Monitor app subscribe via WebSocket and react
-- instantly when a sensor's name (or any other field) changes — e.g.
-- when the user renames it from the web portal or Primus.

alter publication supabase_realtime add table public.sensors;
