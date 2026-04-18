CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT UNIQUE NOT NULL,      -- E.164 format: +6591234567
  timezone TEXT NOT NULL DEFAULT 'Asia/Singapore',
  verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  recurrence JSONB NOT NULL,
  -- e.g. {"type":"monthly_date","day":1}
  -- {"type":"weekly","weekday":"thursday"}
  -- {"type":"specific","date":"2026-03-15"}
  next_fire DATE NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  fire_date DATE NOT NULL,
  status TEXT DEFAULT 'pending',  -- pending | snoozed | done
  snooze_until TIMESTAMPTZ,
  wamid TEXT,                     -- WhatsApp message ID for dedup
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(task_id, fire_date)
);