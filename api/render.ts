import { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'crypto';

// ── fetch mit hartem Timeout ──────────────────────────────────────────────
// Ohne dies wartet ein haengender externer Call (fal.ai / Airtable / Anthropic)
// bis Vercel die Funktion bei 60s killt -> Client sieht nur "Failed to fetch",
// das Log zeigt "No outgoing requests" (der Call war nie abgeschlossen). Mit
// Timeout bricht der einzelne Call ab und der Fehler NENNT den Dienst, der haengt.
async function fetchT(
  url: string,
  init: RequestInit & { timeoutMs?: number; label?: string } = {}
): Promise<Response> {
  const { timeoutMs = 25000, label, ...rest } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`Timeout ${timeoutMs}ms: ${label || url}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ── Config ──────────────────────────────────────────────────────────
const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const SYSTEM_TABLE = 'tblB1kWay9TvX3rGv';
const CAP_TABLE = 'tblQvnXPhiKGMoqDp';
const CACHE_TABLE = 'tblsOp1WKPGIquBKQ';
const CACHE_IMAGE_FIELD = 'fldFd5qi64yELhKna';
const CACHE_CAP_IMAGE_FIELD = 'fld1aoVYgaUtHsiWC'; // Cap_Bild (Anhang, symmetrisch zu Bild)
const PRODUKT_REGELN_TABLE = 'tblrL5tEpvvUh6OEj';
const FARBPALETTEN_TABLE = 'tblTIeUTyVptGIpKp';

// Positionierungs-Welten. Harter Gate für Palettenwahl. Identisch zu
// Farbpaletten.Segment / Stil.Segment in Airtable.
const SEGMENTS = ['Klinisch_Derma', 'GenZ_DTC', 'Quiet_Luxury', 'Clean_Botanical'] as const;

// Ein Modell für alles: Gemini 2.5 Flash Image (Nano Banana) via fal.ai.
// Kann Einzelbild-Recolor (Fall A) UND Multi-Image-Komposition (B/C/D), $0.039/Bild, kein Tier.
// Cache-Version: bei JEDER Aenderung an Render-Logik/Prompt hochzaehlen. Fliesst in
// den Cache-Key -> alte Eintraege werden automatisch ungueltig, kein manuelles Loeschen.
const RENDER_VERSION = 'v36-farbrollen';
const DESIGN_CODE_TABLE = 'tbl24ezzCjRQDYRnJ';
const FAL_GEMINI_EDIT = 'https://fal.run/fal-ai/gemini-25-flash-image/edit';
const FAL_SEEDREAM_EDIT = 'https://fal.run/fal-ai/bytedance/seedream/v5/lite/edit';
// Modell-Wahl pro Render-Teil (A/B-Test 04.08.: Seedream hielt Detail + Matt-Haptik
// besser als Gemini). Beide nutzen bei fal dasselbe I/O-Schema -> nur Endpoint tauschen.
// Zum Zurückschalten einzeln auf FAL_GEMINI_EDIT setzen.
const FAL_BASE_ENDPOINT = FAL_SEEDREAM_EDIT;
const FAL_CAP_ENDPOINT = FAL_SEEDREAM_EDIT;

type Tier = 'lite' | 'pro';
type RenderFall = 'A' | 'B' | 'C' | 'D';

// Der Cap SCHWEBT über der Base — kein Aufsetzen (Hals-Innengeometrie unbekannt),
// keine erfundene Passung, echte Proportionen: Cap-Kragen wird auf Base-Hals
// skaliert (in Wirklichkeit gleicher Durchmesser → Proportion by construction).
// Base bleibt voll sichtbar. Beide sind "behaltene Pixel" → Gemini färbt nur um.
// Getestet in Sandbox (Pixel-Asserts: Hals/Kragen-Messung, Schwebe-Lücke, Proportion).
// Freistellen v1 = Weiß-Schwelle (Katalog-Caps auf Weiß); robuster: birefnet vorschalten.


// Cap deterministisch in Palette einfärben: RGB × Palette (weiß→Palette, Schatten
// bleiben proportional). Form + Highlights + Transparenz bleiben pixel-exakt.

// Ein Gemini-Edit-Aufruf (fal.ai) → Bild-URL.
async function falEdit(imageUrls: string[], prompt: string, endpoint: string = FAL_GEMINI_EDIT): Promise<string> {
  const r = await fetchT(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${process.env.FAL_API_KEY}` },
    body: JSON.stringify({ prompt, image_urls: imageUrls, aspect_ratio: 'auto' }),
    timeoutMs: 120000, label: 'fal.ai edit',
  });
  if (!r.ok) throw new Error(`fal.ai edit (${endpoint}): ${await r.text()}`);
  const d = await r.json() as { images?: Array<{ url: string }> };
  const url = d.images?.[0]?.url;
  if (!url) throw new Error('Kein Bild von fal zurückgekommen');
  return url;
}
// Rueckwaerts-kompatibler Alias (Fall A/B nutzen weiter geminiEdit ohne Endpoint-Arg).
const geminiEdit = (imageUrls: string[], prompt: string) => falEdit(imageUrls, prompt, FAL_GEMINI_EDIT);


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

function cacheKey(systemId: string, q: string, capId: string | null, tier: Tier, segment: string | null = null, codeId: string | null = null, lautNudge: string | null = null, farbortNudge: string | null = null): string {
  // RENDER_VERSION zuerst: aendert sich der Render-Code, aendert sich jeder Key.
  // codeId trennt verschiedene Looks auf DEMSELBEN Base+Query (sonst kollidiert
  // der Cache und liefert allen Looks denselben Render).
  // lautNudge: der Nudge leitet einen ANDEREN Code ab als forceCodeId (der
  // Cursor haengt am alten Code). Ohne den Nudge im Key kollidiert der
  // Vor-Nudge-Render mit dem Nach-Nudge-Render unter demselben forceCodeId.
  return `${RENDER_VERSION}_${systemId}_${queryHash(q)}_${capId || 'none'}_${tier}${segment ? `_${segment}` : ''}${codeId ? `_c${codeId.slice(-6)}` : ''}${lautNudge ? `_n${lautNudge[0]}` : ''}${farbortNudge ? `_f${farbortNudge[0]}` : ''}`;
}

function imgUrl(attachmentField: any): string | null {
  if (Array.isArray(attachmentField) && attachmentField.length > 0) {
    return attachmentField[0].url || attachmentField[0].thumbnails?.full?.url || null;
  }
  return null;
}

async function airtableFetch(table: string, recordId: string): Promise<any> {
  const res = await fetchT(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}/${recordId}`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` }, label: 'airtable get' }
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
  const res = await fetchT(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}?${params}`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` }, label: 'airtable query' }
  );
  if (!res.ok) throw new Error(`Airtable query ${table}: ${res.status}`);
  const data = await res.json();
  return data.records || [];
}

async function airtableListAll(table: string): Promise<any[]> {
  const res = await fetchT(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}?pageSize=100`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` }, label: 'airtable list' }
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
/* v32 — Grafikebene. Vorher galt "bare, uninterrupted material" ausnahmslos:
   damit konnte ein Code, dessen Identitaet die Typo IST (ingredient_block),
   nie etwas ausdruecken — klinische Codes rendern als nacktes Teil. Jetzt gibt
   es eine Druckebene, aber OHNE lesbare Woerter: abstrakte Mikro-Typografie,
   wie in jedem Packaging-Mockup vor der Copy. Das IP-Risiko bleibt gedeckelt
   (keine echte Marke, kein Logo, kein lesbarer Text). */
/* v33 — Linienwerk statt "Typografie". Worte wie "typography", "lettering"
   oder "wordmark" liest das Bildmodell als Auftrag, Text zu SETZEN — und druckt
   dann die Anweisung selbst aufs Teil (v32-Fehler: "abstract nonlegible
   typography" stand lesbar auf der Flasche). Beschrieben wird deshalb nur noch
   die GEOMETRIE: feine waagerechte Striche in Textzeilen-Anmutung. Das rendert
   zuverlaessig als Etikett-Optik, ohne dass Buchstaben entstehen. */
const TYPO_RENDER: Record<string, string> = {
  minimal_klein: 'one small group of 2-3 short, fine horizontal printed lines, centred low on the front face, together occupying under 12% of the surface width',
  ingredient_block: 'two or three stacked groups of fine horizontal printed lines of varying length — the look of a clinical ingredient panel seen from arm\'s length — centred on the lower front face',
  bold_wordmark: 'one thick horizontal printed bar across the upper front face, with a group of two thin shorter lines beneath it',
  ohne: '',
};
function grafikRegel(typoHaltung: string | null | undefined, akzentHex: string | null | undefined): string {
  const t = (typoHaltung || '').toLowerCase();
  if (t === 'ohne') return 'The surface carries no printed graphics — bare, uninterrupted material.';
  const spec = TYPO_RENDER[t] || TYPO_RENDER.minimal_klein;
  return `Printed flat on the front surface: ${spec}${akzentHex ? `, printed in ${akzentHex}` : ''}. These are PURE GEOMETRIC LINES — plain solid rules with squared ends, evenly spaced. They must NOT form letters, characters, glyphs, numbers or words of any kind. Render them crisp and flat, never embossed, never on a sticker with visible edges.`;
}

function buildHardRule(fall: RenderFall, forbidden: string[], typoHaltung?: string | null, akzentHex?: string | null): string {
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
    grafikRegel(typoHaltung, akzentHex),
    'STRICTLY FORBIDDEN on the product: any letter, character, digit, word, brand name, logo, trademark or crest. Never print words from these instructions onto the packaging — this text is a description, not label copy.',
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
  // Design_Code-Provenienz + deterministische Render-Werte (Base & Cap
  // zitieren dieselbe Quelle -> Kohaerenz per Konstruktion).
  design_code?: {
    id: string; name: string; umleitung: string | null; brand?: string | null; produkt?: string | null; stufe?: number; verlust?: string[];
    farbort?: string; can_koerper?: boolean; can_liquid?: boolean;
    laut?: number | null; register?: string | null;
    can_quieter?: boolean; can_louder?: boolean;
    beschreibung?: string | null; wirkstoff_welt?: string[]; zielgruppe?: string[];
  };
  render?: { bodyLineEn: string; capHex: string | null; capFinishEn: string; akzentEn: string };
  // Die Herleitungs-Leiter: pro Brief-Signal eine Zeile Bedeutung -> Form -> weil.
  // Ein Profi-Brief waehlt nie, er leitet her — diese Kette IST die Herleitung.
  kette?: Array<{ typ: string; bedeutung: string; form: string; weil: string }>;
  // Die ernsthaft geprüfte und begruendet verworfene Alternative ("Winning
  // Concept" heisst: es gab mehrere). Billigster Agentur-Beweis im System.
  verworfen?: { name: string; grund: string } | null;
  farbsystem?: FarbSystem;
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

// ── Design_Code (Zielarchitektur 04.08.) ────────────────────────────
// Kohaerenz entsteht in der ENTSCHEIDUNG, nicht im Bild: Body-Farbe,
// Cap-Farbe, Akzent kommen aus EINEM Design_Code-Record; beide Render-
// Prompts (Base + Cap) zitieren dieselben Werte -> Relation per
// Konstruktion. Haiku waehlt nur den Code (constrained, aus Liste) —
// alle Werte kommen deterministisch aus dem Record, nie frei vom LLM.
// Selektion v15: Segment-Gate -> SF-Kompatibilitaets-Gate -> Haiku
// waehlt EINEN Code. Vektor-Distanz (Emotion_Profil) folgt, sobald
// Codes ihre 14-Dim-Profile haben — gleiche Schnittstelle.
const CAP_FINISH_EN: Record<string, string> = {
  matt: 'a clean matt finish',
  glossy: 'a clean glossy finish',
  brushed: 'a brushed metal finish',
  metallic: 'a polished metallic finish',
};
const BODY_FINISH_EN: Record<string, string> = {
  matt: 'a premium matte finish',
  glossy: 'a clean glossy finish',
  frosted: 'a satin frosted finish',
  soft_touch: 'a soft-touch matte coating',
};
// Akzent_Cue -> genau EIN Premium-Cue (Konfliktregel Typ A). Hex aus
// Akzent_Hex des Codes, Default warmes Gold.
function akzentCueEn(cue: string, akzentHex: string | null): string {
  const hex = akzentHex || '#C9A24B';
  switch ((cue || '').toLowerCase()) {
    case 'metallic_band': return `a single thin polished ${hex} metallic band around the collar of the closure`;
    case 'gold_ring':     return `a single thin polished ${hex} ring around the collar of the closure`;
    case 'praegung':      return 'a single subtle embossed (debossed) detail, tone-on-tone, no colour';
    default: return '';
  }
}
// ── Farb-Rollensystem ───────────────────────────────────────────────
// Drei Hex-Felder ohne Regel sind keine Farbwelt, sondern drei Felder.
// Rollen statt Positionen:
//   Traeger      (Body_Hex,   ~70 %) traegt die WELT — wo du hingehoerst.
//   Gegenspieler (Cap_Hex,    ~25 %) gibt die zweite Lesart. Fehlt er,
//                                    liest sich alles wie Lagerware.
//   Signal       (Akzent_Hex, <=10 %) traegt das ARGUMENT (Wirkstoff, Premium-Cue).
// Harte Regeln:
//   1. Jede Farbe braucht einen physischen Traeger -> Akzent_Hex ohne
//      Akzent_Cue ist UNGUELTIG (nicht unschoen). Genau der Zustand, der
//      "Silver Clinical" stillgelegt hatte.
//   2. Mono-Verbot MIT ZAHL: Traeger vs. Gegenspieler brauchen dE >= 25
//      ODER dL >= 20. Ohne Zahl prueft es niemand.
//   3. Nur EINE Rolle darf laut sein (hoechste Chroma gewinnt) — der Rest
//      geht ins Gedeckte. Die einzige Regel, die Bonbon-Chaos verhindert.
//   4. Drei Farben + Materialeigenfarbe. Die vierte ist Rauschen.
//   5. Sitzt der Traeger in der Fluessigkeit, wird die Huelle
//      Materialeigenfarbe — dann traegt der Cap MEHR Last, nicht weniger.
function hexRgb(h: string | null | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hexLab(h: string | null | undefined): [number, number, number] | null {
  const rgb = hexRgb(h);
  if (!rgb) return null;
  const lin = rgb.map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  const [r, g, b] = lin;
  // sRGB -> XYZ (D65) -> Lab
  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  let y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.0;
  let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function deltaE(a: string | null | undefined, b: string | null | undefined): number | null {
  const la = hexLab(a), lb = hexLab(b);
  if (!la || !lb) return null;
  return Math.sqrt((la[0] - lb[0]) ** 2 + (la[1] - lb[1]) ** 2 + (la[2] - lb[2]) ** 2);
}
function chromaOf(h: string | null | undefined): number {
  const l = hexLab(h);
  return l ? Math.sqrt(l[1] ** 2 + l[2] ** 2) : 0;
}
type FarbRolle = { rolle: 'Träger' | 'Gegenspieler' | 'Signal'; hex: string; ort: string; cue?: string };
type FarbSystem = { rollen: FarbRolle[]; laut: string | null; warnungen: string[]; regelEn: string };
function farbSystem(
  traegerHex: string | null,
  traegerOrt: string,
  capHex: string | null,
  akzentHex: string | null,
  akzentCue: string,
  capVorhanden: boolean
): FarbSystem {
  const rollen: FarbRolle[] = [];
  const warnungen: string[] = [];
  if (traegerHex && hexRgb(traegerHex)) rollen.push({ rolle: 'Träger', hex: traegerHex.toUpperCase(), ort: traegerOrt });
  if (capHex && hexRgb(capHex)) rollen.push({ rolle: 'Gegenspieler', hex: capHex.toUpperCase(), ort: 'Verschluss' });
  else if (capVorhanden) rollen.push({ rolle: 'Gegenspieler', hex: '', ort: 'Verschluss — Materialeigenfarbe' });
  // Regel 1: Signal nur MIT Traeger (Cue). Hex ohne Cue ist tote Information.
  const cueEcht = !!akzentCue && akzentCue !== 'kein' && akzentCue !== 'none';
  if (akzentHex && hexRgb(akzentHex) && cueEcht) {
    rollen.push({ rolle: 'Signal', hex: akzentHex.toUpperCase(), ort: 'Akzent', cue: akzentCue });
  } else if (akzentHex && hexRgb(akzentHex) && !cueEcht) {
    warnungen.push('Akzentfarbe ohne Träger (kein Akzent_Cue) — die Farbe hat keine Fläche und fällt lautlos weg.');
  }
  // Regel 2: Mono-Verbot mit Zahl.
  const dE = deltaE(traegerHex, capHex);
  const lT = hexLab(traegerHex), lC = hexLab(capHex);
  const dL = (lT && lC) ? Math.abs(lT[0] - lC[0]) : null;
  if (dE != null && dL != null && dE < 25 && dL < 20) {
    warnungen.push(`Träger und Gegenspieler liegen zu nah (ΔE ${dE.toFixed(0)}, ΔL ${dL.toFixed(0)}) — das Teil liest sich einfarbig.`);
  }
  // Regel 3: nur eine Rolle laut. Hoechste Chroma gewinnt.
  const kand = rollen.filter(r => r.hex).map(r => ({ r, c: chromaOf(r.hex) }));
  const laut = kand.length ? kand.reduce((a, b) => b.c > a.c ? b : a).r : null;
  const lautName = laut && chromaOf(laut.hex) > 12 ? laut.rolle : null;
  if (kand.filter(k => k.c > 35).length > 1) {
    warnungen.push('Mehr als eine Rolle ist voll gesättigt — zwei laute Farben nebeneinander lesen sich als Zufall, nicht als Entscheidung.');
  }
  // Regel 4: vierte Farbe ist Rauschen (Materialeigenfarbe zaehlt nicht mit).
  if (rollen.filter(r => r.hex).length > 3) warnungen.push('Mehr als drei Farben — die vierte ist Rauschen.');
  // Harte Render-Regel: Hierarchie in den Prompt, nicht nur in die Anzeige.
  const regelEn = lautName
    ? `Colour hierarchy (hard): only the ${lautName === 'Träger' ? (traegerOrt === 'Flüssigkeit' ? 'liquid' : 'body') : lautName === 'Gegenspieler' ? 'closure' : 'accent'} carries full saturation; every other coloured element stays visibly muted and desaturated so it supports that one instead of competing with it. Never more than one loud colour.`
    : '';
  return { rollen, laut: lautName, warnungen, regelEn };
}

type DesignCodeRec = {
  id: string;
  name: string;
  segments: string[];
  // v19 hat register + tempLaut in Extraktion und Nudge-Logik ergaenzt, aber
  // NICHT in diesem Type-Alias — Vercel transpiliert api/*.ts ohne Typcheck,
  // deshalb lief es trotzdem. Ein echter `tsc`/`next build` waere gebrochen.
  register: string | null;
  tempLaut: number | null;
  bodyBehandlung: string;
  farbort: string;
  bodyHex: string | null;
  capHex: string | null;
  capFinish: string;
  finishBody: string;
  akzentCue: string;
  akzentHex: string | null;
  ausdrucksweg: string;
  typoHaltung: string;
  szeneId: string;
  anforderungen: string[];
  // v34 (Punkt 11) — Kern vs. Ausspraegung: ein Code ist kein Ja/Nein. Stufe 3
  // = volle Signatur, 2 = ein Traeger umgeleitet, 1 = Signaturtraeger faellt
  // weg, Kern lebt auf Cap/Akzent/Druck weiter. 'verlust' benennt, WAS fehlt —
  // damit die Herleitung es sagen kann statt es zu verschweigen.
  stufe: 3 | 2 | 1;
  verlust: string[];
  compatible: boolean;
  umleitung: string | null;
  brand: string;   // objektiver Label-Fakt vom Referenzbild (Tagger)
  produkt: string; // gesetzt, wenn Konfliktregel Typ B umgeleitet hat
  // v27 — Agentursprache: die kuratierte Prosa des Codes plus die beiden
  // inhaltlichen Achsen. Gehen als Behauptungs-Material ins Frontend; der
  // Render benutzt sie NICHT (keine Prompt-Aenderung, kein Bild-Effekt).
  wirkungBeschreibung: string | null;
  wirkstoffWelt: string[];
  zielgruppe: string[];
};

// Feldnamen-Fallback: die drei neuen Felder werden hier zum ersten Mal
// gelesen. Statt eine Schreibweise zu raten und still null zu liefern,
// probieren wir die plausiblen Namen durch — ein falsch geratener Name
// waere ein lautloser Ausfall, genau wie das leere Status-Feld.
function fieldAny(f: any, names: string[]): any {
  for (const n of names) {
    const v = f[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

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
  reqSegment: string | null = null,
  forceCodeId: string | null = null,
  lautNudge: string | null = null,
  farbortNudge: 'koerper' | 'liquid' | null = null
): Promise<{ prompt: string; forbidden: string[]; concept: Concept }> {
  const [produktRegeln, farbpalettenAll, designCodesAll] = await Promise.all([
    airtableListAll(PRODUKT_REGELN_TABLE),
    airtableListAll(FARBPALETTEN_TABLE),
    airtableListAll(DESIGN_CODE_TABLE),
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

  // ── Design_Code: Aktiv-Filter + SF-Kompatibilitaets-Gate + Konfliktregel ─
  // Anforderungen (fordernde Hard Facts) treffen auf SF_/Material des Systems.
  // Wand gewinnt IMMER — aber Identitaet wird UMGELEITET, nie gestrichen:
  //   Typ B (Methoden-Konflikt): Body_Behandlung braucht Transparenz, Koerper
  //     kann nicht -> Ausdruck laeuft ueber vollfarbe_opak (Body_Hex opak).
  //   Typ A: genau EIN Akzent_Cue — bereits per Schema garantiert.
  // Cap-Anforderungen (cap_weiss/metallcap) sind per Recolor immer erfuellbar,
  // solange ein Cap existiert (Prompt B faerbt ihn deterministisch).
  const matGate = multiSelectNames(sysFields['Material']).join(' ').toLowerCase();
  const isGlassBody = /glas|glass/.test(matGate);
  const isPlasticGate = /pet|petg|pp|hdpe|acryl|surlyn|kunststoff|plastic/.test(matGate);
  const hasCap = !!capFields || fall !== 'A';

  // ── Dreistufiges Fähigkeits-Modell (05.08.) ──────────────────────────
  // производ-truth: eine Fähigkeit ist bestätigt / unbekannt / ausgeschlossen.
  // Quelle sind die belegpflichtig getaggten SF_-Felder (SF-Beleg-Pass ueber
  // Screenshot_Rohtext) — NICHT mehr aus dem Material geraten. Ausnahme:
  // Kunststoff-Einfaerbung ist industriell universell (Masterbatch) -> gilt
  // ohne Textbeleg als bestaetigt. Glas-Einfaerbung/-Lackierung/-Mattierung
  // dagegen ist lieferantenspezifisch: ohne Beleg = unbekannt (nie geraten).
  const confirmed = new Set(multiSelectNames(sysFields['SF_Bestätigt']).map(s => s.toLowerCase()));
  const excluded  = new Set(multiSelectNames(sysFields['SF_Ausgeschlossen']).map(s => s.toLowerCase()));
  type CapState = 'ok' | 'unknown' | 'excluded';
  // Fasst Einfaerben + Lackieren zu "Koerper faerbbar" zusammen (zwei Wege,
  // ein Ziel: farbiger Koerper). Plastik = immer ok.
  const koerperFarbe = (): CapState => {
    // Reihenfolge ist die Aussage: ein explizites "geht nicht" des Lieferanten
    // schlaegt jede Material-Vermutung. Vorher stand isPlasticGate ZUERST und
    // hat SF_Ausgeschlossen bei Plastikteilen lautlos ueberschrieben.
    if (excluded.has('einfaerbbar') && excluded.has('lackierbar')) return 'excluded';
    if (confirmed.has('einfaerbbar') || confirmed.has('lackierbar')) return 'ok';
    if (isPlasticGate) return 'ok';
    return 'unknown';
  };
  const capState = (cap: string): CapState => {
    if (confirmed.has(cap)) return 'ok';
    if (excluded.has(cap)) return 'excluded';
    return 'unknown';
  };
  const checkAnforderung = (a: string): CapState => {
    switch (a) {
      case 'braucht_einfaerbbar': return koerperFarbe();
      case 'braucht_opak':        return isGlassBody ? koerperFarbe() : 'ok';
      case 'braucht_frostbar':    return isPlasticGate ? 'ok' : capState('mattierbar');
      case 'braucht_klarglas':    return isGlassBody ? 'ok' : 'excluded';
      case 'braucht_cap_weiss':
      case 'braucht_metallcap':   return hasCap ? 'ok' : 'excluded';
      default: return 'ok';
    }
  };
  const TRANSPARENT_BEHANDLUNG = ['klar', 'frosted', 'getönt', 'getoent', 'klar_liquid_farbe'];
  const designCodes: DesignCodeRec[] = designCodesAll
    .filter(r => selectName(r.fields['Status']) === 'Aktiv')
    .map(r => {
      const f = r.fields;
      const anford = multiSelectNames(f['Anforderungen']);
      const states = anford.map(a => ({ a, s: checkAnforderung(a) }));
      let bodyBehandlung = (selectName(f['Body_Behandlung']) || 'opak_recolor').toLowerCase();
      let farbort = (selectName(f['Farbort']) || 'koerper').toLowerCase();
      let umleitung: string | null = null;

      // AUSGESCHLOSSEN gewinnt immer: der Lieferant sagt explizit "geht nicht"
      // -> Code fuer dieses System nicht waehlbar. Keine Umleitung.
      const hardExcluded = states.filter(x => x.s === 'excluded').map(x => x.a);

      // UNBEKANNT bei Koerper-Farbe: производ-safe umleiten statt behaupten.
      // WICHTIG: Trigger ist, was der Code TUT (Koerper toenen/faerben), nicht
      // ob eine 'braucht_einfaerbbar'-Anforderung gesetzt ist — ein getoenter
      // Glaskoerper braucht Koerper-Faerbbarkeit unabhaengig von der Anford.-Liste.
      const unknown = states.filter(x => x.s === 'unknown').map(x => x.a);
      const wantsBodyColor = ['getönt', 'getoent', 'opak_recolor'].includes(bodyBehandlung)
        && farbort === 'koerper';
      const bodyColorState = koerperFarbe();
      if (wantsBodyColor && bodyColorState === 'unknown') {
        // Farbe in die FLUESSIGKEIT: klares Gebinde kann jeder liefern, die
        // Fluessigkeitsfarbe ist die Formel der Marke. Grün überlebt, ehrlich.
        bodyBehandlung = 'klar_liquid_farbe';
        farbort = 'liquid';
        umleitung = `Typ B: Koerper-Faerbbarkeit unbestaetigt -> Farbe in die Fluessigkeit umgeleitet, Gebinde bleibt klar (Machbarkeit per Muster bestaetigen)`;
      } else if (wantsBodyColor && bodyColorState === 'excluded') {
        // Lieferant sagt explizit "nicht faerbbar" -> auch Fluessigkeits-Umleitung
        // ist ehrlich (klares Gebinde), aber als harte Info kennzeichnen.
        bodyBehandlung = 'klar_liquid_farbe';
        farbort = 'liquid';
        umleitung = `Typ B: Koerper NICHT faerbbar (Lieferant) -> Farbe in die Fluessigkeit umgeleitet, Gebinde bleibt klar`;
      }
      // ── v34 — Ausspraegungs-Kaskade statt Rauswurf ────────────────────
      // Fehlt ein Traeger, stirbt nicht der Code, sondern eine Stufe seines
      // Ausdrucks. Abstufung VERLANGT WENIGER vom Teil als das Original —
      // sie kann also nie etwas Unproduzierbares versprechen.
      let stufe: 3 | 2 | 1 = umleitung ? 2 : 3;
      const verlust: string[] = [];
      if (umleitung) verlust.push('Körperfarbe — die Farbe sitzt jetzt in der Flüssigkeit, das Gebinde bleibt klar');

      // Mattierung nicht belegt -> Frost faellt, Rest bleibt (vorher: Rauswurf).
      if (bodyBehandlung === 'frosted' && checkAnforderung('braucht_frostbar') !== 'ok') {
        bodyBehandlung = isGlassBody ? 'klar' : 'opak_recolor';
        stufe = 1;
        verlust.push('mattierte Oberfläche — dieses Teil ist nicht belegt mattierbar, der Körper bleibt glatt');
      }
      // Code lebt von Durchsicht, Teil ist kein Glas -> Transparenz faellt,
      // Farbe/Akzent/Druck tragen die Haltung weiter (vorher: Rauswurf).
      if (anford.includes('braucht_klarglas') && !isGlassBody) {
        if (TRANSPARENT_BEHANDLUNG.includes(bodyBehandlung)) { bodyBehandlung = 'opak_recolor'; farbort = 'koerper'; }
        stufe = 1;
        verlust.push('durchsichtiger Körper — dieses Teil ist nicht aus Glas, die Haltung läuft über Farbe, Verschluss und Druck');
      }
      // Ohne Cap kann eine Cap-Anforderung durch nichts ersetzt werden — das
      // ist der einzige verbliebene echte Ausschlussgrund.
      const blockingUnknown: string[] = [];
      // Die Umleitung LOEST Koerper-Farb-Anforderungen (Farbe sitzt jetzt in
      // der Fluessigkeit, das klare Gebinde kann jeder liefern). Sie duerfen
      // den Code nicht mehr blockieren — sonst ist die Umleitung tote Logik.
      // Was die Kaskade aufgeloest hat, darf nicht mehr sperren.
      const geloest = new Set<string>(umleitung ? ['braucht_einfaerbbar', 'braucht_opak'] : []);
      if (stufe === 1) { geloest.add('braucht_klarglas'); geloest.add('braucht_frostbar'); geloest.add('braucht_einfaerbbar'); geloest.add('braucht_opak'); }
      const remaining = [...hardExcluded, ...blockingUnknown].filter(a => !geloest.has(a));
      return {
        id: r.id,
        name: String(f['Name'] || ''),
        segments: multiSelectNames(f['Segment']),
        bodyBehandlung,
        farbort,
        bodyHex: String(f['Body_Hex'] || '').trim() || null,
        capHex: String(f['Cap_Hex'] || '').trim() || null,
        capFinish: (selectName(f['Cap_Finish']) || 'matt').toLowerCase(),
        finishBody: (selectName(f['Finish_Body']) || 'matt').toLowerCase(),
        akzentCue: (selectName(f['Akzent_Cue']) || 'kein').toLowerCase(),
        akzentHex: String(f['Akzent_Hex'] || '').trim() || null,
        ausdrucksweg: (selectName(f['Ausdrucksweg']) || '').toLowerCase(),
        typoHaltung: (selectName(f['Typo_Haltung']) || '').toLowerCase(),
        szeneId: String(f['Szene_ID'] || '').trim(),
        // Achsen-Cursor: Temp_Laut als numerische Koordinate. null = ungetaggt
        // -> nimmt an keiner Nudge-Wahl teil (rastet nie versehentlich ein).
        tempLaut: (f['Temp_Laut'] != null && f['Temp_Laut'] !== '') ? Number(f['Temp_Laut']) : null,
        // Register = die real getaggte Welt-Achse (clean-minimal, tech-premium, ...).
        // Ankert die Nudge-Nachbarschaft. (Hinweis 02.09.: Segment ist inzwischen
        // 35/35 getaggt — der alte Kommentar 'Segment-Feld ist leer' war veraltet.)
        register: (selectName(f['Register']) || '').toLowerCase() || null,
        anforderungen: anford,
        stufe, verlust,
        compatible: remaining.length === 0,
        umleitung,
        brand: String(f['Brand'] || '').trim(),
        produkt: String(f['Produkt'] || '').trim(),
        wirkungBeschreibung: (() => {
          const v = fieldAny(f, ['Wirkung_Beschreibung', 'Wirkung_Beschreibung ', 'Wirkungsbeschreibung']);
          return v ? String(v).trim() : null;
        })(),
        wirkstoffWelt: multiSelectNames(fieldAny(f, ['Wirkstoff_Welt', 'Wirkstoff-Welt', 'Wirkstoff'])),
        // Zielgruppe == das Feld 'Segment' der Codes (Klinisch_Derma, GenZ_DTC,
        // Clean_Botanical, Quiet_Luxury). Wird oben schon als `segments`
        // gelesen — hier nur unter sprechendem Namen weitergereicht.
        zielgruppe: multiSelectNames(f['Segment']),
      };
    });

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
  if (capState('mattierbar') === 'ok' || isPlasticBody) finishes.push('matt', 'soft_touch');
  const akzente: string[] = ['none'];
  if (confirmed.has('hotfoil')) akzente.push('hot_foil_detail');
  if (confirmed.has('siebdruck')) akzente.push('silkscreen_graphic');
  // Leere Checkbox = ungetaggt, nicht "nein". Kunststoff ist industriell immer
  // einfärbbar (Masterbatch) → default true; Glas/Metall nur bei explizitem Tag.
  const colorable = koerperFarbe() === 'ok';
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
  // v31 — Referenzmarke als Kern-Anker: kompatibel -> bevorzugen; nicht
  // kompatibel -> naechster Code derselben Welt, und die Herleitung nennt,
  // was auf diesem Teil wegfiel (Kern bleibt, Ausdruck sinkt).
  const referenzen = findeReferenzen(brief, designCodes);
  const refZeilen = referenzen.map(r => `  · "${r.brand}" = code "${r.name}" (id ${r.id}, segment ${r.segments.join('/') || '?'}, world ${r.register || '?'}, loudness ${r.tempLaut ?? '?'}/10)${r.compatible ? '' : ' — NOT producible on this exact part'}`).join('\n');
  const referenzHinweis = referenzen.length ? ` BRANDS NAMED IN THE BRIEF (our archive knows them):
${refZeilen}
  READ THE POLARITY yourself from the brief.
  LOVED brand = the COMPASS. Its code is a hard preference: pick it if it is a candidate. If it is not (not producible, or its segment differs from the chosen one), pick the candidate that carries the SAME CORE — its treatment, cap relation, typo attitude and ingredient stance — and tune the expression toward the brief's positioning. Say in herleitung which signature details of the compass fall away here and why (core attitude stays, expression shifts).
  REJECTED brand = SUBTRACT ITS DISTINGUISHING TRAITS, never its whole world. The customer rejects what makes that brand specific (e.g. candy colour, playful shapes, teen-loud tone), not every code that happens to share its register. A code in the same world is fine as long as it does not carry the rejected traits. NEVER pick the rejected brand's own code.
  If unsure of the polarity, ignore the brand rather than guessing.` : '';
  // P1/P2 — der Kompass darf nicht eine Stufe frueher aussortiert werden:
  // sein Segment geht in die Segment-Wahl ein, statt erst bei der Code-Wahl
  // auf eine bereits gefallene Entscheidung zu treffen.
  const kompassSegmente = Array.from(new Set(referenzen.flatMap(r => r.segments))).filter(Boolean);
  const segmentHinweis = referenzen.length ? ` The brief names brands our archive knows: ${referenzen.map(r => `"${r.brand}" sits in segment ${r.segments.join('/') || '?'}`).join('; ')}. If the customer LOVES one of them, its segment is the default choice. Deviate only if the brief's own positioning clearly contradicts it — and if the loved brand's segment and the stated positioning differ (e.g. a clinical/apothecary brand for a prestige shelf), that gap IS the position: choose the segment that lets the compass's credibility be expressed in the stated tone, and say so in herleitung.${kompassSegmente.length ? ` Compass segments present: ${kompassSegmente.join(', ')}.` : ''}` : '';
  const segmentStep = requestedSegment
    ? `WORLD (fixed by the user): ${requestedSegment}. Set "segment" to exactly this. Every palette below already belongs to this world.`
    : `STEP 0 — segment: choose EXACTLY ONE world from [${worldsAvail.join(', ')}] that the brief's positioning belongs to.${segmentHinweis} In STEP 2 you may ONLY pick a palette whose "seg" contains this chosen segment.`;

  // Design-Code-Kandidaten: nur kompatible (inkl. Typ-B-umgeleitete).
  // Segment-Feinfilter macht Haiku selbst (Instruktion) + harte Validierung danach.
  const codeCandidates = designCodes.filter(c => c.compatible);
  if (codeCandidates.length === 0) throw new Error('Kein kompatibler aktiver Design_Code vorhanden');
  // v28 (§7.4): Wirkstoff-Welt + Wirkung_Beschreibung reisen pro Kandidat in
  // den Selection-Prompt. Haiku sieht damit die reale Regalwirkung jedes
  // Codes (kuratierte Prosa) statt nur Hex-Werte — und die Herkunfts-Welt,
  // gegen die die INGREDIENT RULE prüft. Prosa auf 130 Zeichen gekappt:
  // bei ~30 Kandidaten bleibt der Prompt klein.
  const designCodeList = codeCandidates.map(c =>
    `- code_id: ${c.id} | seg: ${c.segments.join('/') || '-'} | ${c.name} | body: ${c.bodyBehandlung}/${c.farbort}${c.bodyHex ? ` ${c.bodyHex}` : ''} | cap: ${c.capHex || 'preserve'} ${c.capFinish} | akzent: ${c.akzentCue} | typo: ${c.typoHaltung || '-'}${c.stufe < 3 ? ` | expression level ${c.stufe}/3 (lost: ${c.verlust.join('; ')})` : ''}${c.wirkstoffWelt.length ? ` | wirkstoff: ${c.wirkstoffWelt.join('/')}` : ''}${c.wirkungBeschreibung ? ` | wirkung: ${c.wirkungBeschreibung.slice(0, 130)}` : ''}${c.umleitung ? ' | (umgeleitet)' : ''}`
  ).join('\n');

  const selectionPrompt = `You are ulba's design-selection engine for beauty packaging.
You NEVER write a visual prompt and NEVER invent materials, shapes, ingredients, actives, scents or claims.
You only SELECT from the finite options below and write a short German concept grounded in the brief.

PRODUCT (fixed, never changed): ${type} | ${material.join(', ')} | ${form}
${desc ? String(desc).slice(0, 200) : ''}
${closureCoverage.length ? `CLOSURE (fixed): ${closureCoverage.join(', ')}` : ''}

${segmentStep}
STEP 1 — ziel_profil: choose 3–5 tags ONLY from: [${emotionTagSet.join(', ')}]. They must express the brief's audience/mood.
AUDIENCE RULE (hard): the palette MUST fit the audience in the brief. Feminine / curls / warm / natural briefs get warm or soft palettes — NEVER tech/chrome/futurist palettes. Masculine/tech briefs get cool restrained palettes. When in doubt, choose the softer, warmer palette.
STEP 2 — palette_id: exactly one id from PALETTES below whose "seg" contains your chosen segment AND whose tags/warmth/prestige best fit ziel_profil AND the audience rule.
PALETTES:
${paletteList}
STEP 3 — finish: one of [${finishes.join(', ')}].
STEP 4 — akzent: one of [${akzente.join(', ')}].
STEP 4b — code_id: choose EXACTLY ONE curated design code from DESIGN CODES below.${referenzHinweis} Its "seg" must contain your chosen segment. Pick the code whose design attitude (treatment, cap relation, accent, typo) best serves the brief's positioning — the code is the design DECISION; body colour, cap colour and accent will all be taken from it so the result is coherent by construction. INGREDIENT RULE (hard): if the brief names an active or ingredient world (vitamin c, retinol, hyaluron, barrier, acne, botanical, sun, hair, fragrance), you MUST prefer a code whose "wirkstoff" contains that world when one is available — a vitamin-c brief must never land on a retinol-world code while a vitamin-c code is listed. Use each code's "wirkung" prose to judge its real shelf effect and ground your herleitung in it. Codes marked (umgeleitet) still work on this product via a redirected expression — they remain valid choices.
EXPRESSION LEVEL: a code marked "expression level 2/3" or "1/3" is still a valid, honest choice — its core attitude survives, only part of its signature cannot be built on this exact part. Prefer level 3 when the fit is equal, but NEVER reject the compass brand's code just because its level is lower. Whenever you choose a code below level 3, the herleitung MUST name in plain German what falls away here (use the "lost:" text) — e.g. "Pink Play, hier in der ruhigen Ausprägung: Rosa und die reduzierte Typo bleiben, der Kugelverschluss und die Transparenz gehen auf einer Glas-Pumpflasche nicht."
DESIGN CODES:
${designCodeList}
STEP 5 — szene_id: one of [${SCENE_PRESETS.map(s => s.id).join(', ')}]. DEFAULT to 'studio_soft' or 'highkey_bright' (clean e-commerce packshot) unless the brief explicitly asks for a dark/moody/editorial setting.
STEP 6 — brandname: if the brief contains the user's own brand name, use it EXACTLY; otherwise INVENT a fictional name (2–8 letters, evocative). NEVER a real existing brand or car brand.
STEP 7 — konzept_name (1–3 words), story (ONE German sentence — NEVER name ingredients, actives, vitamins, scents or claims unless that exact word is in the brief), herleitung (ONE German sentence: why the chosen design direction fits the ziel_profil — describe the mood/finish in general words, NEVER name a specific palette, material, metal, chrome or technique that was not selected). IF the brief named a loved brand and you did NOT choose its code, the herleitung MUST say so in plain German and give the reason — name the brand, what you kept of it, and what you followed instead (e.g. "Weleda sitzt im Apotheken-Regal, du willst Prestige — ich halte Weledas Nüchternheit, gebe ihr aber den leiseren, schwereren Ton des Prestige-Regals"). Silently ignoring the compass is forbidden.
STEP 9 — kette: 2–3 rows that show HOW you derived the direction FROM THE BRIEF. One row per brief signal — audience/positioning, channel/shelf, named reference. Never a row about ingredient, material or physics (the engine writes those itself). Each row: {"bedeutung": what the brief said, 3–7 German words}, {"form": the design consequence, 3–7 German words}, {"weil": ONE short German clause that names the PROBLEM this solves — not a mood}. A professional brief never states taste, it states a problem being solved. Example: {"bedeutung":"Douglas-Kundin, kein Drogerie-Regal","form":"schwerer Ton, gedeckte Sättigung","weil":"im Prestige-Regal liest sich Buntheit als billig"}.
STEP 10 — verworfen: the ONE other design code from the list you seriously considered and then rejected. {"code_id": its id, "grund": ONE short German clause saying what would have gone wrong — grounded in the brief's audience or channel, never "passt nicht"}. Example: {"grund":"deine Douglas-Kundin liest das als Teen-Ware"}. If genuinely only one code is viable, set verworfen to null.
STEP 8 — radar: score the TARGET emotional direction of this product on each axis 0–100 (integers): waerme, prestige, energie, ruhe, natuerlichkeit, praezision. These express where the brief wants to land, not the bare bottle.

OUTPUT ONLY this JSON, no fences, no prose:
{"segment":"…","ziel_profil":["…"],"palette_id":"…","finish":"…","akzent":"…","code_id":"…","szene_id":"…","brandname":"…","konzept_name":"…","story":"…","herleitung":"…","kette":[{"bedeutung":"…","form":"…","weil":"…"}],"verworfen":{"code_id":"…","grund":"…"},"radar":{"waerme":0,"prestige":0,"energie":0,"ruhe":0,"natuerlichkeit":0,"praezision":0}}`;

  const res = await fetchT('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    timeoutMs: 30000, label: 'anthropic haiku',
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1000,
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
  // Code-Wahl HART validieren: nur Kandidaten; Segment-Fehlwahl schnappt zurueck
  // auf einen Code der effektiven Welt; letzter Fallback = erster Kandidat.
  // forceCodeId (Frontend: der geklickte Look) schlaegt Haikus Wahl — sofern
  // der Code fuer dieses Base ueberhaupt kompatibel ist. Ist er es NICHT,
  // brechen wir sichtbar ab statt still auf einen anderen Look zu kippen
  // (der "immer Pink"-Bug): der Nutzer hat einen bestimmten Look gewaehlt,
  // ein anderer Look waere eine Luege.
  const forcedCode = forceCodeId ? codeCandidates.find(c => c.id === forceCodeId) : null;
  if (forceCodeId && !forcedCode) {
    const wanted = designCodes.find(c => c.id === forceCodeId);
    throw new Error(`Look "${wanted?.name || forceCodeId}" ist auf diesem Teil nicht produzierbar (Anforderung unbestätigt/ausgeschlossen)`);
  }

  // ── Anker-Welt fuer Pool + Cursor + Nachbarschaft ─────────────────
  // BUGFIX: Ist ein Code gepinnt/geforced (Direction-Chip ODER Nudge), definiert
  // DESSEN Welt die navigierbare Nachbarschaft — NICHT Haikus pro Call neu
  // gewuerfelte Welt-Wahl. Sonst sucht der Nudge den leiseren Nachbarn im
  // falschen Weltpool ("leiser tut nichts") und graut die Chips falsch aus.
  const navWorld = (forcedCode?.segments[0]) || effectiveSegment;
  // P2 — der Kompass-Code bleibt im Pool, auch wenn sein Segment ein anderes
  // ist: zwischen zwei Segmenten liegt eine Position, kein Fehler.
  const kompassIds = new Set(referenzen.filter(r => r.compatible).map(r => r.id));
  const codeWorldPool = navWorld
    ? codeCandidates.filter(c => c.segments.includes(navWorld) || kompassIds.has(c.id))
    : codeCandidates;
  const codePool = codeWorldPool.length ? codeWorldPool : codeCandidates;

  // ── Achsen-Cursor · Prototyp Temp_Laut (WITHIN-WORLD) ─────────────
  // Ein Nudge verschiebt den Cursor NICHT um einen festen Betrag (bei duenner
  // Code-Dichte tut "−1" oft nichts, weil der eigene Punkt der naechste bleibt).
  // Stattdessen: Sprung auf den NAECHSTEN kuratierten Code IN Richtung
  // leiser/lauter — Punkt-zu-Punkt, nie Interpolation (der Zwischenraum ist
  // ungetesteter KI-Matsch, s. Konzept §3). Der Pool ist codePool: gleiche Welt,
  // kompatibel zur Base -> gleiche Flasche, ruhigerer/lauterer Look. Kein
  // Nachbar in Richtung -> No-Op (Chip ist frontendseitig ohnehin disabled).
  let cursorCode = forcedCode;
  // Nachbarschafts-Pool: Codes desselben REGISTERS (die befuellte Welt-Achse).
  // Das Segment-Feld der Codes ist leer, deshalb war "within-world" bisher
  // wirkungslos und der Nudge sprang ueber Welten (pink -> tech-klinisch).
  // Fix A (Welt-Sprung, 14.08.): Ist der Anker allein in seinem Register, gibt
  // es KEINEN globalen Fallback mehr — der Chip wird ausgegraut (No-Op) statt in
  // eine fremde Welt zu springen. Die grauen Chips sind ab jetzt die Landkarte
  // der Dichte-Luecken (-> Matrix-Diagnose + Code-Dichte, Roadmap-Punkt 2).
  const nudgeNeighborhood = (anchor: { id?: string; register: string | null } | null | undefined) => {
    if (anchor?.register) return codePool.filter(c => c.register === anchor.register);
    // Anker ohne Register -> keine identifizierbare Welt -> nur der Anker selbst.
    return anchor?.id ? codePool.filter(c => c.id === anchor.id) : codePool;
  };
  if (forcedCode && forcedCode.tempLaut != null && (lautNudge === 'quieter' || lautNudge === 'louder')) {
    const cur = forcedCode.tempLaut;
    const hood = nudgeNeighborhood(forcedCode);
    const cands = hood.filter(c =>
      c.tempLaut != null && (lautNudge === 'quieter' ? c.tempLaut < cur : c.tempLaut > cur)
    );
    cands.sort((a, b) =>
      lautNudge === 'quieter' ? (b.tempLaut! - a.tempLaut!) : (a.tempLaut! - b.tempLaut!)
    );
    if (cands[0]) cursorCode = cands[0];
  }

  const code = cursorCode || codePool.find(c => c.id === parsed?.code_id) || codePool[0];

  // Nachbar-Verfuegbarkeit fuer die Nudge-Chips — auf DERSELBEN Nachbarschaft
  // berechnet, in der der Nudge sucht (sonst luegen die Chips).
  const codeLaut = code.tempLaut;
  const codeHood = nudgeNeighborhood(code);
  const canQuieter = codeLaut != null && codeHood.some(c => c.tempLaut != null && c.tempLaut < codeLaut);
  const canLouder  = codeLaut != null && codeHood.some(c => c.tempLaut != null && c.tempLaut > codeLaut);
  const szeneId = SCENE_PRESETS.some(s => s.id === parsed?.szene_id)
    ? parsed.szene_id
    : (SCENE_PRESETS.some(s => s.id === code.szeneId) ? code.szeneId : 'studio_soft');
  const szene = SCENE_PRESETS.find(s => s.id === szeneId)!;
  const brandname = sanitizeBrandname(parsed?.brandname, brief);
  const zielProfil: string[] = Array.isArray(parsed?.ziel_profil)
    ? parsed.ziel_profil.filter((t: any) => emotionTagSet.includes(t)).slice(0, 5)
    : [];

  const palName = String(pal.fields['Name'] || '');
  const hex = parseJsonArray(pal.fields['Hex_Codes']).slice(0, 3);
  const pantone = parseJsonArray(pal.fields['Pantone_Nearest']).slice(0, 3);

  // v15-Kohaerenz (Fix 05.08.): die ANGEZEIGTE Palette (SpecSheet-Chips +
  // farbkonzept) kommt aus dem GEWAEHLTEN CODE — Body/Cap/Akzent-Hex —, nie
  // aus der separat von Haiku gewaehlten Farbpalette. Sonst zeigen die Chips
  // andere Farben als der Render (gruene Flasche, braune Chips). Die Farbpalette
  // bleibt Haikus Reasoning-Grundlage fuer ziel_profil/tags, ist aber nicht
  // mehr die Farbwahrheit. Pantone entfaellt beim Code-Pfad (Code hat keins);
  // spaeter liefert der Palette-LINK des Codes Pantone + Emotion_Tags mit.
  const codeHexes = [code.bodyHex, code.capHex, code.akzentHex].filter(Boolean) as string[];
  const displayHex = codeHexes.length ? codeHexes.slice(0, 3) : hex;
  const displayPalName = code.name || palName;
  const displayPantone = codeHexes.length ? [] : pantone;

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
  // ── Body-Behandlung: EINE Zeile, deterministisch aus dem Design_Code ─
  // (Kohaerenz-Kern: Body_Behandlung + Farbort + Body_Hex aus dem Record.)
  const codeBodyHex = code.bodyHex || hex[0] || '#EDEDED';
  const bodyFinishEn = BODY_FINISH_EN[code.finishBody] || BODY_FINISH_EN.matt;
  // Fuellfarbe fuer Farbort 'liquid': Body_Hex ist dort haeufig #FFFFFF (das
  // ist das GLAS, nicht das Serum) — dann traegt Akzent/Cap die echte Farbe.
  const istFarblos = (h: string | null) => {
    const m = /^#?([0-9a-f]{6})$/i.exec((h || '').trim());
    if (!m) return true;
    const n = parseInt(m[1], 16);
    const rr = (n >> 16) / 255, gg = ((n >> 8) & 255) / 255, bb = (n & 255) / 255;
    const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
    return mx === 0 ? true : (mx - mn) / mx < 0.15;
  };
  /* Welche Traeger kann DIESES Teil? koerper = Koerper faerbbar;
     liquid = Wand durchsichtig (Glas oder klares Plastik). */
  const klarFaehig = isGlassBody || /pet|petg|acryl|surlyn/.test(matGate);
  const farbortMoeglich = (_c: DesignCodeRec) => ({
    koerper: colorable || isPlastic,
    liquid: klarFaehig,
  });
  const codeBodyHexFuellung = istFarblos(code.bodyHex)
    ? (code.akzentHex && !istFarblos(code.akzentHex) ? code.akzentHex
       : code.capHex && !istFarblos(code.capHex) ? code.capHex : codeBodyHex)
    : codeBodyHex;
  /* v35 — Seitliche Ausspraegung. Punkt 11 kannte bisher nur ABWAERTS (ein
     Traeger faellt weg). Derselbe Code kann seine Farbe aber auch WOANDERS
     tragen, auf gleicher Hoehe: Pink Play als klare Flasche mit rosa Serum
     ODER als opake rosa Flasche. Beides ist Pink Play. Der Nudge wechselt nur
     den Traeger — Code, Farben und Haltung bleiben identisch. */
  let codeBodyBehandlung = code.bodyBehandlung;
  let codeFarbort = code.farbort;
  if (farbortNudge === 'koerper' && farbortMoeglich(code).koerper) {
    codeBodyBehandlung = 'opak_recolor'; codeFarbort = 'koerper';
  } else if (farbortNudge === 'liquid' && farbortMoeglich(code).liquid) {
    codeBodyBehandlung = 'klar_liquid_farbe'; codeFarbort = 'liquid';
  }
  const code2 = { ...code, bodyBehandlung: codeBodyBehandlung, farbort: codeFarbort };
  let bodyLineEn: string;
  switch (code2.bodyBehandlung) {
    case 'klar':
      // Farbort MUSS hier gelesen werden. Ein 'klar'-Code mit Farbort 'liquid'
      // (z.B. Pink Liquid: Body #FFFFFF, Cap+Akzent #FF007F, Farbe im Serum)
      // hat seine gesamte Lautstaerke in der Fluessigkeit — ohne diese Abfrage
      // fiel sie lautlos weg und der lauteste Code rendert als leere Flasche.
      bodyLineEn = code2.farbort === 'liquid'
        ? `Keep the body as clear transparent material exactly as in the reference image — do not tint or recolor the material itself. The bottle is filled with liquid in a saturated ${codeBodyHexFuellung}; the colour comes entirely from the contents and reads clearly through the clear wall, with a visible fill line near the shoulder.`
        : `Keep the body as clear transparent material exactly as in the reference image — do not tint or recolor it.`;
      break;
    case 'frosted':
      bodyLineEn = code2.farbort === 'liquid'
        ? `Give the body a satin frosted (sandblasted) surface. The liquid inside is ${codeBodyHex} and reads softly through the frosted wall. Do not recolor the material itself.`
        : `Give the body a satin frosted (sandblasted) ${codeBodyHex}-tinted surface — translucent, not opaque.`;
      break;
    case 'getönt':
    case 'getoent':
      bodyLineEn = `Tint the body translucent ${codeBodyHex} — the material stays see-through, like tinted glass.`;
      break;
    case 'klar_liquid_farbe':
      bodyLineEn = `Keep the body clear and transparent; the liquid inside is a clean ${codeBodyHex} and provides the colour. Do not tint the material itself.`;
      break;
    case 'opak_recolor':
    default:
      bodyLineEn = colorable || isPlastic
        ? `Recolor the body as one solid opaque ${codeBodyHex} with ${bodyFinishEn}, applied on the existing material.`
        : `Keep the ${matEN} body in its original tone — do not recolor it.`;
      break;
  }
  lines.push(bodyLineEn);
  if (code.capHex) {
    lines.push(`Color the closure/cap as ONE single solid ${code.capHex} tone with ${CAP_FINISH_EN[code.capFinish] || CAP_FINISH_EN.matt} — never the body colour on the cap.`);
  }
  const codeAkzentEn = akzentCueEn(code.akzentCue, code.akzentHex);
  if (codeAkzentEn) lines.push(`Add ${codeAkzentEn}.`);
  if (AKZENT_EN[akzent]) lines.push(`Add ${AKZENT_EN[akzent]}.`);
  // ── Rollen-Hierarchie als HARTE Render-Regel ───────────────────────
  // Sitzt der Traeger in der Fluessigkeit, wird die Huelle Materialeigenfarbe
  // -> der Cap ist dann der einzige chromatische Anker am Gebinde und traegt
  // mehr Last. Das ist eine ableitbare Regel, keine Geschmacksfrage.
  const traegerOrt = code2.farbort === 'liquid' ? 'Flüssigkeit' : 'Körper';
  const farbsys = farbSystem(
    code2.farbort === 'liquid' ? codeBodyHexFuellung : codeBodyHex,
    traegerOrt,
    code.capHex,
    code.akzentHex,
    code.akzentCue,
    !!capFields
  );
  if (farbsys.regelEn) lines.push(farbsys.regelEn);
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
    farbkonzept: `${displayPalName} — Hex: ${displayHex.join(', ')}${displayPantone.length ? ` · Pantone: ${displayPantone.join(', ')}` : ''}`,
    // Demand-Signal code-gruppierbar ("Ocean Clean 47x auf Serumflaschen").
    design_code: code.name,
    design_code_id: code.id,
    ...(code.umleitung ? { design_code_umleitung: code.umleitung } : {}),
  };

  const herleitung = String(parsed?.herleitung || '').trim();
  const rationale = [
    zielProfil.length ? `Zielprofil: ${zielProfil.join(' · ')}` : '',
    herleitung || `Die Farbwelt ${displayPalName} und ${FINISH_DE[finish]} folgen aus dem Brief.`,
  ].filter(Boolean).join(' — ');

  // ── Die Herleitungs-Leiter ────────────────────────────────────────
  // Arbeitsteilung: was die Engine WEISS, schreibt die Engine (Wirkstoff,
  // Physik, Farbprovenienz, Verlust) — deterministisch, nie halluziniert.
  // Was nur im Brief steht (Zielgruppe, Kanal, Referenz), schreibt Haiku.
  // Deshalb entsteht Tiefe OHNE eine einzige zusaetzliche Frage.
  type KetteZeile = { typ: string; bedeutung: string; form: string; weil: string };
  const kette: KetteZeile[] = [];

  // Typ 1 — Wirkstoff: die Engine kennt ihn aus dem Suchtext, sie fragt nie.
  if (code.wirkstoffWelt.length) {
    kette.push({
      typ: 'Wirkstoff',
      bedeutung: code.wirkstoffWelt.join(' · ').replace(/_/g, ' '),
      form: `Farbwelt ${displayPalName}`,
      weil: 'der Wirkstoff signalisiert die Farbe — sie ist Argument, nicht Dekor',
    });
  }

  // Aus dem Brief (Haiku) — Zielgruppe, Kanal, Referenz.
  const haikuKette = Array.isArray(parsed?.kette) ? parsed.kette : [];
  for (const z of haikuKette.slice(0, 3)) {
    const bedeutung = String(z?.bedeutung || '').trim();
    const form = String(z?.form || '').trim();
    const weil = String(z?.weil || '').trim();
    if (bedeutung && form) kette.push({ typ: 'Brief', bedeutung: bedeutung.slice(0, 80), form: form.slice(0, 80), weil: weil.slice(0, 160) });
  }

  // Typ 2 — Physik: die Wand des realen Teils. Kann keine Agentur wissen.
  kette.push({
    typ: 'Physik',
    bedeutung: `${matEN.replace(/^(a|an) /, '')}${closureCoverage.length ? `, ${closureCoverage.join('/')}` : ''}`,
    form: traegerOrt === 'Flüssigkeit' ? 'Farbe in die Flüssigkeit' : 'Farbe in den Körper',
    weil: traegerOrt === 'Flüssigkeit'
      ? 'das Gebinde bleibt transparent — die Hülle kann den Ausdruck nicht tragen'
      : 'der Körper ist belegt einfärbbar, also trägt er die Welt',
  });

  // Farbe ist relational, nicht absolut — und geerbt statt erfunden.
  // Ein Hex aus einem real produzierten Produkt ist STAERKER als ein
  // hergeleiteter: darum nennt diese Zeile Provenienz, nie "abgeleitet".
  if (code.brand) {
    const rollenTxt = farbsys.rollen.filter(r => r.hex).map(r => `${r.rolle} ${r.hex}`).join(' · ');
    kette.push({
      typ: 'Farbe',
      bedeutung: `Farbwelt aus ${code.brand}${code.produkt ? ` ${code.produkt}` : ''}`,
      form: rollenTxt || displayPalName,
      weil: 'real produziert, nicht geraten — am Regal bewiesen',
    });
  }

  // Ausprägung: was auf DIESEM Teil wegfällt, wird benannt statt verschwiegen.
  for (const v of code.verlust) {
    kette.push({ typ: 'Ausprägung', bedeutung: `Stufe ${code.stufe}/3`, form: v, weil: 'dieses Teil kann es nicht — die Haltung bleibt, der Träger wechselt' });
  }

  // Die verworfene Alternative: "Winning Concept" heisst, es gab mehrere.
  const vwRaw = parsed?.verworfen;
  const vwCode = vwRaw?.code_id ? codeCandidates.find(c => c.id === String(vwRaw.code_id)) : null;
  const verworfen = (vwCode && vwCode.id !== code.id && String(vwRaw?.grund || '').trim())
    ? { name: vwCode.brand ? `${vwCode.name} (${vwCode.brand})` : vwCode.name, grund: String(vwRaw.grund).trim().slice(0, 160) }
    : null;

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
    palette: { name: displayPalName, hex: displayHex, pantone: displayPantone },
    radar,
    zielprofil: zielProfil,
    segment: effectiveSegment,
    kette,
    verworfen,
    farbsystem: farbsys,
    design_code: {
      id: code.id, name: code.name, umleitung: code.umleitung, laut: codeLaut,
      brand: code.brand || null, produkt: code.produkt || null,
      stufe: code.stufe, verlust: code.verlust,
      farbort: codeFarbort,
      can_koerper: farbortMoeglich(code).koerper && codeFarbort !== 'koerper',
      can_liquid: farbortMoeglich(code).liquid && codeFarbort !== 'liquid',
      register: code.register, can_quieter: canQuieter, can_louder: canLouder,
      // v27 — Material fuer die Behauptung im Frontend.
      beschreibung: code.wirkungBeschreibung,
      wirkstoff_welt: code.wirkstoffWelt,
      zielgruppe: code.zielgruppe,
    },
    render: {
      bodyLineEn,
      capHex: code.capHex,
      capFinishEn: CAP_FINISH_EN[code.capFinish] || CAP_FINISH_EN.matt,
      akzentEn: akzentCueEn(code.akzentCue, code.akzentHex),
    },
  };

  return {
    prompt: `${visuell}\n\n${buildHardRule(fall, forbidden, code.typoHaltung, code.akzentHex)}`,
    forbidden,
    concept,
  };
}


// ── Main Handler ────────────────────────────────────────────────────
export const config = { api: { bodyParser: true }, maxDuration: 300 };

// ── v29 — Reflect: Rückspiegelung fürs geführte Briefing (Beat 1) ───────
// Deterministisch = Wahrheit (Register/Laut/Wirkstoff kommen berechnet vom
// Frontend), Haiku = Stimme. Ein kurzer Call — kein Airtable, kein fal.ai,
// kein Cache. Kein RENDER_VERSION-Bump: der Render-Output bleibt unberührt,
// also bleiben alle Bild-Cache-Keys gültig.
// ── v30 — Referenzmarke: der Brief nennt eine Marke, das Archiv KENNT sie ──
// "Biodance" ist bei uns "Pink Play". Der Treffer wird Kern-Anker der Welt;
// widerspricht er dem restlichen Brief, wird das BENANNT, nicht still entschieden.
type Marke = { name: string; polaritaet: 'liebt' | 'ablehnt' };
type Referenz = { brand: string; name: string; id: string; register: string | null; tempLaut: number | null; compatible: boolean; umleitung: string | null; segments: string[] };
/* Tippfehler kosten sonst das wichtigste Signal: "weloda" != "weleda".
   Distanz 1 ab 5 Zeichen, 2 ab 8 — eng genug, um Marken nicht zu verwechseln. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function markeTrifft(hay: string, marke: string): boolean {
  if (hay.includes(' ' + marke + ' ')) return true;
  const tol = marke.length >= 8 ? 2 : marke.length >= 5 ? 1 : 0;
  if (tol === 0) return false;
  const teile = marke.split(' ');
  const woerter = hay.trim().split(/\s+/);
  if (teile.length > 1) {
    for (let i = 0; i + teile.length <= woerter.length; i++) {
      if (levenshtein(woerter.slice(i, i + teile.length).join(' '), marke) <= tol) return true;
    }
    return false;
  }
  return woerter.some(w => Math.abs(w.length - marke.length) <= tol && levenshtein(w, marke) <= tol);
}
function findeReferenzen(brief: string, codes: Array<{ id: string; name: string; brand: string; register: string | null; tempLaut: number | null; compatible?: boolean; umleitung?: string | null; segments?: string[] }>): Referenz[] {
  const b = ' ' + brief.toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ') + ' ';
  const out: Referenz[] = [];
  const seen = new Set<string>();
  for (const c of codes) {
    const br = (c.brand || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();
    if (br.length < 3 || seen.has(br)) continue;
    if (markeTrifft(b, br)) {
      seen.add(br);
      out.push({ brand: c.brand, name: c.name, id: c.id, register: c.register, tempLaut: c.tempLaut, compatible: c.compatible !== false, umleitung: c.umleitung ?? null, segments: c.segments ?? [] });
    }
  }
  return out;
}
let codesCache: { t: number; v: Array<{ id: string; name: string; brand: string; register: string | null; tempLaut: number | null; segments: string[] }> } | null = null;
async function ladeCodesLeicht(): Promise<Array<{ id: string; name: string; brand: string; register: string | null; tempLaut: number | null; segments: string[] }>> {
  if (codesCache && Date.now() - codesCache.t < 300000) return codesCache.v;
  const rows = await airtableListAll(DESIGN_CODE_TABLE);
  const v = rows
    .filter((r: any) => (selectName(r.fields?.['Status']) || '') === 'Aktiv')
    .map((r: any) => ({
      id: r.id, name: String(r.fields['Name'] || ''), brand: String(r.fields['Brand'] || '').trim(),
      register: (selectName(r.fields['Register']) || '').toLowerCase() || null,
      tempLaut: (r.fields['Temp_Laut'] != null && r.fields['Temp_Laut'] !== '') ? Number(r.fields['Temp_Laut']) : null,
      segments: multiSelectNames(r.fields['Segment']),
    }));
  codesCache = { t: Date.now(), v };
  return v;
}

const REFLECT_REGISTER = ['clean-minimal', 'pharma-klinisch', 'natur-erdig', 'luxus-ritual', 'tech-premium', 'masse-funktional'];
const REFLECT_WORTE = ['ruhig', 'laut', 'warm', 'kühl', 'klinisch', 'natürlich', 'edel', 'verspielt', 'mutig', 'reduziert', 'technisch', 'alltagsnah'];
async function reflektiere(input: { brief: string; frage: string; register: string | null; laut: number | null; wirkstoff: string | null; runde: number; referenzen: Referenz[] }): Promise<{ lesart: string; weil: string; register: string | null; laut: number | null; worte: string[]; konflikt: string | null; marken: Marke[]; referenz: { brand: string; name: string; register: string | null } | null } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const lautWort = input.laut == null ? 'noch offen'
    : input.laut >= 7 ? 'laut' : input.laut >= 6 ? 'eher laut'
    : input.laut <= 3 ? 'sehr leise' : input.laut <= 4 ? 'eher leise' : 'ausgewogen';
  const system = `Du bist Kreativdirektorin einer renommierten Design-Agentur für Beauty-Verpackung. Ein Kunde brieft dich im Gespräch. Du spielst zurück, was du verstanden hast — kurz, warm, präzise, in seinen eigenen Worten, mit einem sichtbaren „weil".

ANKER (vom System berechnet, verbindlich — nicht widersprechen, nicht erfinden):
- Register/Welt: ${input.register || 'noch offen'}
- Lautstärke: ${lautWort}${input.laut != null ? ` (${input.laut}/10)` : ''}
- Wirkstoff/Produktwelt: ${input.wirkstoff || 'nicht genannt'}
- Gesprächsrunde: ${input.runde} von 3${input.referenzen.length ? `

MARKEN AUS UNSEREM ARCHIV (das ist unser Wissen — verbindlich):
${input.referenzen.map(r => `- "${r.brand}" = Design-Code "${r.name}" (Welt: ${r.register || 'unbekannt'}, Lautstärke ${r.tempLaut ?? '?'}/10).`).join('\n')}
ENTSCHEIDEND: Lies aus dem Brief, WELCHE Marke der Kunde liebt und welche er ABLEHNT ("X mag ich, Y nicht" heisst: X = Kompass, Y = Gegenteil). Nur die GELIEBTE Marke ist Kern-Anker für "register" — eine abgelehnte Marke ist NIE der Anker, ihre Welt ist eher zu meiden.
Erwähne in "lesart" kurz, dass du die Marken kennst. Trage jede genannte Marke in "marken" ein, mit korrekter Schreibweise UND Polarität.
SPANNT sich der Brief zwischen der geliebten Marke und der Positionierung (z.B. Kunde will Prestige/Luxus, seine Lieblingsmarke ist klinisch-nüchtern oder jung/Gen Z), dann ist das KEIN Widerspruch, den du dem Kunden zur Auflösung zurückgibst — das ist die Position selbst. Setze "konflikt" auf EINEN Satz, der wie eine Kreativdirektorin die MARKTPOSITION BENENNT, sie mit einer Referenz belegt, die der Kunde kennt, und ein Ja einholt. Nie eine Entweder-oder-Frage, nie zwei Optionen zur Auswahl.
BEISPIEL (Weleda + Prestige-Regal): "Ich höre Weledas Ehrlichkeit für eine Douglas-Kundin — das ist Apotheken-Luxus, die Ecke von Augustinus Bader und Barbara Sturm: wissenschaftlich glaubwürdig, aber fürs Prestige-Regal gekleidet. Soll ich dahin?"
Nenne eine reale Marke nur als Ortsangabe, nie als Vorlage zum Kopieren. Sonst konflikt = null.` : ''}

Die Anker sind aus wörtlichen Stichwörtern berechnet. Echte Sätze enthalten diese Wörter selten — steht ein Anker auf "noch offen", LIES ihn aus dem Sinn des Briefs und gib ihn unten zurück.

REGELN:
1. Bedeutungs-Ebene nur. NIE Farben, Finishes, Materialien, Veredelungen, Typografie oder konkrete Design-Lösungen nennen.
2. Zitiere oder spiegle die Worte des Kunden — er soll sich verstanden fühlen, nicht analysiert.
3. "lesart": EIN Satz, beginnt mit „Verstanden —". Die Verdichtung dessen, was er gesagt hat.
4. "weil": EIN Satz, beginnt mit „Weil". Die Konsequenz für die Richtung — nur laut/leise, ruhig/energisch, Nähe/Distanz, Ernst/Leichtigkeit. Keine Form.
5. Ist ein Anker „noch offen", behaupte ihn nicht — bleib bei dem, was da ist.
6. Keine Frage stellen. Keine Floskeln. Deutsch, du-Form.
7. "register": die Welt, in der die Marke spielt — GENAU einer dieser Werte oder null: ${REFLECT_REGISTER.join(' | ')}. Nur setzen, wenn der Brief es hergibt.
8. "laut": Lautstärke 0–10 (0 = Aesop-Flüstern, 5 = ausgewogen, 10 = Glossier-Pink-Schrei), oder null wenn unklar.
9. "worte": 1–4 Wörter NUR aus dieser Liste, die zum Brief passen: ${REFLECT_WORTE.join(', ')}. Leeres Array, wenn keines passt.
Bei 7–9 gilt: lieber null/leer als geraten.
10. "konflikt": null, ausser eine Referenzmarke widerspricht dem Brief (siehe oben) — dann EIN nachfragender Satz.
11. "marken": alle genannten Marken als Objekte {"name":"…","polaritaet":"liebt"|"ablehnt"} — Schreibweise korrigiert (z.B. "weloda" → "Weleda"). Leeres Array, wenn keine.

ANTWORTE NUR mit diesem JSON, ohne Fences, ohne Prosa:
{"lesart":"…","weil":"…","register":null,"laut":null,"worte":[],"konflikt":null,"marken":[{"name":"…","polaritaet":"liebt"}]}`;
  const user = `Frage, die ich gestellt habe: ${input.frage}\n\nBisheriger Brief des Kunden (alle Antworten): ${input.brief}`;
  try {
    const res = await fetchT('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
      timeoutMs: 15000, label: 'anthropic haiku reflect',
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 700, temperature: 0.4, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content: Array<{ text: string }>; stop_reason?: string };
    if (data.stop_reason === 'max_tokens') console.warn('[reflect] Antwort abgeschnitten — max_tokens zu klein');
    const raw = (data.content?.[0]?.text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
    const p = JSON.parse(raw);
    const lesart = typeof p?.lesart === 'string' ? p.lesart.trim() : '';
    const weil = typeof p?.weil === 'string' ? p.weil.trim() : '';
    if (!lesart || !weil) return null;
    const register = typeof p?.register === 'string' && REFLECT_REGISTER.includes(p.register) ? p.register : null;
    const lautRaw = typeof p?.laut === 'number' ? Math.round(p.laut) : null;
    const laut = lautRaw != null && Number.isFinite(lautRaw) ? Math.max(0, Math.min(10, lautRaw)) : null;
    const worte = Array.isArray(p?.worte) ? p.worte.filter((w: any) => typeof w === 'string' && REFLECT_WORTE.includes(w)).slice(0, 4) : [];
    const konflikt = typeof p?.konflikt === 'string' && p.konflikt.trim() ? p.konflikt.trim() : null;
    const marken: Marke[] = Array.isArray(p?.marken) ? p.marken
      .filter((m: any) => m && typeof m.name === 'string' && m.name.trim())
      .map((m: any) => ({ name: String(m.name).trim(), polaritaet: m.polaritaet === 'ablehnt' ? 'ablehnt' as const : 'liebt' as const }))
      .slice(0, 6) : [];
    const ref = input.referenzen[0] ? { brand: input.referenzen[0].brand, name: input.referenzen[0].name, register: input.referenzen[0].register } : null;
    return { lesart, weil, register, laut, worte, konflikt, marken, referenz: ref };
  } catch { return null; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── v29 — Reflect-Modus (Beat 1): nur die Stimme, keine Pipeline ──────
  if ((req.body as any)?.reflect === true) {
    const b = req.body as { brief?: string; frage?: string; register?: string | null; laut?: number | null; wirkstoff?: string | null; runde?: number };
    const brief = (b.brief || '').trim();
    if (!brief) return res.status(400).json({ error: 'brief ist erforderlich' });
    // Kennt unser Archiv eine genannte Marke? (leichter Loader, kein Gate noetig)
    let referenzen: Referenz[] = [];
    let alleCodes: Array<{ id: string; name: string; brand: string; register: string | null; tempLaut: number | null; segments: string[] }> = [];
    try { alleCodes = await ladeCodesLeicht(); referenzen = findeReferenzen(brief, alleCodes); } catch { referenzen = []; }
    const out = await reflektiere({
      brief, frage: (b.frage || '').trim(),
      register: b.register ?? null,
      laut: typeof b.laut === 'number' ? b.laut : null,
      wirkstoff: b.wirkstoff ?? null,
      runde: typeof b.runde === 'number' ? b.runde : 1,
      referenzen,
    });
    // Haiku aus → 200 mit null: das Frontend behält die deterministische Lesart.
    // Polaritaet entscheidet: nur die GELIEBTE Marke wird Anker. Haiku liefert
    // zugleich die korrigierte Schreibweise, deshalb hier der zweite Anlauf.
    let ref2: { brand: string; name: string; register: string | null } | null = null;
    let anti: { brand: string; name: string; register: string | null } | null = null;
    if (out?.marken?.length) {
      try {
        const alle = alleCodes.length ? alleCodes : await ladeCodesLeicht();
        const pick = (pol: 'liebt' | 'ablehnt') => {
          const namen = out.marken.filter(m => m.polaritaet === pol).map(m => m.name);
          if (!namen.length) return null;
          const t = findeReferenzen(' ' + namen.join(' ') + ' ', alle)[0];
          return t ? { brand: t.brand, name: t.name, register: t.register } : null;
        };
        ref2 = pick('liebt'); anti = pick('ablehnt');
      } catch { /* Archiv nicht erreichbar — Lesart bleibt gueltig */ }
    }
    return res.status(200).json({ reflect: true, lesart: out?.lesart ?? null, weil: out?.weil ?? null, register: out?.register ?? null, laut: out?.laut ?? null, worte: out?.worte ?? [], konflikt: out?.konflikt ?? null, referenz: ref2, antiReferenz: anti });
  }

  const {
    systemId,
    query,
    renderBrief = null,
    selectedCapId = null,
    tier = 'lite',
    segment = null,
    forceCodeId = null,
    lautNudge = null,
    farbortNudge = null,
    nocache = false,
    dryRun = false,
  } = req.body as {
    systemId: string;
    query: string;
    renderBrief?: string | null;
    selectedCapId?: string | null;
    tier?: Tier;
    segment?: string | null;
    forceCodeId?: string | null;
    lautNudge?: string | null;
    farbortNudge?: 'koerper' | 'liquid' | null;
    nocache?: boolean;
    // v27 — Behauptung ohne Bild: gleiche Ableitung, gleicher Code, kein
    // fal.ai-Call. Der teure Schritt bleibt hinter dem zweiten Klick.
    dryRun?: boolean;
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
    const key = cacheKey(systemId, effectiveBrief, selectedCapId, tier, segment, forceCodeId, lautNudge, farbortNudge);
    let cached: any[] = [];
    // Dev-Bypass: nocache=true ueberspringt das Cache-Lesen -> immer frischer Render.
    // dryRun liest den Cache nicht: der Cache haelt fertige BILDER. Wir
    // wollen hier nur die Ableitung, und die soll denselben Weg nehmen wie
    // beim echten Render — sonst behauptet der Screen etwas anderes als
    // das Bild danach zeigt.
    if (!nocache && !dryRun) try {
      cached = await airtableQuery(
        CACHE_TABLE,
        `{Cache_Key}='${key}'`,
        ['Cache_Key', 'Bild', 'Cap_Bild', 'Rendering_Prompt', 'Konzept_Name', 'Konzept_Story', 'Konzept_Rationale', 'Szene_ID', 'Produzierbar', 'Board'],
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
              design_code: board.design_code,
            }
          : null;

        return res.status(200).json({
          renderingUrl: cachedImg,
          capRenderingUrl: imgUrl(cf['Cap_Bild']) || null,
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
      capImageUrl = imgUrl(capRec.fields['Cap_Bild_Harmonisiert']) || imgUrl(capRec.fields['Cap_Bild']);
      if (!capImageUrl) throw new Error(`Cap ${capId} hat kein Bild`);
    }

    // ── 4. Render-Strategie ─────────────────────────────────────────
    // Fall C/D: Base und Cap NIE zusammen an Gemini geben — es zeichnet den
    // Fall C/D: Base und Cap werden GETRENNT recolort und GETRENNT angezeigt.
    // Nie zusammen an ein Modell (Drift), kein Compositing (Positionierung entfaellt).
    const useSplitRender = (fall === 'C' || fall === 'D') && !!capImageUrl;
    const promptFall: RenderFall = useSplitRender ? 'A' : fall;

    // ── 5. Assemble Rendering Prompt (Konzept-Brief) ────────────────
    const { prompt: renderingPrompt, forbidden, concept } =
      await assemblePrompt(effectiveBrief, promptFall, sys.fields, capFields, segment, forceCodeId, lautNudge, farbortNudge);

    // ── 5b. dryRun: Behauptung ausliefern, NICHT rendern ────────────
    // Die Ableitung ist komplett (Code gewaehlt, Konzept gebaut) — nur das
    // Bild fehlt. Ein Gehirn, zwei Ausgaenge: derselbe assemblePrompt-Lauf
    // liefert erst die Behauptung, beim zweiten Aufruf (ohne dryRun) das
    // Bild. Damit kann der Screen nie etwas anderes sagen als der Render.
    if (dryRun) {
      return res.status(200).json({
        dryRun: true,
        renderingUrl: null,
        capRenderingUrl: null,
        renderingPrompt: null,
        briefUsed: effectiveBrief,
        rejected: forbidden,
        capId: resolvedCapId,
        cached: false,
        fall,
        tier,
        concept,
      });
    }

    // ── 6. Render ───────────────────────────────────────────────────
    let renderingUrl: string;

    let capRenderingUrl: string | null = null;
    let capPromptUsed: string | null = null;

    if (useSplitRender) {
      // ZWEI GETRENNTE EINZELBILD-RECOLORS (Architektur 04.08.):
      // Einzelbild-Edit ist formtreu (bewiesen: Base App355, Cap Pipette+Gold).
      // Zwei Bilder zusammen an ein Modell = Drift (bewiesen, 2x reproduziert).
      // Base allein + Cap allein, parallel; beide Prompts zitieren DIESELBEN
      // Konzept-Werte -> Kohaerenz per Konstruktion. Kein Compositing, keine
      // Positionierung — Frontend zeigt den Cap in der eigenen Cap-Buehne.
      // ALLE Farb-/Finish-/Akzent-Werte kommen aus concept.render — d.h. aus
      // EINEM Design_Code-Record. Base-Prompt und Cap-Prompt zitieren dieselbe
      // Quelle -> Kohaerenz per Konstruktion (Beweis 3, Zielarchitektur 04.08.).
      const rc = concept.render || { bodyLineEn: 'Keep the body exactly as in the reference image.', capHex: null, capFinishEn: 'a clean matt finish', akzentEn: '' };
      const capHex = rc.capHex;
      const capFinishEn = rc.capFinishEn;
      const akzentLine = rc.akzentEn ? ` Add ${rc.akzentEn}.` : '';
      const baseOnlyPrompt = `${rc.bodyLineEn} Keep the exact same body shape, silhouette and proportions as the reference image. Preserve the exact narrow threaded neck exactly as in the reference image — same width, same threads, same shoulder; do NOT widen, flare, open up or reshape the neck. Do NOT add, draw, imply or attach any cap, closure, lid, dropper, pipette or pump anywhere on the bottle. Clean seamless white studio background, soft neutral lighting, centered. No label, sticker, text, logo or lettering anywhere.`;
      const capPreservePrompt = `Keep this closure EXACTLY as shown in the reference image — identical shape, identical parts, identical proportions, identical colour, identical material and finish. Do NOT recolor it, do NOT change anything about the closure itself. Only place it cleanly on a seamless white studio background with soft neutral lighting, centered. The image contains ONLY this closure exactly as in the reference; do NOT add, invent or draw any bottle, jar, vial, container, housing, sleeve, cylinder or chamber — the pump shaft or dip tube stays exactly as shown, nothing added around it. No text, no label, no logo, no lettering anywhere.`;
      const capRecolorPrompt = `Keep the exact same closure shape, silhouette, proportions and every individual part exactly as shown in the reference image — change ONLY the surface colour and finish. Color the closure as ONE single solid ${capHex} tone across the whole closure with ${capFinishEn}.${akzentLine} Do NOT split it into multiple colored segments and do NOT use more than this one accent on it. If any part is clear transparent glass in the reference image, keep that part clear — do not tint it. Do NOT add, remove, replace or restyle any part of the closure. Do NOT change its shape, proportions or size. The image contains ONLY this closure exactly as in the reference; do NOT add, invent or draw any bottle, jar, vial, container, housing, sleeve, cylinder or chamber that is not already in the reference image — the pump shaft or dip tube stays exactly as shown, nothing added around it. Clean seamless white studio background, soft neutral lighting, centered. No text, no label, no logo, no lettering anywhere.`;
      const capOnlyPrompt = capHex ? capRecolorPrompt : capPreservePrompt;

      const [baseUrl, capUrl] = await Promise.all([
        falEdit([primaryUrl], baseOnlyPrompt, FAL_BASE_ENDPOINT),
        falEdit([capImageUrl!], capOnlyPrompt, FAL_CAP_ENDPOINT).catch((e) => {
          // Cap-Recolor darf nie den Gesamt-Render killen: Fallback = Roh-Cap.
          console.error('Cap-Recolor fehlgeschlagen — zeige Roh-Cap:', e);
          return capImageUrl!;
        }),
      ]);
      renderingUrl = baseUrl;
      capRenderingUrl = capUrl;
      capPromptUsed = capOnlyPrompt;
    } else {
      const imgs = (fall === 'A' || !capImageUrl) ? [primaryUrl] : [primaryUrl, capImageUrl];
      renderingUrl = await geminiEdit(imgs, renderingPrompt);
    }

    // ── 7. AUSLIEFERN ZUERST, cachen danach (Hobby-60s-Haertung) ─────
    // Frueher: erst 4 Airtable-Writes, DANN antworten. Bei fal ~40s + Writes
    // ~8s riss die Funktion die 60s-Wand MITTEN im Cache-Schreiben -> Bild bei
    // fal fertig, aber Client bekam nie eine Antwort ("Failed to fetch") und
    // der Cache blieb leer. Jetzt: fal-URL sofort an den Client (fal-URLs leben
    // ~1h, reicht zum Anzeigen). Cachen laeuft als Best-Effort DANACH; killt
    // die 60s-Wand es, hat der Nutzer sein Bild trotzdem laengst.
    if (!res.headersSent) {
      res.status(200).json({
        renderingUrl,
        capRenderingUrl,
        renderingPrompt,
        briefUsed: effectiveBrief,
        rejected: forbidden,
        capId: resolvedCapId,
        cacheId: null,          // Cache laeuft noch — beim naechsten Treffer gesetzt
        cached: false,
        fall,
        tier,
        concept,
      });
    }

    // ── 8. Persistieren (Best-Effort, nach der Antwort) ─────────────
    // Ab hier darf ALLES scheitern, ohne den Nutzer zu betreffen — die Antwort
    // ist raus. Ein Fehler wird geloggt, nie geworfen. Beim naechsten identischen
    // Aufruf wird schlicht neu gerendert (Cache-Miss), bis ein Schreiben durchkommt.
    try {
    const imgBuffer: Buffer = Buffer.from(await (await fetchT(renderingUrl, { timeoutMs: 15000, label: 'fal img download' })).arrayBuffer());
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
            Rendering_Prompt: renderingPrompt, // Base-Prompt (Provenienz)
            Cap_Prompt: capPromptUsed || '', // Cap-Prompt (Provenienz, symmetrisch)
            // Konzept als eigene, auswertbare Felder (Demand-Signal / Provenienz).
            Konzept_Name: concept.konzept_name || '',
            Konzept_Story: concept.story || '',
            Konzept_Rationale: concept.rationale || '',
            Szene_ID: concept.szene_id || '',
            Produzierbar: concept.produzierbar ? JSON.stringify(concept.produzierbar) : '',
            Board: JSON.stringify({ label: concept.label, palette: concept.palette, radar: concept.radar, zielprofil: concept.zielprofil, design_code: concept.design_code }),
            Tier: tier,
            Fall: fall,
            Created_At: new Date().toISOString(),
          },
        }),
      }
    );

    let createData = await createRes.json() as { id: string; error?: any };
    // Haertung: unbekanntes Feld kippt NICHT mehr den ganzen Record. Airtable
    // nennt das fehlende Feld -> wir droppen es und versuchen EINMAL erneut.
    if (!createData.id && createData.error?.type === 'UNKNOWN_FIELD_NAME') {
      const m = String(createData.error?.message || '').match(/\"([^\"]+)\"/);
      const badField = m?.[1];
      if (badField) {
        console.warn(`Cache: unbekanntes Feld "${badField}" entfernt, retry.`);
        const retryBody = JSON.parse(JSON.stringify({ fields: {
          Cache_Key: key, System: [systemId], Query_Input: query,
          Rendering_Prompt: renderingPrompt, Cap_Prompt: capPromptUsed || '',
          Konzept_Name: concept.konzept_name || '', Konzept_Story: concept.story || '',
          Konzept_Rationale: concept.rationale || '', Szene_ID: concept.szene_id || '',
          Produzierbar: concept.produzierbar ? JSON.stringify(concept.produzierbar) : '',
          Board: JSON.stringify({ label: concept.label, palette: concept.palette, radar: concept.radar, zielprofil: concept.zielprofil }),
          Tier: tier, Fall: fall, Created_At: new Date().toISOString(),
        }}));
        delete retryBody.fields[badField];
        const retryRes = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` },
          body: JSON.stringify(retryBody),
        });
        createData = await retryRes.json() as { id: string; error?: any };
      }
    }
    if (!createData.id) {
      // Antwort ist laengst raus — Cache-Fehler nur loggen, nichts mehr senden.
      console.error('Cache-Record Fehler (Antwort war bereits ausgeliefert):', JSON.stringify(createData.error || createData));
      return;
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
      console.error('Airtable upload (Base) failed:', await uploadRes.text());
    }

    // Cap-Bild SYMMETRISCH zur Base als echten Anhang hochladen (Bytes, nicht
    // die temporaere fal-URL — die verfaellt). Non-fatal: scheitert der Upload,
    // wird der Render trotzdem ausgeliefert.
    if (capRenderingUrl) {
      try {
        const capBuf = Buffer.from(await (await fetchT(capRenderingUrl, { timeoutMs: 30000, label: 'fal cap download' })).arrayBuffer());
        const capUploadRes = await fetch(
          `https://content.airtable.com/v0/${AIRTABLE_BASE}/${createData.id}/${CACHE_CAP_IMAGE_FIELD}/uploadAttachment`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${process.env.AIRTABLE_PAT}`,
            },
            body: JSON.stringify({
              contentType: 'image/jpeg',
              file: capBuf.toString('base64'),
              filename: `cap_${resolvedCapId || 'cap'}_${Date.now()}.jpg`,
            }),
          }
        );
        if (!capUploadRes.ok) console.error('Airtable upload (Cap) failed:', await capUploadRes.text());
      } catch (e) {
        console.error('Cap-Upload fehlgeschlagen (Render wird dennoch ausgeliefert):', e);
      }
    }

    // Erfolgreich gecacht — Antwort war schon raus, hier gibt es nichts zu senden.
    } catch (cacheErr) {
      // Best-Effort-Cache gescheitert (z.B. 60s-Wand mitten im Upload). Nutzer
      // hat sein Bild; beim naechsten identischen Aufruf wird neu gerendert.
      console.error('Cache-Persist fehlgeschlagen (Antwort war bereits raus):', cacheErr);
    }
    return;
  } catch (err) {
    // Fehler VOR der Auslieferung (fal-Timeout, Airtable-Read, Assembly).
    // Nur hier darf noch ein 500 an den Client — sonst ist headersSent true.
    const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
    console.error('Render error:', message);
    if (!res.headersSent) return res.status(500).json({ error: message });
    return;
  }
}
