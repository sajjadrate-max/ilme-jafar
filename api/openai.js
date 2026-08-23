export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { prompt } = req.body || {};
    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });
      return;
    }

    const openaiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        input: prompt
      })
    });

    const data = await openaiRes.json();

    if (!openaiRes.ok) {
      res.status(openaiRes.status).json({ error: data.error ? data.error.message : 'OpenAI request failed' });
      return;
    }

    let text = data.output_text || '';
    if (!text && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.content) {
          for (const c of item.content) {
            if (c.text) { text += c.text; }
          }
        }
      }
    }

    res.status(200).json({ output_text: text });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unknown server error' });
  }
          }
