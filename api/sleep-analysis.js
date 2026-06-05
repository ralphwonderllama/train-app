// Deep longitudinal sleep analysis — 60 days of Oura data
// Analyzes: wake time clustering, SpO2/BDI trends, deep sleep timing,
// HRV trajectory, and surfaces apnea-relevant signals
// Results cached in Redis for 1 hour to avoid hammering Oura API

import { getRedis } from '../lib/redis.js';

const CACHE_KEY = 'trainai:sleep_analysis';
const CACHE_TTL = 3600; // 1 hour

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.OURA_API_TOKEN;
  if (!token) return res.status(400).json({ error: 'Missing OURA_API_TOKEN' });

  // Return cached result unless ?refresh=true
  let redis;
  try {
    redis = await getRedis();
    if (req.query.refresh !== 'true') {
      const cached = await redis.get(CACHE_KEY);
      if (cached) return res.status(200).json({ ...JSON.parse(cached), from_cache: true });
    }
  } catch { /* non-fatal — proceed without cache */ }

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const sixtyDaysAgo = new Date(today - 60 * 86400000).toISOString().split('T')[0];
  const h = { Authorization: `Bearer ${token}` };

  try {
    // Fetch everything in parallel
    const [sleepRes, spo2Res, dailySleepRes, readinessRes] = await Promise.all([
      fetch(`https://api.ouraring.com/v2/usercollection/sleep?start_date=${sixtyDaysAgo}&end_date=${todayStr}`, { headers: h }),
      fetch(`https://api.ouraring.com/v2/usercollection/daily_spo2?start_date=${sixtyDaysAgo}&end_date=${todayStr}`, { headers: h }),
      fetch(`https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=${sixtyDaysAgo}&end_date=${todayStr}`, { headers: h }),
      fetch(`https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=${sixtyDaysAgo}&end_date=${todayStr}`, { headers: h }),
    ]);

    const [sleepData, spo2Data, dailySleepData, readinessData] = await Promise.all([
      sleepRes.json(), spo2Res.json(), dailySleepRes.json(), readinessRes.json(),
    ]);

    const sessions    = sleepData.data     ?? [];
    const spo2Days    = spo2Data.data      ?? [];
    const dailySleep  = dailySleepData.data ?? [];
    const readiness   = readinessData.data  ?? [];

    // ── 1. WAKE TIME CLUSTERING ─────────────────────────────────────────────
    // Hypnogram codes: '1' = deep, '2' = light, '3' = REM, '4' = awake
    // Each character = 5-minute interval from bedtime_start

    const wakeHourBuckets = new Array(24).fill(0);
    const nightWakeDetails = [];

    sessions.forEach(session => {
      if (!session.sleep_phase_5_min || !session.bedtime_start) return;

      const startTime = new Date(session.bedtime_start);
      const phases = session.sleep_phase_5_min;
      const wakeEvents = [];
      let i = 0;

      while (i < phases.length) {
        if (phases[i] === '4') {
          const runStart = i;
          while (i < phases.length && phases[i] === '4') i++;
          const runLength = i - runStart;
          if (runLength >= 2) { // 10+ minutes = meaningful awakening, not a micro-arousal
            const minutesFromStart = runStart * 5;
            const wakeTime = new Date(startTime.getTime() + minutesFromStart * 60000);
            const localHour = wakeTime.getHours();
            const localMin  = wakeTime.getMinutes();
            wakeHourBuckets[localHour]++;
            wakeEvents.push({
              clock_time: `${String(localHour).padStart(2,'0')}:${String(localMin).padStart(2,'0')}`,
              hour_decimal: Math.round((localHour + localMin / 60) * 100) / 100,
              duration_min: runLength * 5,
              minutes_into_sleep: minutesFromStart,
            });
          }
        } else {
          i++;
        }
      }

      if (wakeEvents.length) {
        nightWakeDetails.push({
          date: session.day,
          bedtime: new Date(session.bedtime_start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          wake_events: wakeEvents,
        });
      }
    });

    const totalWakeEvents     = wakeHourBuckets.reduce((a, b) => a + b, 0);
    const wakeEvents_3_6am    = wakeHourBuckets.slice(3, 6).reduce((a, b) => a + b, 0);  // 3 AM – 5:59 AM
    const wakeEvents_3_5am    = wakeHourBuckets.slice(3, 5).reduce((a, b) => a + b, 0);  // 3 AM – 4:59 AM (Randy's window)
    const concentration_3_6   = totalWakeEvents > 0
      ? Math.round((wakeEvents_3_6am / totalWakeEvents) * 100) : 0;

    // Find the single most common wake hour
    const peakWakeHour = wakeHourBuckets.indexOf(Math.max(...wakeHourBuckets));

    // ── 2. SpO2 & BREATHING DISTURBANCE ────────────────────────────────────
    const spo2Series = spo2Days
      .filter(d => d.spo2_percentage?.average != null)
      .map(d => ({
        date: d.day,
        avg: Math.round(d.spo2_percentage.average * 10) / 10,
        min: d.spo2_percentage.minimum ?? null,
        bdi: d.breathing_disturbance_index ?? null,
      }));

    const spo2Avg60 = spo2Series.length
      ? Math.round((spo2Series.reduce((s, d) => s + d.avg, 0) / spo2Series.length) * 10) / 10
      : null;
    const spo2Avg14 = spo2Series.slice(-14).length
      ? Math.round((spo2Series.slice(-14).reduce((s, d) => s + d.avg, 0) / spo2Series.slice(-14).length) * 10) / 10
      : null;

    const nightsBelow95 = spo2Series.filter(d => d.avg < 95).length;
    const nightsBelow94 = spo2Series.filter(d => d.avg < 94).length;

    const bdiSeries  = spo2Series.filter(d => d.bdi != null);
    const avgBDI     = bdiSeries.length
      ? Math.round((bdiSeries.reduce((s, d) => s + d.bdi, 0) / bdiSeries.length) * 10) / 10
      : null;
    const highBDINights  = bdiSeries.filter(d => d.bdi > 10).length; // BDI >10 is clinically notable
    const elevatedBDINights = bdiSeries.filter(d => d.bdi > 6).length;

    // ── 3. DEEP SLEEP TIMING ────────────────────────────────────────────────
    // Deep sleep should predominate in the first 1/3 of the night
    const deepTimingSeries = [];

    sessions.forEach(session => {
      if (!session.sleep_phase_5_min) return;
      const phases = session.sleep_phase_5_min;
      const n = phases.length;
      const third = Math.floor(n / 3);

      const deepFirst  = [...phases.slice(0, third)].filter(p => p === '1').length;
      const deepMiddle = [...phases.slice(third, 2 * third)].filter(p => p === '1').length;
      const deepLast   = [...phases.slice(2 * third)].filter(p => p === '1').length;
      const totalDeep  = deepFirst + deepMiddle + deepLast;

      if (totalDeep > 0) {
        deepTimingSeries.push({
          date: session.day,
          deep_total_min: totalDeep * 5,
          pct_first_third: Math.round((deepFirst / totalDeep) * 100),
          pct_middle_third: Math.round((deepMiddle / totalDeep) * 100),
          pct_last_third: Math.round((deepLast / totalDeep) * 100),
        });
      }
    });

    const avgDeepPctFirstThird = deepTimingSeries.length
      ? Math.round(deepTimingSeries.reduce((s, d) => s + d.pct_first_third, 0) / deepTimingSeries.length)
      : null;

    // ── 4. SLEEP SCORE & EFFICIENCY TREND ──────────────────────────────────
    const scoreSeries = dailySleep
      .filter(d => d.score != null)
      .map(d => ({
        date: d.day,
        score:        d.score,
        efficiency:   d.contributors?.efficiency    ?? null,
        restfulness:  d.contributors?.restfulness   ?? null,
        deep_score:   d.contributors?.deep_sleep    ?? null,
        rem_score:    d.contributors?.rem_sleep     ?? null,
        total_hours:  d.total_sleep_duration
          ? Math.round(d.total_sleep_duration / 360) / 10 : null,
      }));

    const avgScore14d = scoreSeries.slice(-14).filter(d => d.score).length
      ? Math.round(scoreSeries.slice(-14).reduce((s, d) => s + d.score, 0)
          / scoreSeries.slice(-14).filter(d => d.score).length)
      : null;
    const avgScore60d = scoreSeries.filter(d => d.score).length
      ? Math.round(scoreSeries.reduce((s, d) => s + d.score, 0)
          / scoreSeries.filter(d => d.score).length)
      : null;

    // Restfulness trend (low = lots of micro-arousals/movement)
    const avgRestfulness14d = scoreSeries.slice(-14).filter(d => d.restfulness).length
      ? Math.round(scoreSeries.slice(-14).reduce((s, d) => s + (d.restfulness || 0), 0)
          / scoreSeries.slice(-14).filter(d => d.restfulness).length)
      : null;

    // ── 5. HRV TREND ───────────────────────────────────────────────────────
    const hrvSeries = readiness
      .filter(d => d.hrv_average != null)
      .map(d => ({
        date: d.day,
        hrv: d.hrv_average,
        rhr: d.resting_heart_rate ?? null,
      }));

    const avgHRV60d = hrvSeries.length
      ? Math.round(hrvSeries.reduce((s, d) => s + d.hrv, 0) / hrvSeries.length)
      : null;
    const avgHRV14d = hrvSeries.slice(-14).length
      ? Math.round(hrvSeries.slice(-14).reduce((s, d) => s + d.hrv, 0) / hrvSeries.slice(-14).length)
      : null;
    const hrvTrend = avgHRV14d && avgHRV60d
      ? (avgHRV14d > avgHRV60d + 2 ? 'improving' : avgHRV14d < avgHRV60d - 2 ? 'declining' : 'stable')
      : 'insufficient data';

    // ── 6. APNEA SIGNAL SCORING ────────────────────────────────────────────
    // NOT a diagnosis — these are consumer-device signals only
    const apneaSignals = [];
    const apneaWarnings = [];

    if (spo2Avg60 != null && spo2Avg60 < 95)
      apneaSignals.push({ label: `Avg SpO2 (60d): ${spo2Avg60}%`, severity: 'high', detail: 'Below 95% average is clinically significant' });
    else if (spo2Avg60 != null)
      apneaSignals.push({ label: `Avg SpO2 (60d): ${spo2Avg60}%`, severity: 'ok', detail: 'Average SpO2 in normal range' });

    if (nightsBelow95 > 5)
      apneaSignals.push({ label: `${nightsBelow95} nights with avg SpO2 < 95%`, severity: 'high', detail: 'Frequent desaturation nights' });
    if (nightsBelow94 > 0)
      apneaSignals.push({ label: `${nightsBelow94} nights with avg SpO2 < 94%`, severity: 'high', detail: 'SpO2 drops below 94% are clinically concerning' });

    if (avgBDI != null && avgBDI > 10)
      apneaSignals.push({ label: `Avg Breathing Disturbance Index: ${avgBDI}`, severity: 'high', detail: 'BDI > 10 warrants clinical evaluation' });
    else if (avgBDI != null && avgBDI > 6)
      apneaSignals.push({ label: `Avg Breathing Disturbance Index: ${avgBDI}`, severity: 'medium', detail: 'Borderline elevated BDI — monitor' });
    else if (avgBDI != null)
      apneaSignals.push({ label: `Avg Breathing Disturbance Index: ${avgBDI}`, severity: 'ok', detail: 'BDI within normal range' });

    if (highBDINights > 3)
      apneaSignals.push({ label: `${highBDINights} nights with BDI > 10`, severity: 'high', detail: 'Repeated high-BDI nights are a stronger signal than average alone' });

    if (concentration_3_6 > 50)
      apneaSignals.push({ label: `${concentration_3_6}% of awakenings between 3–6 AM (${wakeEvents_3_6am} events)`, severity: 'medium', detail: 'Strong clustering in the eszopiclone clearance window' });

    if (avgRestfulness14d != null && avgRestfulness14d < 60)
      apneaSignals.push({ label: `Low restfulness score avg: ${avgRestfulness14d}/100`, severity: 'medium', detail: 'Low restfulness reflects frequent micro-arousals consistent with apnea or drug clearance' });

    const highSignals = apneaSignals.filter(s => s.severity === 'high').length;
    const medSignals  = apneaSignals.filter(s => s.severity === 'medium').length;
    const apneaRisk =
      highSignals >= 2 ? 'elevated — recommend sleep study' :
      highSignals === 1 || medSignals >= 3 ? 'moderate — worth discussing with clinician' :
      'low based on available Oura data';

    // ── ESZOPICLONE CLEARANCE ANALYSIS ─────────────────────────────────────
    const nightsWithEszWindow = nightWakeDetails.filter(n =>
      n.wake_events.some(e => e.hour_decimal >= 3.0 && e.hour_decimal <= 5.5)
    ).length;
    const eszWindowPct = nightWakeDetails.length > 0
      ? Math.round((nightsWithEszWindow / nightWakeDetails.length) * 100)
      : null;

    // ── BUILD RESULT ───────────────────────────────────────────────────────
    const result = {
      generated_at: new Date().toISOString(),
      days_analyzed: sessions.length,
      date_range: { from: sixtyDaysAgo, to: todayStr },

      wake_pattern: {
        hour_distribution: wakeHourBuckets,
        total_meaningful_awakenings: totalWakeEvents,
        in_3_6am_window: wakeEvents_3_6am,
        in_3_5am_window: wakeEvents_3_5am,
        concentration_3_6am_pct: concentration_3_6,
        peak_wake_hour: peakWakeHour,
        nights_with_wake_data: nightWakeDetails.length,
        nights_with_3am_5am_wake: nightsWithEszWindow,
        esz_window_pct: eszWindowPct,
        recent_nights: nightWakeDetails.slice(-21), // last 3 weeks
      },

      spo2: {
        avg_60d: spo2Avg60,
        avg_14d: spo2Avg14,
        nights_below_95: nightsBelow95,
        nights_below_94: nightsBelow94,
        avg_breathing_disturbance_index: avgBDI,
        nights_bdi_above_10: highBDINights,
        nights_bdi_above_6: elevatedBDINights,
        daily: spo2Series,
      },

      deep_sleep: {
        avg_pct_in_first_third: avgDeepPctFirstThird,
        interpretation: avgDeepPctFirstThird >= 60
          ? 'Normal — deep sleep predominantly in first part of night'
          : avgDeepPctFirstThird >= 40
          ? 'Slightly fragmented — some deep sleep occurring later than ideal'
          : 'Disrupted — deep sleep not properly front-loaded',
        nightly: deepTimingSeries.slice(-30),
      },

      sleep_scores: {
        avg_score_14d: avgScore14d,
        avg_score_60d: avgScore60d,
        avg_restfulness_14d: avgRestfulness14d,
        trend: avgScore14d && avgScore60d
          ? (avgScore14d > avgScore60d + 3 ? 'improving' :
             avgScore14d < avgScore60d - 3 ? 'declining' : 'stable')
          : 'insufficient data',
        nightly: scoreSeries,
      },

      hrv: {
        avg_60d: avgHRV60d,
        avg_14d: avgHRV14d,
        trend: hrvTrend,
        series: hrvSeries,
      },

      apnea_assessment: {
        signals: apneaSignals,
        risk_level: apneaRisk,
        disclaimer: 'Oura Ring is a consumer device, not an FDA-cleared diagnostic tool. This analysis cannot diagnose or rule out sleep apnea. A formal polysomnography or home sleep apnea test is required for clinical assessment.',
      },

      eszopiclone_analysis: {
        half_life_hours: 6,
        typical_dose_timing: '10–10:30 PM',
        expected_50pct_clearance: '4:00–4:30 AM',
        nights_with_3_5am_wake: nightsWithEszWindow,
        nights_with_any_wake: nightWakeDetails.length,
        pct_waking_in_esz_window: eszWindowPct,
        interpretation: eszWindowPct == null
          ? 'Insufficient wake data'
          : eszWindowPct >= 60
          ? 'Strong pattern — majority of awakenings align with eszopiclone clearance window. Drug pharmacokinetics are a likely contributor.'
          : eszWindowPct >= 35
          ? 'Moderate pattern — frequent awakenings in clearance window. Both drug clearance and other factors (apnea, cortisol) may be contributing.'
          : 'Weak pattern — awakenings not concentrated in clearance window. Other causes more likely.',
      },
    };

    // Cache
    if (redis) {
      try { await redis.set(CACHE_KEY, JSON.stringify(result), { EX: CACHE_TTL }); } catch {}
    }

    return res.status(200).json(result);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
