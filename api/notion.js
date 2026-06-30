// ============================================================================
// Vercel Serverless Function — Save to Notion
// ============================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { notionKey, notionDB, data } = req.body || {};
  if (!notionKey || !notionDB || !data) {
    return res.status(400).json({ error: 'Missing notionKey, notionDB or data' });
  }

  try {
    const body = {
      parent: { database_id: notionDB },
      properties: {
        Name: { title: [{ text: { content: data.title || data.url || 'Untitled' } }] },
        URL: { url: data.url },
        Summary: { rich_text: [{ text: { content: data.summary || '' } }] },
        Points: { rich_text: [{ text: { content: (data.points || []).join('\n') } }] },
        Source: { select: { name: data.source || 'web' } },
        Verdict: { select: { name: data.verdict || 'worth' } }
      }
    };

    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionKey}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const err = await r.json();
      return res.status(r.status).json({ ok: false, error: err.message || 'Notion API error' });
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
