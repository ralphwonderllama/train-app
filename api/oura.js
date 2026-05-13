export default async function handler(req, res) {
  const ouraToken = process.env.OURA_API_TOKEN;

  if (!ouraToken) {
    return res.status(400).json({ error: 'Missing OURA_API_TOKEN' });
  }

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const yesterdayStr = new Date(today - 86400000).toISOString().split('T')[0];

  const headers = { Authorization: `Bearer ${ouraToken}` };

  try {
    const [sleepRes, readinessRes, activityRes] = await Promise.all([
      fetch(`https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=${yesterdayStr}&end_date=${todayStr}`, { headers }),
      fetch(`https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=${yesterdayStr}&end_date=${todayStr}`, { headers }),
      fetch(`https://api.ouraring.com/v2/usercollection/daily_activity?start_date=${yesterdayStr}&end_date=${todayStr}`, { headers }),
    ]);

    const [sleepData, readinessData, activityData] = await Promise.all([
      sleepRes.json(),
      readinessRes.json(),
      activityRes.json(),
    ]);

    const sleep = sleepData.data?.[sleepData.data.length - 1] ?? null;
    const readiness = readinessData.data?.[readinessData.data.length - 1] ?? null;
    const activity = activityData.data?.[activityData.data.length - 1] ?? null;

    const totalSleepHours = sleep?.contributors?.total_sleep
      ? Math.round((sleep.total_sleep_duration ?? 0) / 360) / 10
      : null;

    res.status(200).json({
      sleep: {
        score: sleep?.score ?? null,
        hours: totalSleepHours,
        efficiency: sleep?.contributors?.efficiency ?? null,
        deep: sleep?.contributors?.deep_sleep ?? null,
        rem: sleep?.contributors?.rem_sleep ?? null,
        restfulness: sleep?.contributors?.restfulness ?? null,
      },
      readiness: {
        score: readiness?.score ?? null,
        hrv_balance: readiness?.contributors?.hrv_balance ?? null,
        recovery_index: readiness?.contributors?.recovery_index ?? null,
        resting_heart_rate: readiness?.contributors?.resting_heart_rate ?? null,
      },
      activity: {
        score: activity?.score ?? null,
        steps: activity?.steps ?? null,
        active_calories: activity?.active_calories ?? null,
        total_calories: activity?.total_calories ?? null,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
