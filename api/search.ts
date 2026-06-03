import type { VercelRequest, VercelResponse } from '@vercel/node';

const BASE_ID = 'app0QFyInfhvk66MC';
const SYSTEM_TABLE = 'tblB1kWay9TvX3rGv';

function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  const keys = Object.keys(a);
  let dot = 0, normA = 0, normB = 0;
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function parseQueryToVector(query: string, openrouterKey: string): Promise<Record<string, number>> {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openrouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ulba.ai',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.1-8b-instruct',
      messages: [{
        role: 'user',
        content: `You are a beauty packaging emotion analyzer. Given a search query, output ONLY a JSON object with these 15 keys and float values 0.0-1.0 based on how strongly the query implies each dimension:
d01 (emotion/feeling), d02 (ritual/occasion), d03 (aesthetics/style), d04 (target group specificity), d05 (prestige/price level), d06a (feminine signal), d06b (masculine signal), d07 (brand archetype strength), d08 (sensory/haptic), d09 (sustainability values), d10 (product category fit), d11 (cultural reference), d12 (psychographic need), d13 (zeitgeist/trend), d14 (brand persona)

Query: "${query}"

Respond with ONLY valid JSON, no explanation. Example: {"d01":0.7,"d02":0.3,"d03":0.8,"d04":0.6,"d05":0.8,"d06a":0.1,"d06b":0.9,"d07":0.5,"d08":0.4,"d09":0.2,"d10":0.7,"d11":0.3,"d12":0.6,"d13":0.5,"d14":0.7}`
      }],
      max_tokens: 200,
      temperature: 0,
    }),
  });
  const data: any = await resp.json();
  const text = data?.choices?.[0]?.message?.content?.trim() ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'POST or GET only' });
  }

  const query = (req.method === 'POST' ? req.body?.query : req.query?.q) as string;
  if (!query || query.trim().length < 2) return res.status(400).json({ error: 'query required' });

  const limit = Math.min(parseInt((req.body?.limit ?? req.query?.limit ?? '12') as string) || 12, 24);

  const { OPENROUTER_API_KEY, AIRTABLE_PAT } = process.env;
  if (!OPENROUTER_API_KEY || !AIRTABLE_PAT) return res.status(500).json({ error: 'Missing env vars' });

  const airHeaders = { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' };

  try {
    // 1. Parse query → vector (parallel with fetching records)
    const [queryVector, recordsResp] = await Promise.all([
      parseQueryToVector(query.trim(), OPENROUTER_API_KEY),
      fetch(
        `https://api.airtable.com/v0/${BASE_ID}/${SYSTEM_TABLE}?filterByFormula=AND({Published}=TRUE(),{Cached_Vector}!='')&fields[]=System+ID&fields[]=Unternehmen&fields[]=Page+Titel&fields[]=Bild_Roh&fields[]=Vis_1_Pink_GenZ&fields[]=Vis_2_Forest_Natural&fields[]=Vis_3_White_Minimal&fields[]=Vis_4_Black_Tech&fields[]=Vis_5_Amber_Apothecary&fields[]=Vis_Status&fields[]=Cached_Vector&fields[]=Soft_Facts_Text&fields[]=Volumen&fields[]=Product_Family`,
        { headers: airHeaders }
      )
    ]);

    if (!recordsResp.ok) throw new Error(`Airtable fetch ${recordsResp.status}`);
    const recordsData: any = await recordsResp.json();
    const records = recordsData.records ?? [];

    // 2. Cosine similarity + rank
    const scored = records.map((r: any) => {
      let cachedVec: Record<string, number> = {};
      try { cachedVec = JSON.parse(r.fields?.Cached_Vector ?? '{}'); } catch {}
      const score = cosineSimilarity(queryVector, cachedVec);
      return { ...r, _score: score };
    });

    scored.sort((a: any, b: any) => b._score - a._score);
    const top = scored.slice(0, limit);

    // 3. Format response
    const results = top.map((r: any) => ({
      id: r.id,
      systemId: r.fields?.['System ID'],
      name: r.fields?.['Page Titel'],
      supplier: r.fields?.Unternehmen,
      volume: r.fields?.Volumen,
      softFacts: r.fields?.Soft_Facts_Text,
      productFamily: r.fields?.Product_Family,
      score: Math.round(r._score * 100) / 100,
      images: {
        raw: r.fields?.Bild_Roh?.[0]?.url ?? null,
        pink_genz: r.fields?.Vis_1_Pink_GenZ?.[0]?.url ?? null,
        forest_natural: r.fields?.Vis_2_Forest_Natural?.[0]?.url ?? null,
        white_minimal: r.fields?.Vis_3_White_Minimal?.[0]?.url ?? null,
        black_tech: r.fields?.Vis_4_Black_Tech?.[0]?.url ?? null,
        amber_apothecary: r.fields?.Vis_5_Amber_Apothecary?.[0]?.url ?? null,
      },
      visStatus: r.fields?.Vis_Status,
    }));

    return res.status(200).json({
      query,
      queryVector,
      total: results.length,
      results,
    });

  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
}
