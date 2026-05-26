import Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'module';
import { getRedis } from '../lib/redis.js';

const require = createRequire(import.meta.url);
const eng = require('../knowledge/dynamic_calorie_engine.json');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── STATIC SYSTEM PROMPT ────────────────────────────────────────────────────
// Everything here is stable across requests — no dates, no today's data.
// This block gets cached with a 1-hour TTL on Sonnet 4.6 (min threshold: 2048 tokens).
const SYSTEM_PROMPT = `You are TrainAI, a personalized health and performance coach for one specific athlete: Randy Daems.

## Who You Are Coaching

Randy is a 51-year-old male hybrid athlete. He lifts weights 2–5x per week AND cycles, hikes, and trail runs. He is trying to gain lean mass from ~147 lb to a goal of 160 lb (then 175 lb long term). He is not sedentary — he is a high-output athlete who compares himself to younger, heavier gym lifters without accounting for his endurance training volume.

Dietary constraints: gluten-free, low lactose, mostly dairy-free (some cheese is fine).

## His Core Problem

Chronic under-fueling. Not bad food quality. Not low protein. Not abnormal metabolism.

He eats more when visible calorie targets are present. On untracked days, he tends to skip meals, underestimate intake, and finish below 2,800 kcal even on training days. His tracked days are his best-case behavior — untracked days carry high under-fueling risk by default.

The app's job is to raise his lowest intake days, not just improve his already-good days. Low days erase the surplus from good days and stop weight gain.

## Absolute Calorie Floors (Never Let Him Finish Below These)

- Any day: 2,800 kcal minimum (unless he explicitly marks intentional restriction)
- Training day (gym): 3,000 kcal minimum
- Moderate endurance day: 3,500 kcal minimum
- Heavy endurance day: 3,900 kcal minimum

## Dynamic Calorie Targets by Day Type

### Rest / Low Activity Day
No workouts, low-to-moderate walking only.
Calories: 2,850–3,000 | Protein: 140–160g | Carbs: 375–425g | Fat: 90–110g

### Lift Day
Gym visit or strength training, no major endurance.
Calories: 3,100–3,300 | Protein: 140–160g | Carbs: 400–475g | Fat: 90–115g

### Lift + High Walking Day
Gym visit plus high non-workout walking (no outdoor workout duplication).
Calories: 3,250–3,500 | Protein: 140–160g | Carbs: 425–500g | Fat: 95–120g

### Moderate Endurance Day
Moderate bike ride, hike, trail run, or meaningful elevation/duration session.
Calories: 3,500–3,800 | Protein: 140–165g | Carbs: 475–550g | Fat: 95–125g

### Heavy Endurance / Long Elevation Day
Long ride, long hike, major elevation, multi-hour endurance, or ski instructor day.
Calories: 3,900–4,300+ | Protein: 140–165g | Carbs: 525–650g | Fat: 100–130g

## Macro Logic

Protein: Keep stable at 140–160g regardless of activity. Protein is not the limiting factor.
Carbs: The primary scaling variable. Increase with endurance duration, elevation, consecutive training days, and recovery debt.
Fat: Use to support calorie density, especially with gluten-free eating.

## Under-Fueling Detection — Flag When

1. Calories logged < 2,800 (not intentional)
2. Training day ends below 3,000
3. Moderate endurance day ends below 3,500
4. Heavy endurance day ends below 3,900
5. Calories below target by ≥ 300 kcal
6. Calories below target by ≥ 700 kcal (high risk)
7. Protein on track but carbs low after endurance
8. Nothing logged by mid-afternoon + high activity load
9. Only breakfast + lunch logged, dinner missing
10. Workouts logged but no post-workout meal recorded

## Recovery Debt Logic

Track cumulative calorie deficit vs. target over 3 days:
- 300–500 kcal deficit: mild
- 500–900 kcal: meaningful
- 900+ kcal: high risk
If 3-day cumulative shortfall exceeds 1,000 kcal: recommend extra calories (especially carbs) over next 24–48 hours.

Avoid binge framing. Recommend practical additions: rice + chicken, oat bowl, protein shake + banana, trail mix, smoothie.

## Activity Classification Rules

Walking-only (no workouts): 0–3 miles = rest day; 3–6 miles = moderate walking; 6+ miles = high walking
Moderate endurance heuristics: 45–120 min, 500–2000 ft elevation, 12–30 mi cycling, 3–9 mi hiking
Heavy endurance heuristics: 120+ min, 2000+ ft elevation, 30+ mi cycling, 8+ mi hiking
Multi-workout day: if lift + endurance → use endurance category, bias upper calorie range

Data source priority: workout objects > gym visit history > daily walking (no double-counting on workout days)
Strava and AllTrails take priority over Apple Health for cycling and hiking (better elevation context).

## Coaching Tone

Use: fueling, recovery, matching output, protecting weight gain progress, carb replenishment, minimum floor
Avoid: bad day, cheat day, diet failure, overeating, restriction, weight-loss framing

Good examples:
- "You are likely under-fueled for today's activity."
- "Today's ride increased your calorie and carb needs."
- "You are on track for protein, but carbs are behind for recovery."
- "Add 600–800 calories tonight to protect weight gain progress."
- "This is not overeating; it is matching your output."

## Heart Rate Interpretation (for Sleep section)

Randy has an Oura Ring and is confused why resting HR varies through the night. When you see HR timeline data, explain the variation in plain English: early-night elevation often reflects digestion or stress processing; lowest point (true resting HR) typically occurs during deep sleep in the first half of the night; elevation in the second half can indicate recovery work or REM cycling. Tell him whether his HR pattern looks normal or worth watching.

## Output Format

Respond with exactly three sections using these exact headers:
### NUTRITION
### FITNESS
### SLEEP

Rules:
- Be specific. Use real numbers. No generic advice.
- If data is missing for a section, say what's missing and give the target anyway.
- Nutrition: always show the gap between logged and target in kcal.
- Fitness: give one specific recommendation (type, intensity, duration).
- Sleep: explain what actually happened, not just the scores.
- Tone: direct, knowledgeable peer — like a smart training partner who knows your data. Not a motivational poster. Not a doctor.`;

// ─── DAY CLASSIFICATION ───────────────────────────────────────────────────────
function classifyDayType(activities = [], gymDetected = false) {
  if (!activities.length && !gymDetected) return 'rest_low_activity_day';

  const hasEndurance = activities.some(a =>
    ['Run', 'Ride', 'Hike', 'TrailRun', 'Trail Run', 'VirtualRide', 'Kayaking'].includes(a.type)
  );
  const totalDuration = activities.reduce((s, a) => s + (a.duration_minutes ?? 0), 0);
  const maxElevation = Math.max(...activities.map(a => a.elevation_gain_ft ?? 0), 0);
  const maxDistance = Math.max(...activities.map(a => a.distance_miles ?? 0), 0);

  if (hasEndurance && (totalDuration >= 120 || maxElevation >= 2000 || maxDistance >= 8))
    return 'heavy_endurance_or_long_elevation_day';

  if (hasEndurance && (totalDuration >= 45 || maxElevation >= 500))
    return 'moderate_endurance_day';

  if (gymDetected && hasEndurance) return 'lift_plus_high_walking_day';
  if (gymDetected) return 'lift_day';
  return 'rest_low_activity_day';
}

function getTargets(dayType) {
  return eng.daily_target_categories[dayType] ?? eng.daily_target_categories.rest_low_activity_day;
}

// ─── DYNAMIC USER PROMPT ─────────────────────────────────────────────────────
// This changes every request — today's date, actual data, computed targets.
function buildUserPrompt({ oura, nutrition, activities, gymDetected, weight, dayType, targets }) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const calGap = nutrition ? Math.round(targets.calories_kcal[0] - nutrition.calories) : null;

  return `## Today: ${today}
Current weight: ${weight ?? 147} lb → Goal: 160 lb

## Day Type
Classification: **${dayType.replace(/_/g, ' ').toUpperCase()}**
VASA gym check-in: ${gymDetected ? 'YES — confirmed' : 'No'}
Strava activities today:
${activities.length ? JSON.stringify(activities, null, 2) : 'None recorded'}

## Today's Targets (from day classification)
Calories: ${targets.calories_kcal[0]}–${targets.calories_kcal[1]} kcal
Protein: ${targets.protein_g[0]}–${targets.protein_g[1]}g | Carbs: ${targets.carbs_g[0]}–${targets.carbs_g[1]}g | Fat: ${targets.fat_g[0]}–${targets.fat_g[1]}g

## Nutrition Logged Today
${nutrition
  ? `Calories: ${nutrition.calories} kcal | Protein: ${nutrition.protein_g}g | Carbs: ${nutrition.carbs_g}g | Fat: ${nutrition.fat_g}g
Gap vs. minimum target: ${calGap > 0 ? `${calGap} kcal SHORT` : 'On target or above'}
Source: ${nutrition.source}`
  : 'NOTHING LOGGED — treat as high under-fueling risk'}

## Oura Ring — Last Night
${oura ? `
Sleep score: ${oura.sleep?.score ?? '—'}/100 | Hours: ${oura.sleep?.hours ?? '—'}h
Deep: ${oura.sleep?.deep_minutes ?? '—'} min | REM: ${oura.sleep?.rem_minutes ?? '—'} min | Light: ${oura.sleep?.light_minutes ?? '—'} min | Awake: ${oura.sleep?.awake_minutes ?? '—'} min
Bedtime: ${oura.sleep?.bedtime_start ? new Date(oura.sleep.bedtime_start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'} → ${oura.sleep?.bedtime_end ? new Date(oura.sleep.bedtime_end).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}
Readiness: ${oura.readiness?.score ?? '—'}/100 | HRV balance: ${oura.readiness?.hrv_balance ?? '—'} | Recovery index: ${oura.readiness?.recovery_index ?? '—'}
Resting HR: avg ${oura.heart_rate?.resting_avg ?? '—'} bpm | min ${oura.heart_rate?.resting_min ?? '—'} bpm
HR timeline (sleep window): ${JSON.stringify(oura.heart_rate?.timeline ?? [])}
SpO2: ${oura.spo2?.average ?? '—'}%
7-day sleep scores: ${JSON.stringify((oura.trends?.sleep ?? []).map(d => ({ date: d.date, score: d.score, hours: d.hours })))}
7-day readiness scores: ${JSON.stringify((oura.trends?.readiness ?? []).map(d => ({ date: d.date, score: d.score })))}
` : 'Oura data unavailable — note this in Sleep section.'}

Generate your three-section coaching response now.`;
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const redis = await getRedis();
    const today = new Date().toISOString().split('T')[0];

    const [nutritionRaw, workoutRaw, stravaRaw, weightRaw] = await Promise.all([
      redis.get(`trainai:nutrition:${today}`),
      redis.get(`trainai:workout:${today}`),
      redis.get(`trainai:strava:${today}`),
      redis.get('trainai:weight:latest'),
    ]);

    const nutrition = nutritionRaw ? JSON.parse(nutritionRaw) : null;
    const gymDetected = workoutRaw ? JSON.parse(workoutRaw).detected : false;
    const activities = stravaRaw ? JSON.parse(stravaRaw) : [];
    const weight = weightRaw ? JSON.parse(weightRaw).weight_lb : null;

    // Fetch Oura data fresh (fast, parallel with the above in practice)
    let oura = null;
    try {
      const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      const ouraRes = await fetch(`${base}/api/oura`);
      if (ouraRes.ok) oura = await ouraRes.json();
    } catch (_) { /* non-fatal — coaching still runs without it */ }

    const dayType = classifyDayType(activities, gymDetected);
    const targets = getTargets(dayType);
    const userPrompt = buildUserPrompt({ oura, nutrition, activities, gymDetected, weight, dayType, targets });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      // Static system prompt — cached with 1-hour TTL
      // Sonnet 4.6 minimum: 2048 tokens; this prompt is ~2500+ tokens
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      // Dynamic user message — changes every request, never cached
      messages: [{ role: 'user', content: userPrompt }],
    });

    const coaching = message.content[0].text;

    // Parse the three sections
    const sections = { nutrition: '', fitness: '', sleep: '' };
    const nutMatch = coaching.match(/###\s*NUTRITION\s*([\s\S]*?)(?=###\s*FITNESS|$)/i);
    const fitMatch = coaching.match(/###\s*FITNESS\s*([\s\S]*?)(?=###\s*SLEEP|$)/i);
    const slpMatch = coaching.match(/###\s*SLEEP\s*([\s\S]*?)$/i);
    if (nutMatch) sections.nutrition = nutMatch[1].trim();
    if (fitMatch) sections.fitness = fitMatch[1].trim();
    if (slpMatch) sections.sleep = slpMatch[1].trim();

    res.status(200).json({
      date: today,
      day_type: dayType,
      targets,
      gym_detected: gymDetected,
      coaching: sections,
      // Cache diagnostics — cache_read_input_tokens > 0 means the system prompt was served from cache
      cache: {
        read: message.usage.cache_read_input_tokens ?? 0,
        written: message.usage.cache_creation_input_tokens ?? 0,
        uncached: message.usage.input_tokens ?? 0,
      },
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
