import { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'crypto';
import sharp from 'sharp';

// ── Config ──────────────────────────────────────────────────────────
const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const SYSTEM_TABLE = 'tblB1kWay9TvX3rGv';
const CAP_TABLE = 'tblQvnXPhiKGMoqDp';
const CACHE_TABLE = 'tblsOp1WKPGIquBKQ';
const CACHE_IMAGE_FIELD = 'fldFd5qi64yELhKna';
const PRODUKT_REGELN_TABLE = 'tblrL5tEpvvUh6OEj';
const DESIGN_REGELN_TABLE = 'tblEVWQUJtf87JgOc';
const FARBPALETTEN_TABLE = 'tblTIeUTyVptGIpKp';

// Positionierungs-Welten. Harter Gate für Palettenwahl. Identisch zu
// Farbpaletten.Segment / Stil.Segment in Airtable.
const SEGMENTS = ['Klinisch_Derma', 'GenZ_DTC', 'Quiet_Luxury', 'Clean_Botanical'] as const;

// Ein Modell für alles: Gemini 2.5 Flash Image (Nano Banana) via fal.ai.
// Kann Einzelbild-Recolor (Fall A) UND Multi-Image-Komposition (B/C/D), $0.039/Bild, kein Tier.
const FAL_GEMINI_EDIT = 'https://fal.run/fal-ai/gemini-25-flash-image/edit';

type Tier = 'lite' | 'pro';
type RenderFall = 'A' | 'B' | 'C' | 'D';

// ── Deterministisches Cap-Compositing (sharp) ───────────────────────
// Der Cap SCHWEBT über der Base — kein Aufsetzen (Hals-Innengeometrie unbekannt),
// keine erfundene Passung, echte Proportionen: Cap-Kragen wird auf Base-Hals
// skaliert (in Wirklichkeit gleicher Durchmesser → Proportion by construction).
// Base bleibt voll sichtbar. Beide sind "behaltene Pixel" → Gemini färbt nur um.
// Getestet in Sandbox (Pixel-Asserts: Hals/Kragen-Messung, Schwebe-Lücke, Proportion).
// Freistellen v1 = Weiß-Schwelle (Katalog-Caps auf Weiß); robuster: birefnet vorschalten.
async function fetchBuffer(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Bild-Fetch ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = String(hex || '').replace('#', '').trim();
  if (h.length < 6) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

// Cap deterministisch in Palette einfärben: RGB × Palette (weiß→Palette, Schatten
// bleiben proportional). Form + Highlights + Transparenz bleiben pixel-exakt.
// Getestet. sharp.tint() geht NICHT (bewahrt Luminanz → weiß bleibt weiß).
async function recolorCap(capBuf: Buffer, hex: string): Promise<Buffer> {
  const rgb = hexToRgb(hex);
  if (!rgb) return capBuf;
  const { data, info } = await sharp(capBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] > 0) {
      data[i] = Math.round(data[i] * rgb.r / 255);
      data[i + 1] = Math.round(data[i + 1] * rgb.g / 255);
      data[i + 2] = Math.round(data[i + 2] * rgb.b / 255);
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}

// Ein Gemini-Edit-Aufruf (fal.ai) → Bild-URL.
async function geminiEdit(imageUrls: string[], prompt: string): Promise<string> {
  const r = await fetch(FAL_GEMINI_EDIT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${process.env.FAL_API_KEY}` },
    body: JSON.stringify({ prompt, image_urls: imageUrls, aspect_ratio: 'auto' }),
  });
  if (!r.ok) throw new Error(`fal.ai gemini-edit: ${await r.text()}`);
  const d = await r.json() as { images?: Array<{ url: string }> };
  const url = d.images?.[0]?.url;
  if (!url) throw new Error('Kein Bild von Gemini zurückgekommen');
  return url;
}

async function whiteToAlpha(buffer: Buffer, threshold = 245): Promise<Buffer> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold) data[i + 3] = 0;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}

type Extent = { w: number; h: number; minX: number; maxX: number; minY: number; maxY: number; rowMinX: Int32Array; rowMaxX: Int32Array };

async function contentExtent(buffer: Buffer, whiteThresh = 245): Promise<Extent> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, c = info.channels;
  const rowMinX = new Int32Array(h).fill(w);
  const rowMaxX = new Int32Array(h).fill(-1);
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) {
    const rowBase = y * w * c;
    for (let x = 0; x < w; x++) {
      const i = rowBase + x * c;
      const opaque = data[i + 3] > 10 && !(data[i] >= whiteThresh && data[i + 1] >= whiteThresh && data[i + 2] >= whiteThresh);
      if (opaque) {
        if (x < rowMinX[y]) rowMinX[y] = x;
        if (x > rowMaxX[y]) rowMaxX[y] = x;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { w, h, minX, maxX, minY, maxY, rowMinX, rowMaxX };
}

const rowW = (e: Extent, y: number) => (e.rowMaxX[y] >= 0 ? e.rowMaxX[y] - e.rowMinX[y] + 1 : 0);

// Interim-Kontrast bis zum Design-Code: Cap darf NIE die Body-Farbe tragen
// (Regel 1: Cap kontrastiert immer mit Body). Der Design-Code liefert spaeter
// Cap_Relation und ersetzt diese Heuristik.
function contrastCapHex(bodyHex: string | null): string {
  if (!bodyHex) return '#FFFFFF'; // Klarglas: Farbe im Inhalt, Cap neutral weiss
  const h = bodyHex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? '#232323' : '#FFFFFF'; // helle Base -> dunkler Cap, sonst weiss
}

function neckWidth(e: Extent): number {
  const band = Math.max(2, Math.round((e.maxY - e.minY) * 0.20));
  let min = Infinity;
  for (let y = e.minY; y <= e.minY + band; y++) { const w = rowW(e, y); if (w > 0 && w < min) min = w; }
  return isFinite(min) ? min : rowW(e, e.minY);
}

function collarWidth(e: Extent): number {
  // Kragen = breiteste Stelle im unteren Band, aber OHNE die Dip-Tube.
  // Bug: das unterste 15%-Band traf bei Pump/Dropper die duenne Dip-Tube
  // statt den Kragen -> Cap wurde zu klein skaliert. Fix: unterste ~18%
  // (Dip-Tube) ausschliessen, Kragen im Band 35-82% der Hoehe messen.
  const h = e.maxY - e.minY;
  const top = e.minY + Math.round(h * 0.35);
  const bottom = e.maxY - Math.round(h * 0.18);
  let max = 0;
  for (let y = top; y <= bottom; y++) { const w = rowW(e, y); if (w > max) max = w; }
  return max || rowW(e, Math.round((e.minY + e.maxY) / 2));
}

// opts.capScale pro Base überschreibbar; sonst Hals-Matching. Getestet.
async function composeHover(
  baseBuffer: Buffer,
  capBuffer: Buffer,
  opts: { gapFrac?: number; capScale?: number | null; clampMin?: number; clampMax?: number; whiteThresh?: number; capTintHex?: string | null } = {}
): Promise<Buffer> {
  const { gapFrac = 0.07, capScale = null, clampMin = 0.10, clampMax = 0.55, whiteThresh = 245, capTintHex = null } = opts;

  const baseAlpha = await whiteToAlpha(baseBuffer, whiteThresh);
  const bE = await contentExtent(baseAlpha, whiteThresh);
  const bw = bE.maxX - bE.minX + 1, bh = bE.maxY - bE.minY + 1;
  const baseTrim = await sharp(baseAlpha).extract({ left: bE.minX, top: bE.minY, width: bw, height: bh }).png().toBuffer();
  const baseNeck = neckWidth(bE);

  const capAlpha = await whiteToAlpha(capBuffer, whiteThresh);
  const cE = await contentExtent(capAlpha, whiteThresh);
  const cw0 = cE.maxX - cE.minX + 1, ch0 = cE.maxY - cE.minY + 1;
  let capTrim = await sharp(capAlpha).extract({ left: cE.minX, top: cE.minY, width: cw0, height: ch0 }).png().toBuffer();
  const capCollar = collarWidth(cE);

  let capFinalW = capScale != null
    ? Math.round(bw * capScale)
    : Math.round(cw0 * (baseNeck / Math.max(1, capCollar)));
  capFinalW = Math.max(Math.round(bw * clampMin), Math.min(Math.round(bw * clampMax), capFinalW));
  capTrim = await sharp(capTrim).resize({ width: capFinalW }).png().toBuffer();
  if (capTintHex) capTrim = await recolorCap(capTrim, capTintHex);
  const cM = await sharp(capTrim).metadata();
  const cw = cM.width!, ch = cM.height!;

  const gap = Math.round(bh * gapFrac);
  const sideM = Math.round(Math.max(bw, cw) * 0.18);
  const canvasW = Math.max(bw, cw) + sideM * 2;
  const vM = Math.round((ch + gap + bh) * 0.07);
  const canvasH = vM + ch + gap + bh + vM;

  return sharp({ create: { width: canvasW, height: canvasH, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([
      { input: capTrim, left: Math.round(canvasW / 2 - cw / 2), top: vM },
      { input: baseTrim, left: Math.round(canvasW / 2 - bw / 2), top: vM + ch + gap },
    ])
    .jpeg({ quality: 95 })
    .toBuffer();
}

// ── Szenen-Presets (handkuratiert, kein Korpus, kein Airtable) ──────
// Haiku wählt genau EINE ID passend zur Emotion. Nur Backdrop/Licht-Stimmung —
// nie Form/Material. Ergänzbar ohne Deploy-Risiko.
const SCENE_PRESETS: { id: string; en: string }[] = [
  { id: 'studio_soft',      en: 'minimal seamless studio, soft neutral off-white backdrop, gentle gradient' },
  { id: 'concrete_cool',    en: 'dark micro-cement surface, cool blue-grey side light, engineered technical mood' },
  { id: 'highkey_bright',   en: 'bright high-key set, clean pastel backdrop, playful and fresh' },
  { id: 'stone_luxe',       en: 'honed stone or marble surface, warm directional light, quiet-luxury mood' },
  { id: 'botanical_warm',   en: 'warm linen surface, soft daylight, a hint of out-of-focus greenery' },
  { id: 'vanity_editorial', en: 'glossy dark vanity surface with a soft reflection, editorial beauty lighting' },
];

// ── Helpers ─────────────────────────────────────────────────────────
function queryHash(q: string): string {
  return createHash('md5').update(q.toLowerCase().trim()).digest('hex').slice(0, 12);
}

function cacheKey(systemId: string, q: string, capId: string | null, tier: Tier, segment: string | null = null): string {
  return `${systemId}_${queryHash(q)}_${capId || 'none'}_${tier}${segment ? `_${segment}` : ''}`;
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
  // v5: Bild_Harmonisiert ist der bevorzugte Anker (neutrales Studio-Foto),
  // Bild_System nur Fallback. Fall C/D (Base+Cap-Komposition) bleibt auf Roh_Base.
  const bildSystem = imgUrl(sys.fields['Bild_Harmonisiert']) || imgUrl(sys.fields['Bild_System']);
  const caps = sys.fields['Caps'] as any[] | undefined;
  const capCount = caps?.length || 0;

  if (!bildRohBase && !bildSystem) throw new Error('Kein Bild vorhanden');

  // Harmonisiertes Ganzfoto ist bevorzugter Anker für Fall A/B; C/D komponieren auf Roh_Base.
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
  { label: 'Bambus', en: 'bamboo', tokens: ['bambus', 'bamboo'] },
  { label: 'Holz', en: 'wood', tokens: ['holz', 'wood', 'wooden', 'timber', 'oak', 'eiche'] },
  { label: 'Kork', en: 'cork', tokens: ['kork', 'cork'] },
  { label: 'Papier', en: 'paper or cardboard',tokens: ['papier', 'paper', 'karton', 'cardboard', 'pappe'] },
  { label: 'Glas', en: 'glass', tokens: ['glas', 'glass'] },
  { label: 'Keramik', en: 'ceramic', tokens: ['keramik', 'ceramic', 'porzellan', 'porcelain'] },
  { label: 'Stein', en: 'stone or marble', tokens: ['stein', 'stone', 'marmor', 'marble', 'terrazzo'] },
  { label: 'Aluminium', en: 'aluminium', tokens: ['aluminium', 'aluminum', 'alu', 'chrom', 'chrome', 'chromed', 'verchromt'] },
  { label: 'Metall', en: 'metal', tokens: ['metall', 'metal'] },
  { label: 'Stahl', en: 'steel', tokens: ['stahl', 'steel'] },
  { label: 'Messing', en: 'brass', tokens: ['messing', 'brass'] },
  { label: 'Kupfer', en: 'copper', tokens: ['kupfer', 'copper'] },
  { label: 'Zamak', en: 'zamak', tokens: ['zamak'] },
  { label: 'PCR', en: 'visible recycled material texture', tokens: ['pcr', 'rezyklat', 'recycled', 'ocean plastic'] },
  { label: 'Acryl', en: 'acrylic', tokens: ['acryl', 'acrylic', 'pmma', 'plexiglas'] },
  { label: 'Surlyn', en: 'surlyn', tokens: ['surlyn'] },
  { label: 'PETG', en: 'petg', tokens: ['petg'] },
  { label: 'PET', en: 'pet', tokens: ['pet'] },
  { label: 'HDPE', en: 'hdpe', tokens: ['hdpe'] },
  { label: 'PP', en: 'polypropylene', tokens: ['pp', 'polypropylen', 'polypropylene'] },
];

const CLOSURE_LEXICON: LexEntry[] = [
  { label: 'Pipette', en: 'a dropper or pipette', tokens: ['pipette', 'dropper', 'tropfer'] },
  { label: 'Pumpe', en: 'a pump', tokens: ['pumpe', 'pump', 'lotion pump'] },
  { label: 'Spray', en: 'a spray or atomizer', tokens: ['spray', 'sprüh', 'spruh', 'atomizer', 'zerstäuber', 'zerstauber', 'mist'] },
  { label: 'Airless', en: 'an airless dispenser', tokens: ['airless'] },
  { label: 'Disc Top', en: 'a disc top', tokens: ['disc top', 'disctop'] },
  { label: 'Flip Top', en: 'a flip top', tokens: ['flip top', 'fliptop', 'klappdeckel'] },
  { label: 'Roll-On', en: 'a roll-on ball', tokens: ['roll-on', 'rollon', 'roller', 'rollerball', 'kugel'] },
  { label: 'Schraubverschluss', en: 'a screw cap', tokens: ['schraubverschluss', 'screw cap', 'twist off'] },
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

/**
 * Hard-Rule wird IMMER im Code angehängt — nie von Haiku geschrieben.
 * FORM / MATERIAL / VERSCHLUSS / forbidden bleiben hart gesperrt (Invariante).
 * Geändert ggü. Blank-Version: statt „completely blank / white background"
 * jetzt Marken-Anmutung erlaubt (aber kein lesbarer Text / kein echtes Logo)
 * + garantierte Render-Tells (Grounding, Licht, Optik).
 */
function buildHardRule(fall: RenderFall, forbidden: string[]): string {
  const closureRule = fall === 'A'
    ? 'Do not add, remove, replace or restyle the closure — keep the closure exactly as shown in the reference image.'
    : 'Use ONLY the closure shown in image 2 — do not invent a different closure, do not change its shape or mechanism.';

  return [
    'CRITICAL RULES — these override everything above.',
    // ── Invariante (unverändert hart) ──
    'Do not change the shape, silhouette, proportions or size of the packaging.',
    'Do not redesign the bottle: no angular, faceted, architectural, geometric or tapered body, no new silhouette, no different neck — the container outline must stay identical to the reference image.',
    closureRule,
    'Do not introduce any material that is not visible in the reference images or explicitly listed as available.',
    forbidden.length ? `Explicitly forbidden in this render: ${forbidden.join(', ')}.` : '',
    // ── Markenwelt erlaubt, aber Guardrail ──
    'No printed label, sticker, wordmark, panel or lettering anywhere on the product — the surface is bare, uninterrupted material. STRICTLY FORBIDDEN: any real existing brand name, logo or trademark (e.g. never Porsche, never a car-brand crest).',
    // ── Garantierte Render-Tells (code-seitig, verlässlich) ──
    'Ground the product on the surface with a soft contact shadow — the product must never float.',
    'Softbox key light from the upper-left, subtle rim light, controlled speculars.',
    '100mm macro, f/8, commercial product photography, photorealistic.',
    'No hard shadows, no clutter, no oversaturation, no cheap plastic look.',
  ].filter(Boolean).join(' ');
}

type Concept = {
  konzept_name: string;
  story: string;
  rationale: string;
  produzierbar: any | null;
  szene_id: string;
  // v5.1 Board-Felder (Frontend komponiert Label/Chips/Radar über den Render):
  label?: { wortmarke: string; kategorie: string; ist_platzhalter: boolean };
  palette?: { name: string; hex: string[]; pantone: string[] };
  radar?: Record<string, number>;
  zielprofil?: string[];
  segment?: string | null;
};

// ── Prompt Assembly v5 — Constrained Selection ──────────────────────
// Haiku schreibt KEINEN visuellen Prompt mehr. Es wählt nur aus endlichen
// Listen (Palette/Finish/Akzent/Szene aus SF_-Feldern, Farbpaletten,
// Design_Regeln) und liefert das Konzept (Name/Story/Herleitung).
// Der Seedream-Prompt wird zu 100 % deterministisch im Code assembliert:
// Preserve-first + Attribut-Ground-Truth (Render_Constraint) + echtes
// Material + Hex/Pantone der gewählten Palette + Label in Quotes.
// Halluzinationsfläche für Form/Material: null — der Pfad existiert nicht.

const ATTRIBUT_TABLE = 'tblsWJ0q2sQ7sXwvk';

// Bekannte reale Marken — dürfen NIE als Wortmarke aufs Label (Code-Guardrail,
// zusätzlich zur Haiku-Instruktion).
const REAL_BRAND_BLOCK = [
  'porsche', 'audi', 'bmw', 'mercedes', 'ferrari', 'lamborghini', 'tesla',
  'chanel', 'dior', 'gucci', 'prada', 'hermes', 'ysl', 'armani',
  'nivea', 'loreal', "l'oreal", 'garnier', 'dove', 'vichy', 'kerastase',
  'apple', 'nike', 'adidas', 'rolex', 'gillette',
];

const FINISH_EN: Record<string, string> = {
  gloss: 'a clean glossy finish',
  matt: 'a premium matte finish',
  soft_touch: 'a soft-touch matte coating',
};
const FINISH_DE: Record<string, string> = {
  gloss: 'Glanz-Finish',
  matt: 'Matt-Finish',
  soft_touch: 'Soft-Touch-Matt',
};
const AKZENT_EN: Record<string, string> = {
  none: '',
  hot_foil_detail: 'one single small hot-foil accent detail near the wordmark',
  silkscreen_graphic: 'a clean minimal silkscreen-printed graphic element',
};
const AKZENT_DE: Record<string, string> = {
  none: '',
  hot_foil_detail: 'Hot-Foil-Akzent',
  silkscreen_graphic: 'Siebdruck-Grafik',
};

function parseJsonArray(raw: any): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(String(raw));
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch { /* Fallback: Hex/Pantone per Regex */ }
  const m = String(raw).match(/#[0-9a-fA-F]{6}|[0-9]{2,4}\s?C?\b/g);
  return m ? m.slice(0, 6) : [];
}

function sanitizeBrandname(name: any, brief: string): string {
  const n = String(name || '').trim().replace(/[^A-Za-zÀ-ž0-9 &'-]/g, '').slice(0, 14);
  if (n.length < 2) return '';
  const low = n.toLowerCase();
  if (REAL_BRAND_BLOCK.some(b => low.includes(b))) return '';
  return n;
}

async function assemblePrompt(
  brief: string,
  fall: RenderFall,
  sysFields: any,
  capFields: any | null,
  reqSegment: string | null = null
): Promise<{ prompt: string; forbidden: string[]; concept: Concept }> {
  const [produktRegeln, designRegeln, farbpalettenAll] = await Promise.all([
    airtableListAll(PRODUKT_REGELN_TABLE),
    airtableListAll(DESIGN_REGELN_TABLE),
    airtableListAll(FARBPALETTEN_TABLE),
  ]);
  // v5: Active-Filter (Bugfix — inaktive Paletten konnten bisher matchen).
  const farbpaletten = farbpalettenAll.filter(p => !!p.fields['Active']);

  // ── Attribut-Ground-Truth (Render_Constraint) — positive Fixierung ─
  const attrIds: string[] = Array.isArray(sysFields['Attribute']) ? sysFields['Attribute'] : [];
  let attrConstraints: string[] = [];
  if (attrIds.length > 0) {
    try {
      const formula = `OR(${attrIds.slice(0, 25).map(id => `RECORD_ID()='${id}'`).join(',')})`;
      const recs = await airtableQuery(ATTRIBUT_TABLE, formula, ['A_Name (Wert)', 'Render_Constraint'], 25);
      attrConstraints = recs
        .map(r => String(r.fields['Render_Constraint'] || '').trim())
        .filter(Boolean);
    } catch { attrConstraints = []; }
  }

  const matchedProdukt = produktRegeln.filter(r => queryMatchesKeywords(brief, r.fields['Keywords']));
  // Design_Regeln liefert NUR NOCH Verfeinerung (Ausschlüsse/Codes/Kanal) —
  // KEINE Palettenverengung mehr. Die Welt-Wahl macht das Segment (s.u.).
  const matchedDesign = designRegeln.filter(r => queryMatchesKeywords(brief, r.fields['Wenn_Query_Signal']));
  const nieRules = matchedDesign.map(r => String(r.fields['Nie'] || '').trim()).filter(Boolean);
  const designCodes = matchedDesign.map(r => String(r.fields['Dann_Design_Codes'] || '').trim()).filter(Boolean);
  const kanalSignale = matchedDesign.map(r => String(r.fields['Kanal_Signal'] || '').trim()).filter(Boolean);

  // ── Segment-Gate (HART) ───────────────────────────────────────────
  // Welt-Zuordnung fest (A), Palettenfeinwahl via Haiku (B). Kein
  // Fallback-auf-ALLE mehr — das war die Ursache der Citrus/Orange-Konvergenz.
  // Schickt das Frontend eine Pill (reqSegment) → Welt fix, Haiku sieht nur diese.
  // Sonst wählt Haiku die Welt selbst (STEP 0) und wir filtern hart nach.
  if (farbpaletten.length === 0) throw new Error('Keine aktiven Farbpaletten vorhanden');
  const requestedSegment = SEGMENTS.includes(reqSegment as any) ? (reqSegment as string) : null;
  let candidates = requestedSegment
    ? farbpaletten.filter(p => multiSelectNames(p.fields['Segment']).includes(requestedSegment))
    : farbpaletten;
  // Sicherheitsnetz: Welt (noch) ohne aktive Palette → nicht crashen, statt Welt alle zeigen.
  if (candidates.length === 0) candidates = farbpaletten;

  // ── Produkt-Basics ────────────────────────────────────────────────
  const type = selectName(sysFields['Type']);
  const material = multiSelectNames(sysFields['Material']);
  const form = multiSelectNames(sysFields['Form']).join(', ');
  const desc = sysFields['Kurzbeschreibung'] || '';
  const availMaterials = multiSelectNames(sysFields['Available_Materials']);

  const sysClosure = multiSelectNames(sysFields['Closure']).concat(selectName(sysFields['Closure']) || []);
  const capClosure = capFields
    ? multiSelectNames(capFields['Closure_Type']).concat(selectName(capFields['Closure_Type']) || [])
    : [];
  const closureCoverage = [...new Set([...sysClosure, ...capClosure].filter(Boolean))];
  const capMaterial = capFields ? multiSelectNames(capFields['Material']).join(', ') : '';

  // ── Gates auf den Brief (Demand-Signal 'rejected' bleibt) ─────────
  const materialCoverage = [...new Set([...availMaterials, ...material])];
  const forbiddenMaterials = runGate(brief, MATERIAL_LEXICON, materialCoverage);
  const forbiddenClosures = runGate(brief, CLOSURE_LEXICON, closureCoverage);
  const forbidden = [...new Set([...forbiddenMaterials, ...forbiddenClosures])];

  // ── Erlaubte Enums aus SF_-Feldern (Produzierbarkeit by construction) ─
  const primaryMatEarly = (multiSelectNames(sysFields['Material'])[0] || '').toLowerCase();
  const isPlasticBody = /pet|petg|pp|hdpe|acryl|surlyn|kunststoff|plastic/.test(primaryMatEarly);
  const finishes: string[] = ['gloss'];
  if (sysFields['SF_Mattierbar'] || isPlasticBody) finishes.push('matt', 'soft_touch');
  const akzente: string[] = ['none'];
  if (sysFields['SF_HotFoil']) akzente.push('hot_foil_detail');
  if (sysFields['SF_Siebdruck']) akzente.push('silkscreen_graphic');
  // Leere Checkbox = ungetaggt, nicht "nein". Kunststoff ist industriell immer
  // einfärbbar (Masterbatch) → default true; Glas/Metall nur bei explizitem Tag.
  const colorable = !!sysFields['SF_Einfaerbbar'] || isPlasticBody;
  const decoProfile = String(sysFields['Decoration_Profile'] || '').trim();

  // Emotions-Label-Set = Union der Emotion_Tags der Kandidaten-Paletten.
  const emotionTagSet = [...new Set(candidates.flatMap(p => multiSelectNames(p.fields['Emotion_Tags'])))];

  // ── Haiku: NUR Auswahl + Konzept — striktes JSON, keine Prosa ─────
  const paletteList = candidates.map(p => {
    const f = p.fields;
    return `- id: ${p.id} | seg: ${multiSelectNames(f['Segment']).join('/') || '-'} | ${f['Name'] || ''} | tags: ${multiSelectNames(f['Emotion_Tags']).join(', ')} | warmth: ${selectName(f['SF_Warmth']) || '-'} | prestige: ${f['SF_Prestige_Score'] ?? '-'}/5 | zeitgeist: ${f['SF_Zeitgeist_Score'] ?? '-'}/5 | ${String(f['Beschreibung'] || '').slice(0, 90)}`;
  }).join('\n');

  // Welten, die in den gezeigten Paletten real vorkommen (leere Welten nie anbieten).
  const worldsAvail = [...new Set(candidates.flatMap(p => multiSelectNames(p.fields['Segment'])))].filter(Boolean);
  const segmentStep = requestedSegment
    ? `WORLD (fixed by the user): ${requestedSegment}. Set "segment" to exactly this. Every palette below already belongs to this world.`
    : `STEP 0 — segment: choose EXACTLY ONE world from [${worldsAvail.join(', ')}] that the brief's positioning belongs to. In STEP 2 you may ONLY pick a palette whose "seg" contains this chosen segment.`;

  const selectionPrompt = `You are ulba's design-selection engine for beauty packaging.
You NEVER write a visual prompt and NEVER invent materials, shapes, ingredients, actives, scents or claims.
You only SELECT from the finite options below and write a short German concept grounded in the brief.

PRODUCT (fixed, never changed): ${type} | ${material.join(', ')} | ${form}
${desc ? String(desc).slice(0, 200) : ''}
${closureCoverage.length ? `CLOSURE (fixed): ${closureCoverage.join(', ')}` : ''}
${designCodes.length ? `DESIGN CODES (apply): ${designCodes.join(' · ')}` : ''}
${kanalSignale.length ? `CHANNEL SIGNAL: ${kanalSignale.join(' · ')}` : ''}
${nieRules.length ? `NEVER (hard): ${nieRules.join(' · ')}` : ''}

${segmentStep}
STEP 1 — ziel_profil: choose 3–5 tags ONLY from: [${emotionTagSet.join(', ')}]. They must express the brief's audience/mood.
AUDIENCE RULE (hard): the palette MUST fit the audience in the brief. Feminine / curls / warm / natural briefs get warm or soft palettes — NEVER tech/chrome/futurist palettes. Masculine/tech briefs get cool restrained palettes. When in doubt, choose the softer, warmer palette.
STEP 2 — palette_id: exactly one id from PALETTES below whose "seg" contains your chosen segment AND whose tags/warmth/prestige best fit ziel_profil AND the audience rule.
PALETTES:
${paletteList}
STEP 3 — finish: one of [${finishes.join(', ')}].
STEP 4 — akzent: one of [${akzente.join(', ')}].
STEP 5 — szene_id: one of [${SCENE_PRESETS.map(s => s.id).join(', ')}]. DEFAULT to 'studio_soft' or 'highkey_bright' (clean e-commerce packshot) unless the brief explicitly asks for a dark/moody/editorial setting.
STEP 6 — brandname: if the brief contains the user's own brand name, use it EXACTLY; otherwise INVENT a fictional name (2–8 letters, evocative). NEVER a real existing brand or car brand.
STEP 7 — konzept_name (1–3 words), story (ONE German sentence — NEVER name ingredients, actives, vitamins, scents or claims unless that exact word is in the brief), herleitung (ONE German sentence: why palette + finish follow from the ziel_profil — mention ONLY the chosen palette name and the chosen finish, NEVER materials, metal, chrome or techniques that were not selected).
STEP 8 — radar: score the TARGET emotional direction of this product on each axis 0–100 (integers): waerme, prestige, energie, ruhe, natuerlichkeit, praezision. These express where the brief wants to land, not the bare bottle.

OUTPUT ONLY this JSON, no fences, no prose:
{"segment":"…","ziel_profil":["…"],"palette_id":"…","finish":"…","akzent":"…","szene_id":"…","brandname":"…","konzept_name":"…","story":"…","herleitung":"…","radar":{"waerme":0,"prestige":0,"energie":0,"ruhe":0,"natuerlichkeit":0,"praezision":0}}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      temperature: 0,
      system: selectionPrompt,
      messages: [{ role: 'user', content: brief }],
    }),
  });
  const data = await res.json() as { content: Array<{ text: string }> };
  const rawText = (data.content?.[0]?.text || '').trim();

  let parsed: any = null;
  try {
    parsed = JSON.parse(rawText.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim());
  } catch { parsed = null; }

  // ── Validierung mit deterministischen Fallbacks ───────────────────
  // Effektive Welt: Pill > Haiku-Wahl > Welt der ersten Kandidatenpalette.
  const validSeg = SEGMENTS.includes(parsed?.segment) ? String(parsed.segment) : null;
  const effectiveSegment = requestedSegment || validSeg
    || (candidates[0] ? multiSelectNames(candidates[0].fields['Segment'])[0] : null) || null;
  // HART: nur Paletten der effektiven Welt sind wählbar (schnappt Fehlwahl zurück).
  const worldPool = effectiveSegment
    ? candidates.filter(p => multiSelectNames(p.fields['Segment']).includes(effectiveSegment))
    : candidates;
  const pool = worldPool.length ? worldPool : candidates;
  const pal = pool.find(p => p.id === parsed?.palette_id) || pool[0];
  const finish = finishes.includes(parsed?.finish) ? parsed.finish : finishes[finishes.length - 1];
  const akzent = akzente.includes(parsed?.akzent) ? parsed.akzent : 'none';
  const szeneId = SCENE_PRESETS.some(s => s.id === parsed?.szene_id) ? parsed.szene_id : 'studio_soft';
  const szene = SCENE_PRESETS.find(s => s.id === szeneId)!;
  const brandname = sanitizeBrandname(parsed?.brandname, brief);
  const zielProfil: string[] = Array.isArray(parsed?.ziel_profil)
    ? parsed.ziel_profil.filter((t: any) => emotionTagSet.includes(t)).slice(0, 5)
    : [];

  const palName = String(pal.fields['Name'] || '');
  const hex = parseJsonArray(pal.fields['Hex_Codes']).slice(0, 3);
  const pantone = parseJsonArray(pal.fields['Pantone_Nearest']).slice(0, 3);

  // ── Deterministische Prompt-Assembly — RECOLOR-ONLY ───────────────
  // Bewiesener Modus: Seedream ändert NUR Farbe/Finish auf der exakten
  // Bild_Harmonisiert-Flasche. KEIN Labeltext (verschreibt sich, bricht Form),
  // KEINE Szenenfantasie — immer weisses Studio. Label + Emotionsprofil +
  // Palette-Chips baut das Frontend als Board ÜBER den Render.
  const primaryMat = (material[0] || 'plastic').toLowerCase();
  const isPlastic = /pet|petg|pp|hdpe|acryl|surlyn|kunststoff|plastic/.test(primaryMat);
  const matEN = material.join(' / ') || 'plastic';
  const kategorie = String(matchedProdukt[0]?.fields['Kategorie'] || type || 'Beauty Product');

  const lines: string[] = [];
  lines.push(`Keep the exact same packaging shape, silhouette, proportions, neck and closure as shown in the reference image${fall === 'A' ? '' : 's'} — change ONLY the surface color and finish. Do NOT add any label, sticker, printed panel or white patch — the surface stays one uninterrupted, continuous material.`);
  if (attrConstraints.length) {
    lines.push(`Fixed physical characteristics of this exact product: ${attrConstraints.slice(0, 10).join('; ')}.`);
  }
  if (fall === 'B') {
    lines.push(`Image 1 shows the bottle WITH its existing cap, image 2 the replacement cap. REPLACE the original cap from image 1 with the cap from image 2 exactly as shown — do not merge them, do not invent a new cap.`);
  } else if (fall === 'C' || fall === 'D') {
    lines.push(`Compose a single product photo by combining the two reference images: body shape exactly from image 1, cap shape and mechanism exactly from image 2, assembled onto the bottle neck, flush and aligned.`);
  }
  lines.push(`The body is ${matEN}${isPlastic ? ' — it must clearly read as a plastic container, never as solid metal, aluminium, steel, glass or ceramic' : ''}.`);
  if (capMaterial) lines.push(`The cap is ${capMaterial}.`);
  if (colorable && hex.length) {
    lines.push(`Recolor the body in ${hex[0]}${hex[1] ? ` with ${hex[1]} as secondary tone` : ''}, applied as ${FINISH_EN[finish]} on the existing material.`);
  } else if (hex.length) {
    lines.push(`Do NOT recolor the ${matEN} body — keep it in its original tone. Color ONLY the cap, as ONE single solid ${hex[0]} tone across the entire cap as a single part in ${FINISH_EN[finish]}. Do NOT split the cap into multiple colored segments and do NOT use more than this one color on it.`);
  }
  if (AKZENT_EN[akzent]) lines.push(`Add ${AKZENT_EN[akzent]}.`);
  // Immer weisses Studio — kein Szenen-Preset im Recolor-Modus.
  lines.push(`Clean seamless white studio background, soft neutral lighting, centered product packshot. No text, no label graphics, no logo, no lettering anywhere on the product.`);

  const visuell = lines.join(' ');

  // Label-Daten strukturiert fürs Frontend-Board (NICHT an Seedream).
  const labelData = {
    wortmarke: brandname || '',
    kategorie,
    ist_platzhalter: !brandname,
  };

  // ── Konzept + Produzierbar (code-built, Register 2) ───────────────
  const produzierbar = {
    finish: [FINISH_DE[finish]],
    dekoration: [
      ...(AKZENT_DE[akzent] ? [AKZENT_DE[akzent]] : []),
      ...(colorable ? ['Einfärbung Primärbehälter'] : ['Farbe via Label/Cap (Behälter nicht einfärbbar)']),
      ...(decoProfile ? [decoProfile.slice(0, 120)] : []),
    ],
    grafik_label: brandname
      ? `Wortmarke "${brandname}" + "${kategorie}", reduzierte Typo`
      : `Wortmarke (Platzhalter) + "${kategorie}", reduzierte Typo`,
    farbkonzept: `${palName} — Hex: ${hex.join(', ')}${pantone.length ? ` · Pantone: ${pantone.join(', ')}` : ''}`,
  };

  const herleitung = String(parsed?.herleitung || '').trim();
  const rationale = [
    zielProfil.length ? `Zielprofil: ${zielProfil.join(' · ')}` : '',
    herleitung || `Palette ${palName} und ${FINISH_DE[finish]} folgen aus dem Brief.`,
  ].filter(Boolean).join(' — ');

  const rawRadar = parsed?.radar || {};
  const radarAxes = ['waerme', 'prestige', 'energie', 'ruhe', 'natuerlichkeit', 'praezision'];
  const radar: Record<string, number> = {};
  for (const ax of radarAxes) {
    const v = Number(rawRadar[ax]);
    radar[ax] = Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 50;
  }

  const concept: Concept = {
    konzept_name: String(parsed?.konzept_name || palName || '').slice(0, 60),
    story: String(parsed?.story || '').slice(0, 240),
    rationale,
    produzierbar,
    szene_id: szeneId,
    label: labelData,
    palette: { name: palName, hex, pantone },
    radar,
    zielprofil: zielProfil,
    segment: effectiveSegment,
  };

  return {
    prompt: `${visuell}\n\n${buildHardRule(fall, forbidden)}`,
    forbidden,
    concept,
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
    segment = null,
  } = req.body as {
    systemId: string;
    query: string;
    renderBrief?: string | null;
    selectedCapId?: string | null;
    tier?: Tier;
    segment?: string | null;
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
    const key = cacheKey(systemId, effectiveBrief, selectedCapId, tier, segment);
    let cached: any[] = [];
    try {
      cached = await airtableQuery(
        CACHE_TABLE,
        `{Cache_Key}='${key}'`,
        ['Cache_Key', 'Bild', 'Rendering_Prompt', 'Konzept_Name', 'Konzept_Story', 'Konzept_Rationale', 'Szene_ID', 'Produzierbar', 'Board'],
        1
      );
    } catch {
      // z.B. Feld 'Board' noch nicht angelegt → als Cache-Miss behandeln, frisch rendern.
      cached = [];
    }
    if (cached.length > 0) {
      const cachedImg = imgUrl(cached[0].fields['Bild']);
      if (cachedImg) {
        const cf = cached[0].fields;
        let produzierbar: any = null;
        try { produzierbar = cf['Produzierbar'] ? JSON.parse(cf['Produzierbar']) : null; } catch { produzierbar = null; }
        let board: any = {};
        try { board = cf['Board'] ? JSON.parse(cf['Board']) : {}; } catch { board = {}; }
        const cachedConcept: Concept | null = (cf['Konzept_Name'] || cf['Szene_ID'] || produzierbar)
          ? {
              konzept_name: cf['Konzept_Name'] || '',
              story: cf['Konzept_Story'] || '',
              rationale: cf['Konzept_Rationale'] || '',
              produzierbar,
              szene_id: cf['Szene_ID'] || '',
              label: board.label,
              palette: board.palette,
              radar: board.radar,
              zielprofil: board.zielprofil,
            }
          : null;

        return res.status(200).json({
          renderingUrl: cachedImg,
          renderingPrompt: cf['Rendering_Prompt'] || '',
          briefUsed: effectiveBrief,
          cacheId: cached[0].id,
          cached: true,
          concept: cachedConcept,
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

    // ── 4. Render-Strategie ─────────────────────────────────────────
    // Fall C/D: Base und Cap NIE zusammen an Gemini geben — es zeichnet den
    // kleinen schwebenden Cap sonst neu (ikonische Form überlebt, untypische
    // driftet). Stattdessen: Base einzeln umfärben (formtreu wie immer bei
    // Einzelbild), Cap deterministisch in die Palette tönen (Form pixel-exakt),
    // beide per Code schweben-compositen. KEIN finaler generativer Pass über den
    // Cap → er kann nicht mehr verfälscht werden.
    const useSplitCompose = (fall === 'C' || fall === 'D') && !!capImageUrl;
    const promptFall: RenderFall = useSplitCompose ? 'A' : fall;

    // ── 5. Assemble Rendering Prompt (Konzept-Brief) ────────────────
    const { prompt: renderingPrompt, forbidden, concept } =
      await assemblePrompt(effectiveBrief, promptFall, sys.fields, capFields, segment);

    // ── 6. Render ───────────────────────────────────────────────────
    let renderingUrl: string;
    let finalBuffer: Buffer | null = null;

    if (useSplitCompose) {
      try {
        // Base allein umfärben — mit EIGENEM Prompt, der KEINEN Cap erlaubt.
        // Der Standard-Prompt erwähnt "closure/cap" → Gemini malt sonst einen
        // Cap auf die nackte Base (Doppel-Cap). Der echte Cap kommt separat rein.
        const matRaw = sys.fields['Material'];
        const primaryMat = String(Array.isArray(matRaw) ? matRaw[0] : (matRaw || '')).toLowerCase();
        const isPlasticBody = /pet|petg|pp|hdpe|acryl|surlyn|kunststoff|plastic/.test(primaryMat);
        const bodyColorable = !!sys.fields['SF_Einfaerbbar'] || isPlasticBody;
        const bodyHex = concept.palette?.hex?.[0] || null;
        const bodyColorLine = bodyColorable && bodyHex
          ? `Recolor the bottle body to ${bodyHex} with a clean surface finish.`
          : `Keep the bottle body as clear transparent glass — do not add colour to the glass itself.`;
        const baseOnlyPrompt = `${bodyColorLine} Keep the exact same body shape, silhouette and proportions as the reference image. Preserve the exact narrow threaded neck exactly as in the reference image — same width, same threads, same shoulder; do NOT widen, flare, open up or reshape the neck. Do NOT add, draw, imply or attach any cap, closure, lid, dropper, pipette or pump anywhere on the bottle. Clean seamless white studio background, soft neutral lighting, centered. No label, sticker, text, logo or lettering anywhere.`;

        const recoloredBaseUrl = await geminiEdit([primaryUrl], baseOnlyPrompt);
        const [baseBuf, capBuf] = await Promise.all([
          fetchBuffer(recoloredBaseUrl),
          fetchBuffer(capImageUrl!),
        ]);
        const capHex = contrastCapHex(bodyHex); // Kontrast statt Body-Farbe (kein Mono mehr)
        finalBuffer = await composeHover(baseBuf, capBuf, { capTintHex: capHex });
        renderingUrl = `data:image/jpeg;base64,${finalBuffer.toString('base64')}`;
      } catch (e) {
        // Fallback: generativer Zwei-Bild-Aufruf (wie bisher), falls der Split scheitert.
        console.error('Split-Compose fehlgeschlagen — Fallback generativ:', e);
        renderingUrl = await geminiEdit([primaryUrl, capImageUrl!], renderingPrompt);
        finalBuffer = null;
      }
    } else {
      const imgs = (fall === 'A' || !capImageUrl) ? [primaryUrl] : [primaryUrl, capImageUrl];
      renderingUrl = await geminiEdit(imgs, renderingPrompt);
    }

    // ── 7. Bytes: Composite direkt nutzen, sonst herunterladen ──────
    const imgBuffer: Buffer = finalBuffer
      ? finalBuffer
      : Buffer.from(await (await fetch(renderingUrl)).arrayBuffer());
    const base64 = imgBuffer.toString('base64');

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
            Query_Input: query, // roh, nie sanitisiert — Demand-Signal
            Rendering_Prompt: renderingPrompt, // reiner Seedream-Prompt
            // Konzept als eigene, auswertbare Felder (Demand-Signal / Provenienz).
            Konzept_Name: concept.konzept_name || '',
            Konzept_Story: concept.story || '',
            Konzept_Rationale: concept.rationale || '',
            Szene_ID: concept.szene_id || '',
            Produzierbar: concept.produzierbar ? JSON.stringify(concept.produzierbar) : '',
            Board: JSON.stringify({ label: concept.label, palette: concept.palette, radar: concept.radar, zielprofil: concept.zielprofil }),
            Tier: tier,
            Fall: fall,
            Created_At: new Date().toISOString(),
          },
        }),
      }
    );

    const createData = await createRes.json() as { id: string; error?: any };
    if (!createData.id) {
      // Cachen fehlgeschlagen (z.B. Feld 'Board' fehlt) — Render trotzdem ausliefern.
      console.error('Cache-Record Fehler (Render wird dennoch ausgeliefert):', JSON.stringify(createData.error || createData));
      return res.status(200).json({
        renderingUrl, renderingPrompt, briefUsed: effectiveBrief,
        rejected: forbidden, capId: resolvedCapId, cacheId: null,
        cached: false, fall, tier, concept,
      });
    }

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
      concept, // { konzept_name, story, rationale, produzierbar, szene_id }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
    console.error('Render error:', message);
    return res.status(500).json({ error: message });
  }
}
