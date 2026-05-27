import { getRedis } from '../lib/redis.js';

// Three supplement groups + medications tracked daily
// Stored as trainai:supplements:{YYYY-MM-DD}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = await getRedis();
  const today = new Date().toISOString().split('T')[0];

  if (req.method === 'GET') {
    const { date } = req.query ?? {};
    const key = date ?? today;
    const raw = await redis.get(`trainai:supplements:${key}`);

    // Also return last 7 days for trend
    const history = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
      const entry = await redis.get(`trainai:supplements:${d}`);
      if (entry) history.push(JSON.parse(entry));
    }

    return res.status(200).json({
      today: key,
      entry: raw ? JSON.parse(raw) : null,
      history,
    });
  }

  if (req.method === 'POST') {
    const body = req.body ?? {};
    const date = body.date ?? today;

    // Merge with existing entry so partial updates work
    const existing = await redis.get(`trainai:supplements:${date}`);
    const prev = existing ? JSON.parse(existing) : {};

    const entry = {
      date,
      updated_at: new Date().toISOString(),

      // ── SUPPLEMENT GROUPS ──────────────────────────────────────────────────
      // Simple boolean: did you take this group today?
      morning_daily_advantage: body.morning_daily_advantage ?? prev.morning_daily_advantage ?? null,
      afternoon_supplements:   body.afternoon_supplements   ?? prev.afternoon_supplements   ?? null,
      nighttime_supplements:   body.nighttime_supplements   ?? prev.nighttime_supplements   ?? null,

      // ── MEDICATIONS ───────────────────────────────────────────────────────
      // Wellbutrin — just yes/no
      wellbutrin_taken: body.wellbutrin_taken ?? prev.wellbutrin_taken ?? null,

      // Eszopiclone — dose (mg) + whether extra dose was needed in night
      eszopiclone_dose_mg:     body.eszopiclone_dose_mg     ?? prev.eszopiclone_dose_mg     ?? null,
      eszopiclone_extra_dose:  body.eszopiclone_extra_dose  ?? prev.eszopiclone_extra_dose  ?? null, // bool: took extra 1mg?
      eszopiclone_extra_time:  body.eszopiclone_extra_time  ?? prev.eszopiclone_extra_time  ?? null, // e.g. "4:00 AM"

      // LDN — dose (mg) + time taken (morning vs night matters for sleep disruption)
      ldn_taken:     body.ldn_taken     ?? prev.ldn_taken     ?? null,
      ldn_dose_mg:   body.ldn_dose_mg   ?? prev.ldn_dose_mg   ?? null,
      ldn_time:      body.ldn_time      ?? prev.ldn_time       ?? null, // "morning" | "evening" | "HH:MM"
      ldn_sleep_disruption: body.ldn_sleep_disruption ?? prev.ldn_sleep_disruption ?? null, // bool: disrupted sleep?

      // ── NOTES ─────────────────────────────────────────────────────────────
      notes: body.notes ?? prev.notes ?? null,
    };

    // TTL: 90 days
    await redis.set(`trainai:supplements:${date}`, JSON.stringify(entry), { EX: 86400 * 90 });

    return res.status(200).json({ ok: true, entry });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
