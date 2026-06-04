// Copy to secrets.h and fill in. secrets.h is git-ignored.
#pragma once

#define WIFI_SSID      "your-wifi"
#define WIFI_PASS      "your-password"

// Supabase project URL host (no https://, no trailing slash)
#define SUPABASE_HOST  "tlgtyskedenqffikfuzx.supabase.co"
// anon key (client-public; gated by RLS)
#define SUPABASE_ANON  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...."

#define DEVICE_ID      "dispenser-01"

// --- servo wiring ---
#define REVOLVER_PIN   4   // selects the spice slot
#define DISPENSE_PIN   5   // sweeps to drop a dose

// revolver angle = SLOT0_ANGLE + slot * SLOT_STEP_DEG
#define SLOT0_ANGLE    10
#define SLOT_STEP_DEG  40

// dispense sweep geometry (degrees) and timing (ms)
#define DISP_REST_ANGLE  20
#define DISP_PUSH_ANGLE  120
#define DISP_DWELL_MS    300
