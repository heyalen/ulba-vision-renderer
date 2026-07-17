import { VercelRequest, VercelResponse } from '@vercel/node';

// ── Config ──────────────────────────────────────────────────────────
const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const SYSTEM_TABLE = 'tblB1kWay9TvX3rGv';
const PRODUKT_REGELN_TABLE = 'tblrL5tEpvvUh6OEj';

export const config = { api: { bodyParser: true } };

// ── Helpers ─────────────────────────────────────────────────────────
function selectName(field: any): string {
  if (!field) return '';
  if (typeof field === 'string') return field;
  return field.name || '';
}

function multiSelectNames(field: any): string[] {
  if (!Array.isArray(field)) return [];
  return field.map((f: any) => typeof f === 'string' ? f : f.name || '').filter(Boolean);
}

function imgUrl(attachmentField: any): string | null {
  if (Array.isArray(attachmentField) && attachmentField.length > 0) {
    return attachmentField[0].url || attachmentField[0].thumbnails?.full?.url || null;
  }
  return null;
}

async function airtableListAll(table: string, formula?: string): Promise<any[]> {
  const params = new URLSearchParams({ pageSize: '100' });
  if (formula) params.set('filterByFormula', formula);
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}?${params}`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } }
  );
  if (!res.ok) throw new Error(`Airtable list ${table}: ${res.status}`);
  const data = await res.json();
  return data.records || [];
}

// ── Query Parsing ───────────────────────────────────────────────────
interface ParsedQuery {
  raw: string;
  sizeMentions: string[];       // e.g. ["50ml", "100ml"]
  materialMentions: string[];   // e.g. ["Glass"]
  typeMentions: string[];       // e.g. ["Bottle"]
  closureMentions: string[];    // e.g. ["Pump"]
}

function parseQuery(query: string): ParsedQuery {
  const q = query.toLowerCase();

  // Size: extract patterns like "50ml", "100 ml", "250ML"
  const sizeMatches = query.match(/\d+\s*ml/gi) || [];
  const sizeMentions = sizeMatches.map(s => s.replace(/\s/g, '').toLowerCase());

  // Material keywords → Airtable option names
  const materialMap: Record<string, string> = {
    'glass': 'Glas', 'glas': 'Glas', 'gläser': 'Glas',
    'plastic': 'Kunststoff', 'kunststoff': 'Kunststoff',
    'pp': 'PP', 'hdpe': 'HDPE', 'pet': 'PET', 'petg': 'PETG',
    'aluminium': 'Aluminium', 'aluminum': 'Aluminium', 'alu': 'Aluminium',
    'pcr': 'Glas PCR',
  };
  const materialMentions = Object.entries(materialMap)
    .filter(([kw]) => q.includes(kw))
    .map(([, val]) => val)
    .filter((v, i, a) => a.indexOf(v) === i);

  // Type keywords
  const typeMap: Record<string, string> = {
    'bottle': 'Bottle', 'flasche': 'Bottle', 'flaschen': 'Bottle',
    'jar': 'Jar', 'tiegel': 'Jar', 'dose': 'Jar',
    'tube': 'Tube', 'tuben': 'Tube',
    'airless': 'Airless',
  };
  const typeMentions = Object.entries(typeMap)
    .filter(([kw]) => q.includes(kw))
    .map(([, val]) => val)
    .filter((v, i, a) => a.indexOf(v) === i);

  // Closure keywords
  const closureMap: Record<string, string> = {
    'pump': 'Pump', 'pumpe': 'Pump',
    'spray': 'Spray', 'sprüh': 'Spray',
    'dropper': 'Dropper', 'pipette': 'Dropper', 'tropfer': 'Dropper',
    'flip': 'Flip Top', 'flip-top': 'Flip Top',
    'screw': 'Screw Cap', 'schraub': 'Screw Cap',
    'disc': 'Disc Top', 'disc-top': 'Disc Top',
  };
  const closureMentions = Object.entries(closureMap)
    .filter(([kw]) => q.includes(kw))
    .map(([, val]) => val)
    .filter((v, i, a) => a.indexOf(v) === i);

  return { raw: query, sizeMentions, materialMentions, typeMentions, closureMentions };
}

// ── Produkt_Regeln Matching ─────────────────────────────────────────
interface CategoryConstraints {
  category: string;
  bevorzugtMaterial: string[];
  nichtMaterial: string[];
  bevorzugtClosure: string[];
  nichtClosure: string[];
  bevorzugtType: string[];
  nichtType: string[];
  volumeMin: number | null;
  volumeMax: number | null;
}

function matchCategory(query: string, regeln: any[]): CategoryConstraints | null {
  const q = query.toLowerCase();
  for (const r of regeln) {
    const keywords = (r.fields['Keywords'] || '').split(/[,\n]/).map((k: string) => k.trim().toLowerCase()).filter(Boolean);
    if (keywords.some((k: string) => q.includes(k))) {
      const f = r.fields;
      const split = (text: string | undefined) => text ? text.split(/[,\n]/).map(s => s.trim()).filter(Boolean) : [];
      return {
        category: f['Kategorie'] || '',
        bevorzugtMaterial: split(f['Bevorzugt_Material']),
        nichtMaterial: split(f['Nicht_Material']),
        bevorzugtClosure: split(f['Bevorzugt_Closure']),
        nichtClosure: split(f['Nicht_Closure']),
        bevorzugtType: split(f['Bevorzugt_Type']),
        nichtType: split(f['Nicht_Typen']),
        volumeMin: f['Volume_Min'] ?? null,
        volumeMax: f['Volume_Max'] ?? null,
      };
    }
  }
  return null;
}

// ── Hard Filter ─────────────────────────────────────────────────────
interface ProductData {
  id: string;
  name: string;
  type: string;
  material: string[];
  form: string[];
  closure: string;
  description: string;
  imageUrl: string | null;
  capabilities: string[];
  availableSizes: string[];
  availableMaterials: string[];
  capCount: number;
}

function extractProduct(rec: any): ProductData {
  const f = rec.fields;
  const caps: string[] = [];
  if (f['SF_Einfaerbbar']) caps.push('Einfärbbar');
  if (f['SF_Mattierbar']) caps.push('Mattierbar');
  if (f['SF_HotFoil']) caps.push('Hot Foil');
  if (f['SF_Embossing']) caps.push('Embossing');
  if (f['SF_Siebdruck']) caps.push('Siebdruck');
  if (f['SF_PCR']) caps.push('PCR');
  if (f['SF_Refillable']) caps.push('Refillable');
  if (f['SF_Airless']) caps.push('Airless');

  return {
    id: rec.id,
    name: f['Page Titel'] || f['System ID'] || rec.id,
    type: selectName(f['Type']),
    material: multiSelectNames(f['Material']),
    form: multiSelectNames(f['Form']),
    closure: selectName(f['Closure']),
    description: f['Kurzbeschreibung'] || '',
    imageUrl: imgUrl(f['Bild_Harmonisiert']),
    capabilities: caps,
    availableSizes: multiSelectNames(f['Available_Sizes']),
    availableMaterials: multiSelectNames(f['Available_Materials']),
    capCount: (f['Caps'] as string[] || []).length,
  };
}

function hardFilter(
  products: ProductData[],
  parsed: ParsedQuery,
  category: CategoryConstraints | null
): ProductData[] {
  return products.filter(p => {
    // User-explicit material filter
    if (parsed.materialMentions.length > 0) {
      const hasMatch = parsed.materialMentions.some(m =>
        p.material.some(pm => pm.toLowerCase().includes(m.toLowerCase())) ||
        p.availableMaterials.some(am => am.toLowerCase().includes(m.toLowerCase()))
      );
      if (!hasMatch) return false;
    }

    // User-explicit type filter
    if (parsed.typeMentions.length > 0) {
      if (!parsed.typeMentions.some(t => p.type.toLowerCase().includes(t.toLowerCase()))) return false;
    }

    // User-explicit closure filter
    if (parsed.closureMentions.length > 0) {
      if (!parsed.closureMentions.some(c => p.closure.toLowerCase().includes(c.toLowerCase()))) return false;
    }

    // User-explicit size filter
    if (parsed.sizeMentions.length > 0) {
      if (p.availableSizes.length > 0) {
        const hasSize = parsed.sizeMentions.some(s =>
          p.availableSizes.some(as => as.toLowerCase().includes(s))
        );
        if (!hasSize) return false;
      }
      // If product has no size data, don't exclude (data gap)
    }

    // Category constraints from Produkt_Regeln
    if (category) {
      // Exclude forbidden materials
      if (category.nichtMaterial.length > 0) {
        const forbidden = category.nichtMaterial.some(nm =>
          p.material.some(pm => pm.toLowerCase().includes(nm.toLowerCase()))
        );
        if (forbidden) return false;
      }

      // Exclude forbidden closures
      if (category.nichtClosure.length > 0) {
        const forbidden = category.nichtClosure.some(nc =>
          p.closure.toLowerCase().includes(nc.toLowerCase())
        );
        if (forbidden) return false;
      }

      // Exclude forbidden types
      if (category.nichtType.length > 0) {
        const forbidden = category.nichtType.some(nt =>
          p.type.toLowerCase().includes(nt.toLowerCase())
        );
        if (forbidden) return false;
      }

      // Volume range check from Produkt_Regeln
      if ((category.volumeMin !== null || category.volumeMax !== null) && p.availableSizes.length > 0) {
        // Parse ml values from Available_Sizes (e.g. "50ml" → 50)
        const productMls = p.availableSizes
          .map(s => parseInt(s.replace(/[^0-9]/g, ''), 10))
          .filter(n => !isNaN(n));

        if (productMls.length > 0) {
          // Product must have at least one size within the allowed range
          const hasValidSize = productMls.some(ml => {
            if (category.volumeMin !== null && ml < category.volumeMin) return false;
            if (category.volumeMax !== null && ml > category.volumeMax) return false;
            return true;
          });
          if (!hasValidSize) return false;
        }
        // If no parseable sizes, don't exclude (data gap)
      }
    }

    return true;
  });
}

// ── Claude Ranking ──────────────────────────────────────────────────
interface RankedProduct extends ProductData {
  score: number;
  reasoning: string;
}

async function claudeRank(
  query: string,
  products: ProductData[],
  category: CategoryConstraints | null
): Promise<RankedProduct[]> {
  if (products.length === 0) return [];

  const productList = products.map((p, i) => 
    `[${i}] ${p.name} | Type: ${p.type} | Material: ${p.material.join(',')} | Form: ${p.form.join(',')} | Closure: ${p.closure} | Capabilities: ${p.capabilities.join(',')} | Sizes: ${p.availableSizes.join(',')} | ${p.description}`
  ).join('\n');

  let categoryContext = '';
  if (category) {
    categoryContext = `\nCategory "${category.category}" matched. Preferred materials: ${category.bevorzugtMaterial.join(', ')}. Preferred closure: ${category.bevorzugtClosure.join(', ')}. Preferred type: ${category.bevorzugtType.join(', ')}.`;
  }

  const systemPrompt = `You are a beauty packaging sourcing expert. 
A brand searches for packaging with this query. Rank how well each product fits the query emotionally and functionally.
Consider: brand vibe, target audience, product category fit, material appropriateness, form language.
Products that match category preferences (preferred material, closure, type) should score higher.
${categoryContext}

Respond ONLY with a JSON array, no other text. Format:
[{"index":0,"score":85,"reasoning":"Brief reason"},{"index":1,"score":42,"reasoning":"Brief reason"}]

Score 0-100. Be decisive — spread scores widely. Best fit near 90+, poor fit below 30.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Query: "${query}"\n\nProducts:\n${productList}` }],
    }),
  });

  const data = await res.json() as { content: Array<{ text: string }> };
  const text = data.content[0].text.trim();

  try {
    const cleaned = text.replace(/```json\s?|```/g, '').trim();
    const rankings = JSON.parse(cleaned) as Array<{ index: number; score: number; reasoning: string }>;

    return rankings
      .map(r => ({
        ...products[r.index],
        score: r.score,
        reasoning: r.reasoning,
      }))
      .filter(r => r.id) // safety: skip invalid indices
      .sort((a, b) => b.score - a.score);
  } catch (e) {
    // Fallback: return all products unranked
    return products.map(p => ({ ...p, score: 50, reasoning: 'Ranking unavailable' }));
  }
}

// ── Main Handler ────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body as { query: string };
  if (!query) return res.status(400).json({ error: 'query ist erforderlich' });

  if (!process.env.AIRTABLE_PAT) return res.status(500).json({ error: 'AIRTABLE_PAT env var fehlt' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY env var fehlt' });

  try {
    // 1. Load products + rules in parallel
    const [allProducts, produktRegeln] = await Promise.all([
      airtableListAll(SYSTEM_TABLE, '{Published}=TRUE()'),
      airtableListAll(PRODUKT_REGELN_TABLE),
    ]);

    // 2. Parse query
    const parsed = parseQuery(query);

    // 3. Match category
    const category = matchCategory(query, produktRegeln);

    // 4. Extract product data
    const products = allProducts.map(extractProduct);

    // 5. Hard filter
    const filtered = hardFilter(products, parsed, category);

    // 6. Claude ranking
    const ranked = await claudeRank(query, filtered, category);

    return res.status(200).json({
      results: ranked,
      query: query,
      totalProducts: products.length,
      afterFilter: filtered.length,
      categoryMatch: category?.category || null,
      parsedFilters: {
        sizes: parsed.sizeMentions,
        materials: parsed.materialMentions,
        types: parsed.typeMentions,
        closures: parsed.closureMentions,
      },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
    console.error('Search error:', message);
    return res.status(500).json({ error: message });
  }
}
