export default async function handler(req, res) {
  const macrosFirstToken = process.env.MACROSFIRST_API_TOKEN;

  if (!macrosFirstToken) {
    return res.status(400).json({ error: 'Missing MACROSFIRST_API_TOKEN' });
  }

  try {
    // Fetch nutrition data from MacrosFirst API
    const nutritionRes = await fetch('https://api.macrosfirst.com/v1/nutrition', {
      headers: {
        'Authorization': `Bearer ${macrosFirstToken}`,
      },
    });

    const nutritionData = await nutritionRes.json();

    res.status(200).json({
      nutrition: nutritionData,
      rawData: nutritionData,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
