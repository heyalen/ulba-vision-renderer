import { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'crypto';

// ── Config ──────────────────────────────────────────────────────────
const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const SYSTEM_TABLE = 'tblB1kWay9TvX3rGv';
const CAP_TABLE = 'tblQvnXPhiKGMoqDp';
const CACHE_TABLE = 'tblsOp1WKPGIquBKQ';
const CACHE_IMAGE_FIELD = 'fldFd5qi64yELhKna';
const PRODUKT_REGELN_TABLE = 'tblrL5tEpvvUh6OEj';
const DESIGN_REGELN_TABLE = 'tblEVWQUJtf87JgOc';
const FARBPALETTEN_TABLE = 'tblTIeUTyVptGIpKp';

const FAL_ENDPOINTS = {
  lite: 'https://fal.run/fal-ai/bytedance/seedream/v5/lite/edit',
  pro: 'https://fal.run/fal-ai/bytedance/seedream/v5/pro/edit',
} as const;

type Tier = 'lite' | 'pro';
type RenderFall = 'A' | 'B' | 'C' | 'D';

// ── Helpers ─────────────────────────────────────────────────────────
function queryHash(q: string): string {
  return createHash('md5').update(q.toLowerCase().trim()).digest('hex').slice(0, 12);
}

function cacheKey(systemId: string, q: string, capId: string | null, tier: Tier): string {
  return `${systemId}_${queryHash(q)}_${capId || 'none'}_${tier}`;
}

function imgUrl(attachmentField: any): string | null {
  if (Array.isArray(attachmentField) && attachmentField.length > 0) {
    return attachmentField[0].url || attachmentField[0].thumbnails?.full?.url || null;
  }
  return null;
}

async function airtableFetch(table: string, recordId: string): Promise<any> {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}/${recordId}`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } }
  );
  if (!res.ok) throw new Error(`Airtable ${table}/${recordId}: ${res.status}`);
  return res.json();
}

async function airtableQuery(table: string, formula: string, fields: string[], maxRecords = 1): Promise<any[]> {
  const params = new URLSearchParams({
    filterByFormula: formula,
    maxRecords: String(maxRecords),
  });
  fields.forEach(f => params.append('fields[]', f));
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}?${params}`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } }
  );
  if (!res.ok) throw new Error(`Airtable query ${table}: ${res.status}`);
  const data = await res.json();
  return data.records || [];
}

// ── Determine Rendering Fall ────────────────────────────────────────
function determineFall(sys: any): { fall: RenderFall; primaryUrl: string; hasMultipleCaps: boolean } {
  const bildRohBase = imgUrl(sys.fields['Bild_Roh_Base']);
  const bildSystem = imgUrl(sys.fields['Bild_System']);
  const caps = sys.fields['Caps'] as any[] | undefined;
  const capCount = caps?.length || 0;

  if (!bildRohBase && !bildSystem) throw new Error('Kein Bild vorhanden');

  // Fall A: Nur Bild_System, keine separaten Caps
  if (bildSystem && capCount === 0) {
    return { fall: 'A', primaryUrl: bildSystem, hasMultipleCaps: false };
  }
  // Fall B: Bild_System vorhanden + separate Caps (Cap muss ERSETZT werden)
  if (bildSystem && !bildRohBase && capCount > 0) {
    return { fall: 'B', primaryUrl: bildSystem, hasMultipleCaps: capCount > 1 };
  }
  // Fall C: Bild_Roh_Base + genau 1 Cap
  if (bildRohBase && capCount === 1) {
    return { fall: 'C', primaryUrl: bildRohBase, hasMultipleCaps: false };
  }
  // Fall D: Bild_Roh_Base + Multiple Caps
  if (bildRohBase && capCount > 1) {
    return { fall: 'D', primaryUrl: bildRohBase, hasMultipleCaps: true };
  }
  // Fallback: Bild_Roh_Base ohne Caps (behandeln wie Fall A)
  if (bildRohBase && capCount === 0) {
    return { fall: 'A', primaryUrl: bildRohBase, hasMultipleCaps: false };
  }

  return { fall: 'A', primaryUrl: (bildSystem || bildRohBase)!, hasMultipleCaps: false };
}

// ── Airtable List All (for small tables) ────────────────────────────
async function airtableListAll(table: string): Promise<any[]> {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}?pageSize=100`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } }
  );
  if (!res.ok) throw new Error(`Airtable list ${table}: ${res.status}`);
  const data = await res.json();
  return data.records || [];
}

// ── Keyword Matching ────────────────────────────────────────────────
function queryMatchesKeywords(query: string, keywordText: string | undefined): boolean {
  if (!keywordText) return false;
  const q = query.toLowerCase();
  const keywords = keywordText.split(/[,\n]/).map(k => k.trim().toLowerCase()).filter(Boolean);
  return keywords.some(k => q.includes(k));
}

function selectName(field: any): string {
  if (!field) return '';
  if (typeof field === 'string') return field;
  return field.name || '';
}

function multiSelectNames(field: any): string[] {
  if (!Array.isArray(field)) return [];
  return field.map((f: any) => typeof f === 'string' ? f : f.name || '').filter(Boolean);
}

// ── Prompt Assembly v2 via Claude Haiku ─────────────────────────────
async function assemblePrompt(query: string, fall: RenderFall, sysFields: any): Promise<string> {
  // 1. Load context tables in parallel
  const [produktRegeln, designRegeln, farbpaletten] = await Promise.all([
    airtableListAll(PRODUKT_REGELN_TABLE),
    airtableListAll(DESIGN_REGELN_TABLE),
    airtableListAll(FARBPALETTEN_TABLE),
  ]);

  // 2. Match Produkt_Regeln (keyword match)
  const matchedProdukt = produktRegeln.filter(r =>
    queryMatchesKeywords(query, r.fields['Keywords'])
  );

  // 3. Match Design_Regeln (query signal match)
  const matchedDesign = designRegeln.filter(r =>
    queryMatchesKeywords(query, r.fields['Wenn_Query_Signal'])
  );

  // 4. Resolve Farbpaletten from matched Design_Regeln
  const paletteIds = matchedDesign.flatMap(r => r.fields['Palette_Link'] || []);
  const matchedPaletten = farbpaletten.filter(p => paletteIds.includes(p.id));
  // Fallback: if no palette matched via rules, check all palettes for emotion match
  const activePaletten = matchedPaletten.length > 0
    ? matchedPaletten
    : farbpaletten.filter(p => queryMatchesKeywords(query, multiSelectNames(p.fields['Emotion_Tags']).join(',')));

  // 5. Product basics
  const type = selectName(sysFields['Type']);
  const material = multiSelectNames(sysFields['Material']).join(', ');
  const form = multiSelectNames(sysFields['Form']).join(', ');
  const desc = sysFields['Kurzbeschreibung'] || '';
  const availMaterials = multiSelectNames(sysFields['Available_Materials']);

  // 6. Capabilities from SF_ fields
  const caps: string[] = [];
  if (sysFields['SF_Einfaerbbar']) caps.push('Einfärbbar');
  if (sysFields['SF_Mattierbar']) caps.push('Matt-Finish möglich');
  if (sysFields['SF_HotFoil']) caps.push('Hot Foil möglich');
  if (sysFields['SF_Embossing']) caps.push('Embossing möglich');
  if (sysFields['SF_Siebdruck']) caps.push('Siebdruck möglich');
  if (sysFields['SF_PCR']) caps.push('PCR-Material verfügbar');
  if (sysFields['SF_Refillable']) caps.push('Refillable');
  if (sysFields['SF_Airless']) caps.push('Airless-System');
  const notPossible: string[] = [];
  if (!sysFields['SF_Mattierbar']) notPossible.push('Kein Matt-Finish');
  if (!sysFields['SF_HotFoil']) notPossible.push('Kein Hot Foil');
  if (!sysFields['SF_Embossing']) notPossible.push('Kein Embossing');

  // 7. Build context blocks
  let context = `PRODUCT: ${type} | ${material} | ${form}\n${desc}\n`;

  if (matchedProdukt.length > 0) {
    const pr = matchedProdukt[0].fields;
    context += `\nCATEGORY RULES (${pr['Kategorie'] || 'matched'}):\n`;
    if (pr['Bevorzugt_Material']) context += `- Preferred materials: ${pr['Bevorzugt_Material']}\n`;
    if (pr['Nicht_Material']) context += `- Avoid materials: ${pr['Nicht_Material']}\n`;
    if (pr['Bevorzugt_Closure']) context += `- Preferred closure: ${pr['Bevorzugt_Closure']}\n`;
  }

  if (matchedDesign.length > 0) {
    context += `\nDESIGN RULES:\n`;
    for (const dr of matchedDesign) {
      const f = dr.fields;
      if (f['Dann_Design_Codes']) context += `- Design codes: ${f['Dann_Design_Codes']}\n`;
      if (f['Nie']) context += `- NEVER: ${f['Nie']}\n`;
      if (f['Kanal_Signal']) context += `- Channel signal: ${f['Kanal_Signal']}\n`;
    }
  }

  if (activePaletten.length > 0) {
    const pal = activePaletten[0].fields;
    context += `\nCOLOR PALETTE "${pal['Name'] || ''}":\n`;
    if (pal['Hex_Codes']) context += `- Hex codes: ${pal['Hex_Codes']}\n`;
    if (pal['Beschreibung']) context += `- ${pal['Beschreibung']}\n`;
    context += `- USE THESE EXACT HEX CODES, do not invent colors.\n`;
  }

  if (caps.length > 0) context += `\nCAPABILITIES: ${caps.join(', ')}\n`;
  if (notPossible.length > 0) context += `CONSTRAINTS: ${notPossible.join(', ')} — do NOT suggest these.\n`;
  if (availMaterials.length > 0) context += `AVAILABLE MATERIALS: ${availMaterials.join(', ')} — only use these.\n`;

  // 8. Fall-specific instructions
  let fallInstructions: string;
  if (fall === 'A') {
    fallInstructions = `SINGLE IMAGE edit. Change ONLY color, finish, material — NEVER shape.
Start with: "Keep exact shape, form, and proportions unchanged."`;
  } else if (fall === 'B') {
    fallInstructions = `TWO REFERENCE IMAGES: image 1 = bottle WITH existing cap, image 2 = replacement cap.
MUST include: "REPLACE the original cap from image 1 with the cap from image 2. Do NOT merge them."
Describe color/material/finish for BOTH body and cap separately.`;
  } else {
    fallInstructions = `TWO REFERENCE IMAGES: image 1 = bottle body (base), image 2 = cap/closure.
Start with: "Compose a single product photo by combining the two reference images."
Use exact shape from image 1 for body, exact shape from image 2 for cap.
Describe color/material/finish for BOTH body and cap separately.
Instruct to assemble cap onto bottle neck, flush and aligned.`;
  }

  const systemPrompt = `You are a beauty packaging rendering specialist.
Given a brand brief and detailed context, write a precise Seedream image-editing prompt.

${fallInstructions}

NEVER change shapes — only colors, materials, finishes.
Reply ONLY with the prompt text. Max 120 words. English.
End with: "Studio product photography, clean white background, soft natural shadow, photorealistic. CRITICAL: Do not change shapes."

${context}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: query }],
    }),
  });

  const data = await res.json() as { content: Array<{ text: string }> };
  return data.content[0].text.trim();
}

// ── Main Handler ────────────────────────────────────────────────────
export const config = { api: { bodyParser: true } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    systemId,
    query,
    selectedCapId = null,
    tier = 'lite',
  } = req.body as {
    systemId: string;
    query: string;
    selectedCapId?: string | null;
    tier?: Tier;
  };

  if (!systemId || !query) {
    return res.status(400).json({ error: 'systemId und query sind erforderlich' });
  }
  if (tier !== 'lite' && tier !== 'pro') {
    return res.status(400).json({ error: 'tier muss "lite" oder "pro" sein' });
  }

  try {
    // ── 1. Cache Check ──────────────────────────────────────────────
    const key = cacheKey(systemId, query, selectedCapId, tier);
    const cached = await airtableQuery(
      CACHE_TABLE,
      `{Cache_Key}='${key}'`,
      ['Cache_Key', 'Bild', 'Rendering_Prompt'],
      1
    );

    if (cached.length > 0) {
      const cachedImg = imgUrl(cached[0].fields['Bild']);
      if (cachedImg) {
        return res.status(200).json({
          renderingUrl: cachedImg,
          renderingPrompt: cached[0].fields['Rendering_Prompt'] || '',
          cacheId: cached[0].id,
          cached: true,
        });
      }
    }

    // ── 2. Fetch System Record ──────────────────────────────────────
    const sys = await airtableFetch(SYSTEM_TABLE, systemId);

    const { fall, primaryUrl } = determineFall(sys);

    // ── 3. Resolve Cap ──────────────────────────────────────────────
    let capImageUrl: string | null = null;
    let resolvedCapId: string | null = selectedCapId;
    const linkedCaps = sys.fields['Caps'] as string[] | undefined;

    if (fall !== 'A' && linkedCaps && linkedCaps.length > 0) {
      // Airtable returns linked records as string array of record IDs
      const capId = selectedCapId || linkedCaps[0];
      resolvedCapId = capId;
      const capRec = await airtableFetch(CAP_TABLE, capId);
      capImageUrl = imgUrl(capRec.fields['Cap_Bild']);
      if (!capImageUrl) throw new Error(`Cap ${capId} hat kein Bild`);
    }

    // ── 4. Assemble Rendering Prompt ────────────────────────────────
    const renderingPrompt = await assemblePrompt(query, fall, sys.fields);

    // ── 5. Call Seedream via fal.ai ─────────────────────────────────
    const falEndpoint = FAL_ENDPOINTS[tier];
    const falBody: any = {
      prompt: renderingPrompt,
      output_format: 'jpeg',
    };

    if (fall === 'A') {
      // Single image edit
      falBody.image_url = primaryUrl;
    } else {
      // Multi-reference compositing (Fall B/C/D)
      falBody.image_urls = capImageUrl ? [primaryUrl, capImageUrl] : [primaryUrl];
    }

    const falRes = await fetch(falEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Key ${process.env.FAL_API_KEY}`,
      },
      body: JSON.stringify(falBody),
    });

    if (!falRes.ok) {
      const err = await falRes.text();
      throw new Error(`fal.ai ${tier}: ${err}`);
    }

    const falData = await falRes.json() as { images?: Array<{ url: string }>; image?: { url: string } };
    const renderingUrl = falData.images?.[0]?.url || falData.image?.url;
    if (!renderingUrl) throw new Error('Kein Bild von Seedream zurückgekommen');

    // ── 6. Download + Cache in Airtable ─────────────────────────────
    const imgRes = await fetch(renderingUrl);
    const imgBuffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(imgBuffer).toString('base64');

    // Create cache record
    const createRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.AIRTABLE_PAT}`,
        },
        body: JSON.stringify({
          fields: {
            Cache_Key: key,
            System: [systemId],
            Query_Input: query,
            Rendering_Prompt: renderingPrompt,
            Tier: tier,
            Fall: fall,
            Created_At: new Date().toISOString(),
          },
        }),
      }
    );
    const createData = await createRes.json() as { id: string; error?: any };
    if (!createData.id) throw new Error(`Cache-Record Fehler: ${JSON.stringify(createData)}`);

    // Upload rendered image
    const uploadRes = await fetch(
      `https://content.airtable.com/v0/${AIRTABLE_BASE}/${createData.id}/${CACHE_IMAGE_FIELD}/uploadAttachment`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.AIRTABLE_PAT}`,
        },
        body: JSON.stringify({
          contentType: 'image/jpeg',
          file: base64,
          filename: `render_${sys.fields['Page Titel'] || systemId}_${tier}_${Date.now()}.jpg`,
        }),
      }
    );
    if (!uploadRes.ok) {
      console.error('Airtable upload failed:', await uploadRes.text());
      // Non-fatal — rendering still succeeded
    }

    return res.status(200).json({
      renderingUrl,
      renderingPrompt,
      cacheId: createData.id,
      cached: false,
      fall,
      tier,
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
    console.error('Render error:', message);
    return res.status(500).json({ error: message });
  }
}
