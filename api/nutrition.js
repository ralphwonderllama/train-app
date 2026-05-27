import { getRedis } from '../lib/redis.js';

// Parse a MacrosFirst CSV row into our normalized schema
function parseRow(row) {
  const cols = row.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
  if (cols.length < 14 || !cols[0]) return null;
  const date = cols[0]; // e.g. "4/30/2026"
  if (!date.match(/\d+\/\d+\/\d+/)) return null;

  // Normalize date to YYYY-MM-DD
  const [m, d, y] = date.split('/');
  const isoDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;

  return {
    date: isoDate,
    protein_g: parseFloat(cols[2]) || 0,
    carbs_g: parseFloat(cols[5]) || 0,
    fat_g: parseFloat(cols[8]) || 0,
    calories: parseFloat(cols[11]) || 0,
    water_ml: parseFloat(cols[14]) || null,
    fiber_g: parseFloat(cols[18]) || null,
    source: 'macrosfirst_export',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = await getRedis();

  // GET — return recent nutrition data (last 7 days)
  if (req.method === 'GET') {
    const days = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(today - i * 86400000).toISOString().split('T')[0];
      const entry = await redis.get(`trainai:nutrition:${d}`);
      if (entry) days.push(JSON.parse(entry));
    }
    return res.status(200).json({ days, count: days.length });
  }

  // POST — two modes: 'daily_entry' (manual) or 'batch_csv' (MacrosFirst export via n8n)
  if (req.method === 'POST') {
    const { type, ...payload } = req.body ?? {};

    // Manual daily entry from the app (calories, protein, carbs, fat for today)
    if (type === 'daily_entry') {
      const { date, calories, protein_g, carbs_g, fat_g } = payload;
      if (!calories || !date) return res.status(400).json({ error: 'date and calories required' });

      const entry = {
        date,
        calories: parseFloat(calories),
        protein_g: parseFloat(protein_g ?? 0),
        carbs_g: parseFloat(carbs_g ?? 0),
        fat_g: parseFloat(fat_g ?? 0),
        source: 'manual',
        updated_at: new Date().toISOString(),
      };

      await redis.set(`trainai:nutrition:${date}`, JSON.stringify(entry), { EX: 86400 * 30 });
      return res.status(200).json({ ok: true, entry });
    }

    // Batch CSV from MacrosFirst export (sent by n8n)
    if (type === 'batch_csv') {
      const { csv } = payload;
      if (!csv) return res.status(400).json({ error: 'csv field required' });

      const lines = csv.split('\n').slice(1); // skip header row
      const saved = [];
      const skippedParse = [];
      const skippedManual = []; // dates where manual entry already exists — never overwrite

      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = parseRow(line);
        if (!entry) { skippedParse.push(line.slice(0, 40)); continue; }

        // Don't overwrite a manual entry — manual = real-time, CSV = weekly batch
        const existing = await redis.get(`trainai:nutrition:${entry.date}`);
        if (existing) {
          const parsed = JSON.parse(existing);
          if (parsed.source === 'manual') { skippedManual.push(entry.date); continue; }
        }

        await redis.set(`trainai:nutrition:${entry.date}`, JSON.stringify(entry), { EX: 86400 * 90 });
        saved.push(entry.date);
      }

      return res.status(200).json({
        ok: true,
        saved: saved.length,
        skipped_parse_errors: skippedParse.length,
        skipped_manual_entries: skippedManual.length,
        dates: saved,
        protected_dates: skippedManual, // so n8n can log which dates were protected
      });
    }

    return res.status(400).json({ error: 'type must be daily_entry or batch_csv' });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
