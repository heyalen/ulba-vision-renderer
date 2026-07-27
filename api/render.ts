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

async function airtableListAll(table: string): Promise<any[]> {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}?pageSize=100`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } }
  );
  if (!res.ok) throw new Error(`Airtable list ${table}: ${res.status}`);
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

  if (bildSystem && capCount === 0) {
    return { fall: 'A', primaryUrl: bildSystem, hasMultipleCaps: false };
  }
  if (bildSystem && !bildRohBase && capCount > 0) {
    return { fall: 'B', primaryUrl: bildSystem, hasMultipleCaps: capCount > 1 };
  }
  if (bildRohBase && capCount === 1) {
    return { fall: 'C', primaryUrl: bildRohBase, hasMultipleCaps: false };
  }
  if (bildRohBase && capCount > 1) {
    return { fall: 'D', primaryUrl: bildRohBase, hasMultipleCaps: true };
  }
  if (bildRohBase && capCount === 0) {
    return { fall: 'A', primaryUrl: bildRohBase, hasMultipleCaps: false };
  }

  return { fall: 'A', primaryUrl: (bildSystem || bildRohBase)!, hasMultipleCaps: false };
}

// ── Field readers ───────────────────────────────────────────────────
function selectName(field: any): string {
  if (!field) return '';
  if (typeof field === 'string') return field;
  return field.name || '';
}

function multiSelectNames(field: any): string[] {
  if (!Array.isArray(field)) return [];
  return field.map((f: any) => typeof f === 'string' ? f : f.name || '').filter(Boolean);
}

function queryMatchesKeywords(query: string, keywordText: string | undefined): boolean {
  if (!keywordText) return false;
  const q = query.toLowerCase();
  const keywords = keywordText.split(/[,\n]/).map(k => k.trim().toLowerCase()).filter(Boolean);
  return keywords.some(k => q.includes(k));
}

// ── Gates: Material + Closure ───────────────────────────────────────
type LexEntry = { label: string; en: string; tokens: string[] };

const MATERIAL_LEXICON: LexEntry[] = [
  { label: 'Bambus',    en: 'bamboo',            tokens: ['bambus', 'bamboo'] },
  { label: 'Holz',      en: 'wood',              tokens: ['holz', 'wood', 'wooden', 'timber', 'oak', 'eiche'] },
  { label: 'Kork',      en: 'cork',              tokens: ['kork', 'cork'] },
  { label: 'Papier',    en: 'paper or cardboard',tokens: ['papier', 'paper', 'karton', 'cardboard', 'pappe'] },
  { label: 'Glas',      en: 'glass',             tokens: ['glas', 'glass'] },
  { label: 'Keramik',   en: 'ceramic',           tokens: ['keramik', 'ceramic', 'porzellan', 'porcelain'] },
  { label: 'Stein',     en: 'stone or marble',   tokens: ['stein', 'stone', 'marmor', 'marble', 'terrazzo'] },
  { label: 'Aluminium', en: 'aluminium',         tokens: ['aluminium', 'aluminum', 'alu'] },
  { label: 'Metall',    en: 'metal',             tokens: ['metall', 'metal'] },
  { label: 'Stahl',     en: 'steel',             tokens: ['stahl', 'steel'] },
  { label: 'Messing',   en: 'brass',             tokens: ['messing', 'brass'] },
  { label: 'Kupfer',    en: 'copper',            tokens: ['kupfer', 'copper'] },
  { label: 'Zamak',     en: 'zamak',             tokens: ['zamak'] },
  { label: 'PCR',       en: 'visible recycled material texture', tokens: ['pcr', 'rezyklat', 'recycled', 'ocean plastic'] },
  { label: 'Acryl',     en: 'acrylic',           tokens: ['acryl', 'acrylic', 'pmma', 'plexiglas'] },
  { label: 'Surlyn',    en: 'surlyn',            tokens: ['surlyn'] },
  { label: 'PETG',      en: 'petg',              tokens: ['petg'] },
  { label: 'PET',       en: 'pet',               tokens: ['pet'] },
  { label: 'HDPE',      en: 'hdpe',              tokens: ['hdpe'] },
  { label: 'PP',        en: 'polypropylene',     tokens: ['pp', 'polypropylen', 'polypropylene'] },
];

const CLOSURE_LEXICON: LexEntry[] = [
  { label: 'Pipette',   en: 'a dropper or pipette', tokens: ['pipette', 'dropper', 'tropfer'] },
  { label: 'Pumpe',     en: 'a pump',               tokens: ['pumpe', 'pump', 'lotion pump'] },
  { label: 'Spray',     en: 'a spray or atomizer',  tokens: ['spray', 'sprüh', 'spruh', 'atomizer', 'zerstäuber', 'zerstauber', 'mist'] },
  { label: 'Airless',   en: 'an airless dispenser', tokens: ['airless'] },
  { label: 'Disc Top',  en: 'a disc top',           tokens: ['disc top', 'disctop'] },
  { label: 'Flip Top',  en: 'a flip top',           tokens: ['flip top', 'fliptop', 'klappdeckel'] },
  { label: 'Roll-On',   en: 'a roll-on ball',       tokens: ['roll-on', 'rollon', 'roller', 'rollerball', 'kugel'] },
  { label: 'Schraubverschluss', en: 'a screw cap',  tokens: ['schraubverschluss', 'screw cap', 'twist off'] },
];

function tokenPresent(text: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-zäöüß])${esc}([^a-zäöüß]|$)`, 'i').test(text);
}

/** Findet Begriffe im Brief, die vom Record NICHT gedeckt sind. */
function runGate(brief: string, lexicon: LexEntry[], coverage: string[]): string[] {
  const text = ` ${brief.toLowerCase()} `;
  const cov = coverage.map(c => c.toLowerCase()).filter(Boolean);
  const forbidden: string[] = [];

  for (const entry of lexicon) {
    const mentioned = entry.tokens.some(t => tokenPresent(text, t));
    if (!mentioned) continue;
    const covered = cov.some(c =>
      c.includes(entry.label.toLowerCase()) || entry.label.toLowerCase().includes(c)
    );
    if (!covered) forbidden.push(entry.en);
  }
  return [...new Set(forbidden)];
}

/** Hard-Rule wird IMMER im Code angehängt — nie von Haiku geschrieben. */
function buildHardRule(fall: RenderFall, forbidden: string[]): string {
  const closureRule = fall === 'A'
    ? 'Do not add, remove, replace or restyle the closure — keep the closure exactly as shown in the reference image.'
    : 'Use ONLY the closure shown in image 2 — do not invent a different closure, do not change its shape or mechanism.';

  return [
    'CRITICAL RULES — these override everything above.',
    'Do not change the shape, silhouette, proportions or size of the packaging.',
    closureRule,
    'Do not introduce any material that is not visible in the reference images or explicitly listed as available.',
    forbidden.length ? `Explicitly forbidden in this render: ${forbidden.join(', ')}.` : '',
    'No text, no logos, no labels, no typography, no branding — the product must be completely blank.',
    'Studio product photography, clean white background, soft natural shadow, photorealistic.',
  ].filter(Boolean).join(' ');
}

// ── Prompt Assembly v3 ──────────────────────────────────────────────
async function assemblePrompt(
  brief: string,
  fall: RenderFall,
  sysFields: any,
  capFields: any | null
): Promise<{ prompt: string; forbidden: string[] }> {

  const [produktRegeln, designRegeln, farbpaletten] = await Promise.all([
    airtableListAll(PRODUKT_REGELN_TABLE),
    airtableListAll(DESIGN_REGELN_TABLE),
    airtableListAll(FARBPALETTEN_TABLE),
  ]);

  const matchedProdukt = produktRegeln.filter(r =>
    queryMatchesKeywords(brief, r.fields['Keywords'])
  );
  const matchedDesign = designRegeln.filter(r =>
    queryMatchesKeywords(brief, r.fields['Wenn_Query_Signal'])
  );

  const paletteIds = matchedDesign.flatMap(r => r.fields['Palette_Link'] || []);
  const matchedPaletten = farbpaletten.filter(p => paletteIds.includes(p.id));
  const activePaletten = matchedPaletten.length > 0
    ? matchedPaletten
    : farbpaletten.filter(p => queryMatchesKeywords(brief, multiSelectNames(p.fields['Emotion_Tags']).join(',')));

  // Produkt-Basics
  const type = selectName(sysFields['Type']);
  const material = multiSelectNames(sysFields['Material']);
  const form = multiSelectNames(sysFields['Form']).join(', ');
  const desc = sysFields['Kurzbeschreibung'] || '';
  const availMaterials = multiSelectNames(sysFields['Available_Materials']);

  // Closure-Ist-Zustand: System + verlinkter Cap
  const sysClosure = multiSelectNames(sysFields['Closure']).concat(selectName(sysFields['Closure']) || []);
  const capClosure = capFields
    ? multiSelectNames(capFields['Closure_Type']).concat(selectName(capFields['Closure_Type']) || [])
    : [];
  const closureCoverage = [...new Set([...sysClosure, ...capClosure].filter(Boolean))];

  // ── GATES ────────────────────────────────────────────────────────
  const materialCoverage = [...new Set([...availMaterials, ...material])];
  const forbiddenMaterials = runGate(brief, MATERIAL_LEXICON, materialCoverage);
  const forbiddenClosures = runGate(brief, CLOSURE_LEXICON, closureCoverage);
  const forbidden = [...forbiddenMaterials, ...forbiddenClosures];

  // Capabilities aus SF_-Feldern
  const capsList: string[] = [];
  if (sysFields['SF_Einfaerbbar']) capsList.push('Einfärbbar');
  if (sysFields['SF_Mattierbar']) capsList.push('Matt-Finish möglich');
  if (sysFields['SF_HotFoil']) capsList.push('Hot Foil möglich');
  if (sysFields['SF_Embossing']) capsList.push('Embossing möglich');
  if (sysFields['SF_Siebdruck']) capsList.push('Siebdruck möglich');
  if (sysFields['SF_PCR']) capsList.push('PCR-Material verfügbar');
  if (sysFields['SF_Refillable']) capsList.push('Refillable');
  if (sysFields['SF_Airless']) capsList.push('Airless-System');

  const notPossible: string[] = [];
  if (!sysFields['SF_Mattierbar']) notPossible.push('Kein Matt-Finish');
  if (!sysFields['SF_HotFoil']) notPossible.push('Kein Hot Foil');
  if (!sysFields['SF_Embossing']) notPossible.push('Kein Embossing');
  if (!sysFields['SF_Refillable']) notPossible.push('Nicht refillable — kein Refill-Visual');
  if (!sysFields['SF_Airless']) notPossible.push('Kein Airless-System');

  // ── Context ──────────────────────────────────────────────────────
  let context = `PRODUCT (fixed, not negotiable): ${type} | ${material.join(', ')} | ${form}\n${desc}\n`;
  if (closureCoverage.length > 0) {
    context += `CURRENT CLOSURE (fixed): ${closureCoverage.join(', ')}\n`;
  }

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

  if (capsList.length > 0) context += `\nCAPABILITIES: ${capsList.join(', ')}\n`;
  if (notPossible.length > 0) context += `CONSTRAINTS: ${notPossible.join(', ')} — do NOT render these.\n`;
  if (availMaterials.length > 0) context += `AVAILABLE MATERIALS (the only ones the supplier offers): ${availMaterials.join(', ')}\n`;
  if (forbidden.length > 0) {
    context += `\nREJECTED FROM BRIEF — the brief mentions these, but the product does not offer them.\n`;
    context += `Do NOT render, imply or hint at: ${forbidden.join(', ')}.\n`;
  }

  // ── Fall-Instruktionen ───────────────────────────────────────────
  let fallInstructions: string;
  if (fall === 'A') {
    fallInstructions = `SINGLE IMAGE edit. Change ONLY color, finish and surface material treatment — never shape, never the closure.
Start with: "Keep exact shape, form, proportions and closure unchanged."`;
  } else if (fall === 'B') {
    fallInstructions = `TWO REFERENCE IMAGES: image 1 = bottle WITH existing cap, image 2 = replacement cap.
MUST include: "REPLACE the original cap from image 1 with the cap from image 2 exactly as shown. Do NOT merge them, do NOT invent a new cap."
Describe color/finish for body and cap separately.`;
  } else {
    fallInstructions = `TWO REFERENCE IMAGES: image 1 = bottle body (base), image 2 = cap/closure.
Start with: "Compose a single product photo by combining the two reference images."
Body shape comes exactly from image 1. Cap shape and mechanism come exactly from image 2 — never invented.
Describe color/finish for body and cap separately.
Instruct to assemble the cap onto the bottle neck, flush and aligned.`;
  }

  const systemPrompt = `You are a beauty packaging rendering specialist.
You turn a brand brief into a precise Seedream image-editing prompt.

INPUT FILTERING — do this first, before writing anything:
The brief describes a MOOD and a BRAND, not the object. The object is already fixed
by the reference images and the product data below.
Extract from the brief ONLY: colors, finish (gloss, matt, frosted, metallic, soft-touch),
and decoration (embossing, hot foil, screen print).
DISCARD everything about: shape, form, silhouette, proportions, height, size, volume,
packaging type, closure type, dispensing mechanism, and material.
Example: "tall sustainable bamboo refill bottle in warm gold, matt" -> use only "warm gold, matt".
If the brief implies a material or closure that is not listed under AVAILABLE MATERIALS
or CURRENT CLOSURE, silently drop it. Never render it, never hint at it.

${fallInstructions}

NEVER change shapes. NEVER change or invent a closure. NEVER add text, logos, typography,
labels or branding — the product must be completely blank.
Reply ONLY with the prompt text. Max 100 words. English.
Do NOT write a closing rules block — it is appended automatically.

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
      messages: [{ role: 'user', content: brief }],
    }),
  });

  const data = await res.json() as { content: Array<{ text: string }> };
  const body = (data.content?.[0]?.text || '').trim();
  if (!body) throw new Error('Prompt-Assembly leer');

  return {
    prompt: `${body}\n\n${buildHardRule(fall, forbidden)}`,
    forbidden,
  };
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
    renderBrief = null,
    selectedCapId = null,
    tier = 'lite',
  } = req.body as {
    systemId: string;
    query: string;
    renderBrief?: string | null;
    selectedCapId?: string | null;
    tier?: Tier;
  };

  if (!systemId || !query) {
    return res.status(400).json({ error: 'systemId und query sind erforderlich' });
  }
  if (tier !== 'lite' && tier !== 'pro') {
    return res.status(400).json({ error: 'tier muss "lite" oder "pro" sein' });
  }

  // Rendering-Brief aus der Suche hat Vorrang; Query bleibt Demand-Signal.
  const effectiveBrief = (renderBrief && renderBrief.trim()) ? renderBrief.trim() : query;

  try {
    // ── 1. Cache Check ──────────────────────────────────────────────
    const key = cacheKey(systemId, effectiveBrief, selectedCapId, tier);
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
          briefUsed: effectiveBrief,
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
    let capFields: any | null = null;
    let resolvedCapId: string | null = selectedCapId;
    const linkedCaps = sys.fields['Caps'] as string[] | undefined;

    if (fall !== 'A' && linkedCaps && linkedCaps.length > 0) {
      const capId = selectedCapId || linkedCaps[0];
      resolvedCapId = capId;
      const capRec = await airtableFetch(CAP_TABLE, capId);
      capFields = capRec.fields;
      capImageUrl = imgUrl(capRec.fields['Cap_Bild']);
      if (!capImageUrl) throw new Error(`Cap ${capId} hat kein Bild`);
    }

    // ── 4. Assemble Rendering Prompt ────────────────────────────────
    const { prompt: renderingPrompt, forbidden } =
      await assemblePrompt(effectiveBrief, fall, sys.fields, capFields);

    // ── 5. Call Seedream via fal.ai ─────────────────────────────────
    const falEndpoint = FAL_ENDPOINTS[tier];
    const falBody: any = {
      prompt: renderingPrompt,
      output_format: 'jpeg',
    };

    if (fall === 'A' || !capImageUrl) {
      falBody.image_url = primaryUrl;
    } else {
      falBody.image_urls = [primaryUrl, capImageUrl];
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
            Query_Input: query,          // roh, nie sanitisiert — Demand-Signal
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
    }

    return res.status(200).json({
      renderingUrl,
      renderingPrompt,
      briefUsed: effectiveBrief,
      rejected: forbidden,
      capId: resolvedCapId,
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
