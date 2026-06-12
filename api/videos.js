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

// Batch-tag a list of videos in chunks (Haiku — fast and cheap for classification)
async function tagVideos(videos) {
  if (!videos.length) return [];

  const CHUNK = 20;
  const allTags = [];

  for (let start = 0; start < videos.length; start += CHUNK) {
    const chunk = videos.slice(start, start + CHUNK);
    const list = chunk.map((v, i) =>
      `[${i}] Channel: ${v.channel} | Title: ${v.title} | Description: ${v.description.slice(0, 150)}`
    ).join('\n');

    try {
      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are tagging fitness videos for a personal training app used by a 51-year-old hybrid athlete (lifts + hikes + cycles). His main goals are: gaining muscle mass, hiking endurance, hip and shoulder mobility, and back development.

Tag each video with the SINGLE most relevant category from this list:
${CATEGORIES.join(', ')}

Also identify the source type:
- "athleanx" if channel is AthleanX or Jeff Cavaliere
- "moves_method" if channel is Moves Method or similar mobility-focused
- "other" for anything else

Return ONLY a JSON array — no explanation, no markdown. One object per video, in the same order as the input list.
Format: [{"index": 0, "category": "strength_back", "source": "athleanx", "tags": ["back", "lats", "width"]}, ...]
The "tags" field should have 2-4 specific muscle groups or movement patterns.

Videos to classify:
${list}`,
        }],
      });

      const text = message.content[0].text.trim();
      const json = text.startsWith('[') ? text : text.slice(text.indexOf('['));
      const parsed = JSON.parse(json);
      // Re-index to absolute positions
      parsed.forEach(t => { t.index = start + t.index; });
      allTags.push(...parsed);
    } catch {
      // Fallback for this chunk
      chunk.forEach((_, i) => allTags.push({ index: start + i, category: 'general_fitness', source: 'other', tags: [] }));
    }
  }

  return allTags;
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
