export default async function handler(req, res) {
  const stravaToken = process.env.STRAVA_API_TOKEN;

  if (!stravaToken) {
    return res.status(400).json({ error: 'Missing STRAVA_API_TOKEN' });
  }

  try {
    // Fetch athlete activities from Strava API
    const activitiesRes = await fetch('https://www.strava.com/api/v3/athlete/activities', {
      headers: {
        'Authorization': `Bearer ${stravaToken}`,
      },
    });

    const activities = await activitiesRes.json();

    // Extract workout count and latest activity
    const workoutCount = activities.length;
    const latestWorkout = activities[0];

    res.status(200).json({
      workouts: workoutCount,
      latestActivity: latestWorkout,
      rawData: activities,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
