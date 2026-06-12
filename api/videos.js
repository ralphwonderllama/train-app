import Anthropic from '@anthropic-ai/sdk';
import { getRedis } from '../lib/redis.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PLAYLIST_ID = 'PLrVpigQI9d3JM3hkQxLhTA0MWezwGWxnJ';

// Category taxonomy — used for filtering in the app
const CATEGORIES = [
  'strength_back',        // lat width, rows, pulldowns, back thickness
  'strength_chest',       // chest, pecs, bench press
  'strength_shoulders',   // deltoids, overhead press, rotator cuff strength
  'strength_arms',        // biceps, triceps, forearms
  'strength_legs',        // quads, hamstrings, glutes, calves, squat pattern
  'strength_core',        // abs, obliques, core stability
  'hip_mobility',         // hip flexors, hip mobility, hip opening, glute activation
  'shoulder_mobility',    // shoulder mobility, thoracic rotation, overhead range
  'spine_mobility',       // spine, thoracic, lower back mobility
  'full_body_flexibility',// stretching, full body flexibility, yoga-style
  'cardio_conditioning',  // cardio, endurance, HIIT, conditioning
  'posture',              // posture correction, alignment
  'general_fitness',      // doesn't clearly fit another category
];

// Fetch all pages of playlist items from YouTube Data API
async function fetchPlaylistVideos(apiKey) {
  const videos = [];
  let pageToken = '';

  do {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('playlistId', PLAYLIST_ID);
    url.searchParams.set('key', apiKey);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`YouTube API error ${res.status}: ${err?.error?.message ?? res.statusText}`);
    }
    const data = await res.json();

    for (const item of data.items ?? []) {
      const s = item.snippet;
      if (s?.resourceId?.videoId) {
        videos.push({
          video_id: s.resourceId.videoId,
          title: s.title ?? '',
          description: (s.description ?? '').slice(0, 300), // cap for prompt efficiency
          channel: s.videoOwnerChannelTitle ?? '',
          thumbnail: s.thumbnails?.medium?.url ?? s.thumbnails?.default?.url ?? '',
          url: `https://www.youtube.com/watch?v=${s.resourceId.videoId}`,
        });
      }
    }

    pageToken = data.nextPageToken ?? '';
  } while (pageToken);

  return videos;
}

// Keyword-based tagger — instant, no API call, works from title alone
const RULES = [
  { cat: 'hip_mobility',         kw: ['hip','glute activation','hip flexor','piriformis','it band','iliotibial','groin'] },
  { cat: 'shoulder_mobility',    kw: ['shoulder mobility','thoracic','overhead range','rotator cuff','impingement','t-spine'] },
  { cat: 'spine_mobility',       kw: ['spine','spinal','lower back mobility','back mobility','lumbar','disc'] },
  { cat: 'full_body_flexibility', kw: ['stretch','flexibility','yoga','morning routine','stiff','mobility routine','move better','movement problem','ankl'] },
  { cat: 'posture',              kw: ['posture','alignment','forward head','text neck','rounded'] },
  { cat: 'cardio_conditioning',  kw: ['cardio','hiit','conditioning','endurance','zone 2','vo2','aerobic','fat loss','fat burn'] },
  { cat: 'strength_back',        kw: ['back','lat','lats','row','deadlift','pulldown','pull-up','pullup','pull up','rhomboid','trap','rear delt'] },
  { cat: 'strength_chest',       kw: ['chest','pec','bench','push-up','pushup','push up','pectoral'] },
  { cat: 'strength_shoulders',   kw: ['shoulder','delt','overhead press','military press','lateral raise'] },
  { cat: 'strength_arms',        kw: ['bicep','tricep','arm','curl','forearm','elbow'] },
  { cat: 'strength_legs',        kw: ['leg','quad','hamstring','glute','squat','lunge','calf','calves','knee','rdl','romanian','step up','hip thrust'] },
  { cat: 'strength_core',        kw: ['core','ab ','abs','abdominal','oblique','plank','six pack','six-pack','crunch'] },
];

function keywordTag(video) {
  const text = (video.title + ' ' + video.description).toLowerCase();
  for (const rule of RULES) {
    if (rule.kw.some(k => text.includes(k))) return rule.cat;
  }
  return 'general_fitness';
}

function sourceTag(channel) {
  const c = (channel || '').toLowerCase();
  if (c.includes('athlean') || c.includes('cavaliere')) return 'athleanx';
  if (c.includes('moves') || c.includes('movesmethod')) return 'moves_method';
  return 'other';
}

function tagVideos(videos) {
  return videos.map((v, i) => ({
    index: i,
    category: keywordTag(v),
    source: sourceTag(v.channel),
    tags: [],
  }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = await getRedis();

  // GET — return video index, optionally filtered by category
  if (req.method === 'GET') {
    const { category } = req.query ?? {};
    const raw = await redis.get('trainai:videos:index');

    if (!raw) {
      return res.status(200).json({
        videos: [],
        categories: CATEGORIES,
        message: 'No videos indexed yet. POST with {"action":"sync"} to build the index.',
      });
    }

    let videos = JSON.parse(raw);
    if (category && category !== 'all') {
      videos = videos.filter(v => v.category === category);
    }

    return res.status(200).json({
      videos,
      total: JSON.parse(raw).length,
      filtered: videos.length,
      categories: CATEGORIES,
      last_synced: await redis.get('trainai:videos:last_synced'),
    });
  }

  // POST {action: "sync"} — delta sync: only tag videos not already in the index
  if (req.method === 'POST') {
    const { action } = req.body ?? {};
    if (action !== 'sync') return res.status(400).json({ error: 'action must be "sync"' });

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'YOUTUBE_API_KEY not set in Vercel env vars' });

    // Fetch current playlist from YouTube
    const playlistVideos = await fetchPlaylistVideos(apiKey);
    if (!playlistVideos.length) return res.status(200).json({ ok: true, count: 0, message: 'Playlist appears empty or inaccessible' });

    // Load existing index from Redis
    const existingRaw = await redis.get('trainai:videos:index');
    const existingIndex = existingRaw ? JSON.parse(existingRaw) : [];
    const existingById = Object.fromEntries(existingIndex.map(v => [v.video_id, v]));

    // Delta: which video_ids are new (not yet tagged)?
    const playlistIds = new Set(playlistVideos.map(v => v.video_id));
    const newVideos = playlistVideos.filter(v => !existingById[v.video_id]);
    // Which videos were removed from the playlist?
    const removedCount = existingIndex.filter(v => !playlistIds.has(v.video_id)).length;

    // Only tag the new additions
    const newTags = await tagVideos(newVideos);
    const newTagged = newVideos.map((v, i) => {
      const t = newTags.find(t => t.index === i) ?? { category: 'general_fitness', source: 'other', tags: [] };
      return { ...v, category: t.category, source: t.source, tags: t.tags };
    });

    // Merge: keep existing tagged videos still in the playlist + add newly tagged
    const merged = [
      ...existingIndex.filter(v => playlistIds.has(v.video_id)), // existing, still present
      ...newTagged,                                                // new additions
    ];

    // Preserve playlist order (YouTube returns them in order added)
    const orderMap = Object.fromEntries(playlistVideos.map((v, i) => [v.video_id, i]));
    merged.sort((a, b) => (orderMap[a.video_id] ?? 999) - (orderMap[b.video_id] ?? 999));

    // Store merged index — TTL reset to 7 days on every sync
    await redis.set('trainai:videos:index', JSON.stringify(merged), { EX: 86400 * 7 });
    await redis.set('trainai:videos:last_synced', new Date().toISOString(), { EX: 86400 * 7 });

    // Category breakdown
    const breakdown = {};
    merged.forEach(v => { breakdown[v.category] = (breakdown[v.category] ?? 0) + 1; });

    return res.status(200).json({
      ok: true,
      total: merged.length,
      added: newTagged.length,
      removed: removedCount,
      reused: existingIndex.length - removedCount,
      breakdown,
      new_videos: newTagged.slice(0, 5), // preview of what was just added
    });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
