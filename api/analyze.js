// ============================================================================
// Vercel Serverless Function — Snip Content Analyzer
// POST { url } → fetches content → DeepSeek AI analysis
// ============================================================================

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  try {
    // 1. 抓取内容
    const { title, text, source } = await fetchContent(url);

    if (!text || text.length < 20) {
      return res.json({
        summary: '无法提取内容（可能需要登录或不支持该平台）',
        points: ['请尝试复制原文文字后重新分析'],
        verdict: 'skip',
        title: title || url,
        url,
        source
      });
    }

    // 2. DeepSeek AI 分析
    const analysis = await deepSeekAnalyze(title, text, source);

    return res.json({
      summary: analysis.summary,
      points: analysis.points,
      verdict: analysis.verdict,
      title: title || url,
      url,
      source
    });
  } catch (e) {
    console.error('Analyze error:', e);
    return res.status(500).json({ error: '分析失败: ' + (e.message || 'unknown') });
  }
}

// ============================================================================
// 内容抓取
// ============================================================================
async function fetchContent(url) {
  const u = new URL(url);
  const host = u.hostname.replace('www.', '');

  // B站
  if (host.includes('bilibili.com') && u.pathname.includes('/video/')) {
    return fetchBilibili(u);
  }
  // 知乎
  if (host.includes('zhihu.com')) {
    return fetchGeneric(url, 'zhihu');
  }
  // 公众号
  if (host.includes('mp.weixin.qq.com')) {
    return fetchGeneric(url, 'wechat');
  }
  // 小红书
  if (host.includes('xhslink.com') || host.includes('xiaohongshu.com')) {
    return fetchGeneric(url, 'xiaohongshu');
  }
  // 通用网页
  return fetchGeneric(url, 'web');
}

// B站抓取
async function fetchBilibili(u) {
  const bvid = u.pathname.split('/video/')[1]?.split(/[?\/]/)[0];
  if (!bvid) throw new Error('Invalid B站 URL');

  // 获取视频信息
  const infoRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: { 'User-Agent': 'SnipBot/1.0', 'Referer': 'https://www.bilibili.com' }
  });
  const info = await infoRes.json();
  const title = info?.data?.title || '';
  const desc = info?.data?.desc || '';

  // 获取字幕（如果存在）
  let subtitle = '';
  try {
    const cidRes = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {
      headers: { 'User-Agent': 'SnipBot/1.0', 'Referer': 'https://www.bilibili.com' }
    });
    const cidData = await cidRes.json();
    const cid = cidData?.data?.[0]?.cid;
    if (cid) {
      const subRes = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, {
        headers: { 'User-Agent': 'SnipBot/1.0', 'Referer': 'https://www.bilibili.com' }
      });
      const subData = await subRes.json();
      const subs = subData?.data?.subtitle?.subtitles;
      if (subs && subs.length > 0) {
        const subUrl = subs[0].subtitle_url;
        const subTextRes = await fetch(subUrl.startsWith('http') ? subUrl : 'https:' + subUrl);
        const subText = await subTextRes.json();
        subtitle = (subText?.body || []).map(s => s.content).join(' ');
      }
    }
  } catch (e) { /* 无字幕就算了 */ }

  const text = `标题: ${title}\n简介: ${desc}\n字幕内容: ${subtitle}`.slice(0, 6000);
  return { title, text, source: 'B站' };
}

// 通用网页抓取
async function fetchGeneric(url, source) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' }
  });
  const html = await res.text();

  // 简易提取：去标签 + 去空白 + 截断
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);

  // 提取标题
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim().slice(0, 200) : url;

  return { title, text, source };
}

// ============================================================================
// DeepSeek AI 分析
// ============================================================================
async function deepSeekAnalyze(title, text, source) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    // 没有 API Key → 返回简单摘要
    return {
      summary: title || '内容分析（需配置 DeepSeek API Key）',
      points: [text.slice(0, 200) + '...'],
      verdict: 'worth'
    };
  }

  const prompt = `分析以下${source}内容。返回JSON（不要markdown代码块，只返回纯JSON）：

{
  "summary": "一句话总结（20字以内）",
  "points": ["要点1", "要点2", "要点3"],
  "verdict": "worth" 或 "skip" 或 "ad"
}

verdict判断标准：
- worth: 有实质干货，值得保存
- skip: 标题党、内容空洞、信息量低
- ad: 主要是广告、推广、卖课

标题：${title}
内容：${text.slice(0, 4000)}`;

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个内容分析助手。只返回JSON，不要任何额外文字。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 500
    })
  });

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '{}';

  try {
    // 清理可能包裹的 markdown 代码块
    const clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const json = JSON.parse(clean);
    return {
      summary: json.summary || title,
      points: Array.isArray(json.points) ? json.points.slice(0, 5) : [text.slice(0, 100)],
      verdict: ['worth', 'skip', 'ad'].includes(json.verdict) ? json.verdict : 'worth'
    };
  } catch (e) {
    // JSON 解析失败 → 用原始返回
    return {
      summary: title,
      points: [raw.slice(0, 300)],
      verdict: 'worth'
    };
  }
}
