import { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'crypto';

/* ── render.ts v46 — der vereinfachte Renderer ────────────────────────────
   Produktstand heute: der Nutzer waehlt im Design-Raum EINEN Design_Code
   (forceCodeId ist immer gesetzt) und wendet ihn auf ein Teil an. Alles,
   was nur dem alten Mehr-Runden-Briefing diente, ist raus:
   kein Haiku-Call (die Code-Wahl trifft der Nutzer, nicht das LLM),
   kein dryRun, keine Nudges, kein Board, keine Referenzmarken-Suche,
   keine Farbpaletten-/Produkt_Regeln-Ladung, keine Szenen.
   Geblieben: das SF-Faehigkeitsmodell (Produzierbarkeit by construction),
   die deterministische Prompt-Assembly, das Farb-Rollensystem, der Cache.
   v46: Referenz_Bild wieder RAUS aus image_urls (Live-Test XTAG: Seedream
   uebernimmt Formen aus der Stil-Referenz — Geometrie-Kontamination;
   Detailtreue schlaegt alles). Stil kommt jetzt aus Design_Code.
   Render_Rezept: prompt-fertiger englischer Text, verbatim in den Prompt,
   VOR den mechanischen Farb-/Finish-Zeilen; leer -> heutiges Verhalten.
   Dazu haerterer Geometrie-Lock (strict recolor of the SAME object) und
   das Seitenverhaeltnis des Produktfotos statt 'auto'. */

// ── fetch mit hartem Timeout ──────────────────────────────────────────────
// Ohne dies wartet ein haengender externer Call (fal.ai / Airtable) bis
// Vercel die Funktion killt -> Client sieht nur "Failed to fetch". Mit
// Timeout bricht der einzelne Call ab und der Fehler NENNT den Dienst.
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
const DESIGN_CODE_TABLE = 'tbl24ezzCjRQDYRnJ';
const ATTRIBUT_TABLE = 'tblsWJ0q2sQ7sXwvk';
const WIRKSTOFF_TABLE = 'tblAzvL0t6GpyD8Ut';

// Cache-Version: bei JEDER Aenderung an Render-Logik/Prompt hochzaehlen.
// Fliesst in den Cache-Key -> alte Eintraege werden automatisch ungueltig.
const RENDER_VERSION = 'v46';
// EIN Modell fuer alles (A/B-Test 04.08.: Seedream hielt Detail + Matt-Haptik
// besser als Gemini). Multi-Image via image_urls[].
const FAL_SEEDREAM_EDIT = 'https://fal.run/fal-ai/bytedance/seedream/v5/lite/edit';

type Tier = 'lite' | 'pro';
type RenderFall = 'A' | 'B' | 'C' | 'D';

// Ein fal-Edit-Aufruf → Bild-URL. aspect_ratio: Preset aus dem Eingabefoto
// (aspectFromAttachment), 'auto' nur als letzter Fallback.
async function falEdit(imageUrls: string[], prompt: string, aspectRatio: string = 'auto'): Promise<string> {
  const r = await fetchT(FAL_SEEDREAM_EDIT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${process.env.FAL_API_KEY}` },
    body: JSON.stringify({ prompt, image_urls: imageUrls, aspect_ratio: aspectRatio }),
    timeoutMs: 120000, label: 'fal.ai edit',
  });
  if (!r.ok) throw new Error(`fal.ai edit: ${await r.text()}`);
  const d = await r.json() as { images?: Array<{ url: string }> };
  const url = d.images?.[0]?.url;
  if (!url) throw new Error('Kein Bild von fal zurückgekommen');
  return url;
}

// ── Helpers ─────────────────────────────────────────────────────────
function queryHash(q: string): string {
  return createHash('md5').update(q.toLowerCase().trim()).digest('hex').slice(0, 12);
}

function cacheKey(systemId: string, q: string, capId: string | null, tier: Tier, codeId: string | null): string {
  // RENDER_VERSION zuerst: aendert sich der Render-Code, aendert sich jeder Key.
  // codeId trennt verschiedene Looks auf DEMSELBEN Base+Query.
  return `${RENDER_VERSION}_${systemId}_${queryHash(q)}_${capId || 'none'}_${tier}${codeId ? `_c${codeId.slice(-6)}` : ''}`;
}

function imgUrl(attachmentField: any): string | null {
  if (Array.isArray(attachmentField) && attachmentField.length > 0) {
    return attachmentField[0].url || attachmentField[0].thumbnails?.full?.url || null;
  }
  return null;
}

// ── Seitenverhaeltnis aus dem Eingabefoto ───────────────────────────
// Airtable-Bildanhaenge tragen width/height. Der Render soll das Format
// des Produktfotos behalten (keine Beschnitt-/Streck-Artefakte); gemappt
// wird auf das naechstliegende fal-Preset (dasselbe Preset-Set, das der
// fruehere Gemini-Edit-Endpoint dokumentiert — Seedream teilt bei fal das
// I/O-Schema). 'auto' nur, wenn keine Masse vorliegen.
const FAL_RATIOS: Array<[string, number]> = [
  ['21:9', 21 / 9], ['16:9', 16 / 9], ['3:2', 3 / 2], ['4:3', 4 / 3],
  ['1:1', 1], ['3:4', 3 / 4], ['2:3', 2 / 3], ['9:16', 9 / 16],
];
function aspectFromAttachment(attachmentField: any): string {
  const a = Array.isArray(attachmentField) && attachmentField[0] ? attachmentField[0] : null;
  const w = Number(a?.width), h = Number(a?.height);
  if (!w || !h || !isFinite(w) || !isFinite(h)) return 'auto';
  const r = w / h;
  let best = 'auto', bestD = Infinity;
  for (const [name, v] of FAL_RATIOS) {
    const d = Math.abs(Math.log(r / v)); // log-Distanz: symmetrisch fuer Hoch/Quer
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
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
function determineFall(sys: any): { fall: RenderFall; primaryUrl: string; primaryAspect: string; hasMultipleCaps: boolean } {
  const attRoh = sys.fields['Bild_Roh_Base'];
  // Bild_Harmonisiert ist der bevorzugte Anker (neutrales Studio-Foto),
  // Bild_System nur Fallback. Fall C/D (Base+Cap) bleibt auf Roh_Base.
  const attSys = imgUrl(sys.fields['Bild_Harmonisiert']) ? sys.fields['Bild_Harmonisiert'] : sys.fields['Bild_System'];
  const bildRohBase = imgUrl(attRoh);
  const bildSystem = imgUrl(attSys);
  const caps = sys.fields['Caps'] as any[] | undefined;
  const capCount = caps?.length || 0;

  if (!bildRohBase && !bildSystem) throw new Error('Kein Bild vorhanden');

  if (bildSystem && capCount === 0) {
    return { fall: 'A', primaryUrl: bildSystem, primaryAspect: aspectFromAttachment(attSys), hasMultipleCaps: false };
  }
  if (bildSystem && !bildRohBase && capCount > 0) {
    return { fall: 'B', primaryUrl: bildSystem, primaryAspect: aspectFromAttachment(attSys), hasMultipleCaps: capCount > 1 };
  }
  if (bildRohBase && capCount === 1) {
    return { fall: 'C', primaryUrl: bildRohBase, primaryAspect: aspectFromAttachment(attRoh), hasMultipleCaps: false };
  }
  if (bildRohBase && capCount > 1) {
    return { fall: 'D', primaryUrl: bildRohBase, primaryAspect: aspectFromAttachment(attRoh), hasMultipleCaps: true };
  }
  if (bildRohBase && capCount === 0) {
    return { fall: 'A', primaryUrl: bildRohBase, primaryAspect: aspectFromAttachment(attRoh), hasMultipleCaps: false };
  }
  return { fall: 'A', primaryUrl: (bildSystem || bildRohBase)!, primaryAspect: aspectFromAttachment(bildSystem ? attSys : attRoh), hasMultipleCaps: false };
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

// Feldnamen-Fallback: statt eine Schreibweise zu raten und still null zu
// liefern, probieren wir die plausiblen Namen durch.
function fieldAny(f: any, names: string[]): any {
  for (const n of names) {
    const v = f[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

// ── Gates: Material + Closure ───────────────────────────────────────
// Der Brief (Suchtext) kann Materialien/Verschluesse nennen, die dieses Teil
// nicht hat — die landen als harte Verbote im Prompt (Demand-Signal bleibt).
type LexEntry = { label: string; en: string; tokens: string[] };

const MATERIAL_LEXICON: LexEntry[] = [
  { label: 'Bambus', en: 'bamboo', tokens: ['bambus', 'bamboo'] },
  { label: 'Holz', en: 'wood', tokens: ['holz', 'wood', 'wooden', 'timber', 'oak', 'eiche'] },
  { label: 'Kork', en: 'cork', tokens: ['kork', 'cork'] },
  { label: 'Papier', en: 'paper or cardboard', tokens: ['papier', 'paper', 'karton', 'cardboard', 'pappe'] },
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

/* ── Grafikebene (v33 — Linienwerk statt "Typografie") ─────────────────
   Worte wie "typography" liest das Bildmodell als Auftrag, Text zu SETZEN.
   Beschrieben wird nur GEOMETRIE: feine waagerechte Striche in Textzeilen-
   Anmutung — rendert als Etikett-Optik, ohne dass Buchstaben entstehen. */
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

/**
 * Hard-Rule wird IMMER im Code angehaengt — deterministisch, nie vom LLM.
 * FORM / MATERIAL / VERSCHLUSS / forbidden bleiben hart gesperrt (Invariante).
 * closureRule variiert pro Pfad (Vollbild A/B, Split-Base ohne Cap).
 */
function buildHardRule(closureRule: string, forbidden: string[], typoHaltung?: string | null, akzentHex?: string | null): string {
  return [
    'CRITICAL RULES — these override everything above.',
    // Geometrie-Lock (v46, Live-Test XTAG): Seedream formte den Pumpkopf um
    // und erfand Streifen. Deshalb explizit: gleiches physisches Objekt.
    'This is a strict recolor and restyle of the SAME physical object. Keep silhouette, proportions, wall thickness, shoulder, collar, and every step and part of the pump/closure EXACTLY as in the photo — identical geometry, identical mechanism. Change ONLY surface colour, finish and tint.',
    'Do not change the shape, silhouette, proportions or size of the packaging.',
    'Do not redesign the bottle: no angular, faceted, architectural, geometric or tapered body, no new silhouette, no different neck — the container outline must stay identical to the reference image.',
    'Do not add stripes, bars, lines, dots, patterns, badges or any other graphic element beyond what this prompt explicitly specifies.',
    closureRule,
    'Do not introduce any material that is not visible in the reference images or explicitly listed as available.',
    forbidden.length ? `Explicitly forbidden in this render: ${forbidden.join(', ')}.` : '',
    grafikRegel(typoHaltung, akzentHex),
    'STRICTLY FORBIDDEN on the product: any letter, character, digit, word, brand name, logo, trademark or crest. Never print words from these instructions onto the packaging — this text is a description, not label copy.',
    'Ground the product on the surface with a soft contact shadow — the product must never float.',
    'Softbox key light from the upper-left, subtle rim light, controlled speculars.',
    '100mm macro, f/8, commercial product photography, photorealistic.',
    'No hard shadows, no clutter, no oversaturation, no cheap plastic look.',
  ].filter(Boolean).join(' ');
}

// ── Enum-Uebersetzungen (deterministisch) ───────────────────────────
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
const BODY_FINISH_DE: Record<string, string> = {
  matt: 'Matt-Finish',
  glossy: 'Glanz-Finish',
  frosted: 'Satiniert (Frosted)',
  soft_touch: 'Soft-Touch-Matt',
};
const AKZENT_CUE_DE: Record<string, string> = {
  metallic_band: 'Metallband',
  gold_ring: 'Goldring',
  praegung: 'Prägung',
};
// Akzent_Cue -> genau EIN Premium-Cue. Hex aus Akzent_Hex, Default warmes Gold.
function akzentCueEn(cue: string, akzentHex: string | null): string {
  const hex = akzentHex || '#C9A24B';
  switch ((cue || '').toLowerCase()) {
    case 'metallic_band': return `a single thin polished ${hex} metallic band around the collar of the closure`;
    case 'gold_ring':     return `a single thin polished ${hex} ring around the collar of the closure`;
    case 'praegung':      return 'a single subtle embossed (debossed) detail, tone-on-tone, no colour';
    default: return '';
  }
}

// ── Farb-Mathematik + Rollensystem ──────────────────────────────────
//   Traeger      (Body_Hex,   ~70 %) traegt die WELT.
//   Gegenspieler (Cap_Hex,    ~25 %) gibt die zweite Lesart.
//   Signal       (Akzent_Hex, <=10 %) traegt das ARGUMENT.
// Regeln: Signal braucht physischen Traeger (Cue); Mono-Verbot mit Zahl
// (dE>=25 oder dL>=20); nur EINE Rolle laut; max. drei Farben.
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
  const cueEcht = !!akzentCue && akzentCue !== 'kein' && akzentCue !== 'none';
  if (akzentHex && hexRgb(akzentHex) && cueEcht) {
    rollen.push({ rolle: 'Signal', hex: akzentHex.toUpperCase(), ort: 'Akzent', cue: akzentCue });
  } else if (akzentHex && hexRgb(akzentHex) && !cueEcht) {
    warnungen.push('Akzentfarbe ohne Träger (kein Akzent_Cue) — die Farbe hat keine Fläche und fällt lautlos weg.');
  }
  const dE = deltaE(traegerHex, capHex);
  const lT = hexLab(traegerHex), lC = hexLab(capHex);
  const dL = (lT && lC) ? Math.abs(lT[0] - lC[0]) : null;
  if (dE != null && dL != null && dE < 25 && dL < 20) {
    warnungen.push(`Träger und Gegenspieler liegen zu nah (ΔE ${dE.toFixed(0)}, ΔL ${dL.toFixed(0)}) — das Teil liest sich einfarbig.`);
  }
  const dES = deltaE(capHex, akzentHex);
  if (dES != null && dES < 12 && rollen.some(r => r.rolle === 'Signal')) {
    warnungen.push('Gegenspieler und Signal sind fast dieselbe Farbe — das Signal verschwindet im Verschluss.');
  }
  const kand = rollen.filter(r => r.hex).map(r => ({ r, c: chromaOf(r.hex) }));
  const laut = kand.length ? kand.reduce((a, b) => b.c > a.c ? b : a).r : null;
  const lautName = laut && chromaOf(laut.hex) > 12 ? laut.rolle : null;
  if (kand.filter(k => k.c > 35).length > 1) {
    warnungen.push('Mehr als eine Rolle ist voll gesättigt — zwei laute Farben nebeneinander lesen sich als Zufall, nicht als Entscheidung.');
  }
  if (rollen.filter(r => r.hex).length > 3) warnungen.push('Mehr als drei Farben — die vierte ist Rauschen.');
  const regelEn = lautName
    ? `Colour hierarchy (hard): only the ${lautName === 'Träger' ? (traegerOrt === 'Flüssigkeit' ? 'liquid' : 'body') : lautName === 'Gegenspieler' ? 'closure' : 'accent'} carries full saturation; every other coloured element stays visibly muted and desaturated so it supports that one instead of competing with it. Never more than one loud colour.`
    : '';
  return { rollen, laut: lautName, warnungen, regelEn };
}

// ── Wirkstoff-Referenz — NUR fuer den {codes:true}-Branch (Design-Wand) ─
// Quelle: Airtable `Wirkstoffe`. Dient dem passend-Scoring der Wand; aus
// dem Render-Pfad ist die Tabelle raus (forceCodeId traegt die Entscheidung).
type WirkstoffRef = { name: string; keys: string[] };
let wirkstoffCache: { t: number; data: WirkstoffRef[] } | null = null;
async function ladeWirkstoffe(): Promise<WirkstoffRef[]> {
  if (wirkstoffCache && Date.now() - wirkstoffCache.t < 300000) return wirkstoffCache.data;
  const recs = await airtableListAll(WIRKSTOFF_TABLE);
  const teile = (v: any) => String(v || '').split(',').map((x: string) => x.trim()).filter(Boolean);
  const data: WirkstoffRef[] = recs
    .filter((r: any) => (selectName(r.fields['Status']) || 'aktiv').toLowerCase() === 'aktiv')
    .map((r: any) => ({
      name: String(r.fields['Name'] || '').trim(),
      keys: teile(r.fields['Keywords']).map((k: string) => k.toLowerCase()),
    }))
    .filter((w: WirkstoffRef) => !!w.name && w.keys.length > 0);
  // Laengstes Keyword zuerst: "vitamin c" schlaegt "vitamin a".
  data.sort((a, b) => Math.max(...b.keys.map(k => k.length)) - Math.max(...a.keys.map(k => k.length)));
  wirkstoffCache = { t: Date.now(), data };
  return data;
}
function wirkstoffTreffer(text: string, liste: WirkstoffRef[]): WirkstoffRef | null {
  const t = (text || '').toLowerCase();
  for (const w of liste) if (w.keys.some(k => t.includes(k))) return w;
  return null;
}

// ── Design_Code ─────────────────────────────────────────────────────
// Kohaerenz entsteht in der ENTSCHEIDUNG: Body-Farbe, Cap-Farbe, Akzent
// kommen aus EINEM Design_Code-Record; Base- und Cap-Prompt zitieren
// dieselben Werte -> Relation per Konstruktion. Die Wahl trifft der Nutzer
// (forceCodeId) — hier wird nur geprueft, ob der Code auf DIESEM Teil
// produzierbar ist (SF-Faehigkeitsmodell + Typ-B-Umleitung).
type DesignCodeRec = {
  id: string;
  name: string;
  // Render_Rezept (fldPnvXZEc5pXZyNg): prompt-fertiger englischer Stil-Block,
  // von Alen kuratiert. Gefuellt -> verbatim in den Prompt; leer -> Fallback
  // auf die aus Achsen/Hex generierten Stilzeilen (heutiges Verhalten).
  rezept: string | null;
  bodyBehandlung: string;
  farbort: string;
  bodyHex: string | null;
  capHex: string | null;
  capFinish: string;
  finishBody: string;
  akzentCue: string;
  akzentHex: string | null;
  typoHaltung: string;
  anforderungen: string[];
  // Kern vs. Ausspraegung: 3 = volle Signatur, 2 = ein Traeger umgeleitet,
  // 1 = Signaturtraeger faellt weg. 'verlust' benennt, WAS fehlt.
  stufe: 3 | 2 | 1;
  verlust: string[];
  compatible: boolean;
  umleitung: string | null;
  brand: string;
  produkt: string;
  wirkungBeschreibung: string | null;
  doNot: string[]; // Do_Not des Codes — Geschmacks-Verbote (deutsch, kuratiert)
};

type Concept = {
  konzept_name: string;
  story: string;
  rationale: string;
  produzierbar: any | null;
  szene_id: string;
  palette?: { name: string; hex: string[]; pantone: string[] };
  design_code?: {
    id: string; name: string; umleitung: string | null;
    brand?: string | null; produkt?: string | null; stufe?: number; verlust?: string[]; farbort?: string;
    beschreibung?: string | null;
  };
  do_not?: string[];
  farbsystem?: FarbSystem;
  render?: { bodyLineEn: string; capHex: string | null; capFinishEn: string; akzentEn: string };
};

// Geschmacks-Verbote fuer den Bild-Prompt: bekannte Fallen als kurze
// englische Negativbegriffe; was kein Muster trifft, reist ROH (deutsch)
// mit, statt lautlos verworfen zu werden.
const DO_NOT_EN: [RegExp, string][] = [
  [/orange/i, 'any literal orange fruit, citrus slice or fruit imagery'],
  [/tropfen|frucht|obst/i, 'droplet, splash or fruit decoration'],
  [/bonbon|candy|s(ü|ue)ss/i, 'candy-bright saturated pastel'],
  [/blatt|botanic|pflanz|vektor/i, 'stock vector leaf or botanical clip-art'],
  [/glitter|glanzeffekt|sparkle/i, 'glitter or sparkle effects'],
  [/gradient|verlauf/i, 'multi-colour gradients on the body'],
  [/transparen|durchsichtig|klarglas/i, ''], // Transparenz-Verbote nie ins Bild (klare Flasche bleibt sichtbar)
];
function doNotZeile(doNot: string[]): string {
  const out: string[] = [];
  for (const d of doNot) {
    let matched = false;
    for (const [re, en] of DO_NOT_EN) {
      if (re.test(d)) { matched = true; if (en) out.push(en); }
    }
    if (!matched && d.trim().length > 3) out.push(d.trim());
  }
  const uniq = [...new Set(out)];
  return uniq.length ? `Avoid entirely: ${uniq.join('; ')}.` : '';
}

// ── Prompt Assembly — 100 % deterministisch ─────────────────────────
// Kein LLM: alle Werte kommen aus dem Design_Code-Record + den SF_-Feldern
// des Teils. Halluzinationsflaeche fuer Form/Material: null.
async function assemblePrompt(
  brief: string,
  fall: RenderFall,
  split: boolean,
  sysFields: any,
  capFields: any | null,
  forceCodeId: string
): Promise<{
  fullPrompt: string; basePrompt: string; capPrompt: string | null;
  forbidden: string[]; concept: Concept;
}> {
  const designCodesAll = await airtableListAll(DESIGN_CODE_TABLE);

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

  // ── SF-Faehigkeitsmodell (bestätigt / unbekannt / ausgeschlossen) ──
  // Quelle: belegpflichtig getaggte SF_-Felder. Ausnahme: Kunststoff-
  // Einfaerbung ist industriell universell (Masterbatch) -> ohne Beleg ok.
  const matGate = multiSelectNames(sysFields['Material']).join(' ').toLowerCase();
  const isGlassBody = /glas|glass/.test(matGate);
  const isPlasticGate = /pet|petg|pp|hdpe|acryl|surlyn|kunststoff|plastic/.test(matGate);
  const hasCap = !!capFields || fall !== 'A';
  const confirmed = new Set(multiSelectNames(sysFields['SF_Bestätigt']).map(s => s.toLowerCase()));
  const excluded  = new Set(multiSelectNames(sysFields['SF_Ausgeschlossen']).map(s => s.toLowerCase()));
  type CapState = 'ok' | 'unknown' | 'excluded';
  const koerperFarbe = (): CapState => {
    // Ein explizites "geht nicht" des Lieferanten schlaegt jede Material-Vermutung.
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
  const teileListe = (v: any) => String(v || '').split(/[,\n;]/).map((x: string) => x.trim()).filter(Boolean);
  const designCodes: DesignCodeRec[] = designCodesAll
    .filter(r => selectName(r.fields['Status']) === 'Aktiv')
    .map(r => {
      const f = r.fields;
      const anford = multiSelectNames(f['Anforderungen']);
      const states = anford.map(a => ({ a, s: checkAnforderung(a) }));
      let bodyBehandlung = (selectName(f['Body_Behandlung']) || 'opak_recolor').toLowerCase();
      let farbort = (selectName(f['Farbort']) || 'koerper').toLowerCase();
      let umleitung: string | null = null;

      // AUSGESCHLOSSEN gewinnt immer: Lieferant sagt explizit "geht nicht".
      const hardExcluded = states.filter(x => x.s === 'excluded').map(x => x.a);

      // UNBEKANNT bei Koerper-Farbe: produzier-safe umleiten statt behaupten.
      const wantsBodyColor = ['getönt', 'getoent', 'opak_recolor'].includes(bodyBehandlung)
        && farbort === 'koerper';
      const bodyColorState = koerperFarbe();
      if (wantsBodyColor && bodyColorState === 'unknown') {
        // Farbe in die FLUESSIGKEIT: klares Gebinde kann jeder liefern.
        bodyBehandlung = 'klar_liquid_farbe';
        farbort = 'liquid';
        umleitung = `Typ B: Koerper-Faerbbarkeit unbestaetigt -> Farbe in die Fluessigkeit umgeleitet, Gebinde bleibt klar (Machbarkeit per Muster bestaetigen)`;
      } else if (wantsBodyColor && bodyColorState === 'excluded') {
        bodyBehandlung = 'klar_liquid_farbe';
        farbort = 'liquid';
        umleitung = `Typ B: Koerper NICHT faerbbar (Lieferant) -> Farbe in die Fluessigkeit umgeleitet, Gebinde bleibt klar`;
      }
      // ── Ausspraegungs-Kaskade statt Rauswurf ──────────────────────
      let stufe: 3 | 2 | 1 = umleitung ? 2 : 3;
      const verlust: string[] = [];
      if (umleitung) verlust.push('Körperfarbe — die Farbe sitzt jetzt in der Flüssigkeit, das Gebinde bleibt klar');

      if (bodyBehandlung === 'frosted' && checkAnforderung('braucht_frostbar') !== 'ok') {
        bodyBehandlung = isGlassBody ? 'klar' : 'opak_recolor';
        stufe = 1;
        verlust.push('mattierte Oberfläche — dieses Teil ist nicht belegt mattierbar, der Körper bleibt glatt');
      }
      if (anford.includes('braucht_klarglas') && !isGlassBody) {
        if (TRANSPARENT_BEHANDLUNG.includes(bodyBehandlung)) { bodyBehandlung = 'opak_recolor'; farbort = 'koerper'; }
        stufe = 1;
        verlust.push('durchsichtiger Körper — dieses Teil ist nicht aus Glas, die Haltung läuft über Farbe, Verschluss und Druck');
      }
      // Was die Kaskade aufgeloest hat, darf nicht mehr sperren.
      const geloest = new Set<string>(umleitung ? ['braucht_einfaerbbar', 'braucht_opak'] : []);
      if (stufe === 1) { geloest.add('braucht_klarglas'); geloest.add('braucht_frostbar'); geloest.add('braucht_einfaerbbar'); geloest.add('braucht_opak'); }
      const remaining = hardExcluded.filter(a => !geloest.has(a));
      return {
        id: r.id,
        name: String(f['Name'] || ''),
        rezept: (() => { const v = fieldAny(f, ['Render_Rezept', 'Render Rezept']); return v ? String(v).trim() : null; })(),
        bodyBehandlung,
        farbort,
        bodyHex: String(f['Body_Hex'] || '').trim() || null,
        capHex: String(f['Cap_Hex'] || '').trim() || null,
        capFinish: (selectName(f['Cap_Finish']) || 'matt').toLowerCase(),
        finishBody: (selectName(f['Finish_Body']) || 'matt').toLowerCase(),
        akzentCue: (selectName(f['Akzent_Cue']) || 'kein').toLowerCase(),
        akzentHex: String(f['Akzent_Hex'] || '').trim() || null,
        typoHaltung: (selectName(f['Typo_Haltung']) || '').toLowerCase(),
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
        doNot: teileListe(fieldAny(f, ['Do_Not', 'Do_not', 'DoNot'])),
      };
    });

  // ── Der gewaehlte Code (forceCodeId ist die Entscheidung des Nutzers) ─
  // Ist er auf diesem Teil NICHT produzierbar, brechen wir sichtbar ab,
  // statt still auf einen anderen Look zu kippen (der "immer Pink"-Bug):
  // ein anderer Look waere eine Luege.
  const code = designCodes.find(c => c.id === forceCodeId && c.compatible) || null;
  if (!code) {
    const wanted = designCodes.find(c => c.id === forceCodeId);
    throw new Error(wanted
      ? `Look "${wanted.name}" ist auf diesem Teil nicht produzierbar (Anforderung unbestätigt/ausgeschlossen)`
      : `Design-Code ${forceCodeId} nicht gefunden oder nicht aktiv`);
  }

  // ── Produkt-Basics + Gates ──────────────────────────────────────────
  const material = multiSelectNames(sysFields['Material']);
  const availMaterials = multiSelectNames(sysFields['Available_Materials']);
  const sysClosure = multiSelectNames(sysFields['Closure']).concat(selectName(sysFields['Closure']) || []);
  const capClosure = capFields
    ? multiSelectNames(capFields['Closure_Type']).concat(selectName(capFields['Closure_Type']) || [])
    : [];
  const closureCoverage = [...new Set([...sysClosure, ...capClosure].filter(Boolean))];
  const capMaterial = capFields ? multiSelectNames(capFields['Material']).join(', ') : '';
  const materialCoverage = [...new Set([...availMaterials, ...material])];
  const forbiddenMaterials = runGate(brief, MATERIAL_LEXICON, materialCoverage);
  const forbiddenClosures = runGate(brief, CLOSURE_LEXICON, closureCoverage);
  const forbidden = [...new Set([...forbiddenMaterials, ...forbiddenClosures])];

  const colorable = koerperFarbe() === 'ok';
  const primaryMat = (material[0] || 'plastic').toLowerCase();
  const isPlastic = /pet|petg|pp|hdpe|acryl|surlyn|kunststoff|plastic/.test(primaryMat);
  const matEN = material.join(' / ') || 'plastic';

  // ── Body-Behandlung: EINE Zeile, deterministisch aus dem Design_Code ─
  const codeBodyHex = code.bodyHex || '#EDEDED';
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
  const codeBodyHexFuellung = istFarblos(code.bodyHex)
    ? (code.akzentHex && !istFarblos(code.akzentHex) ? code.akzentHex
       : code.capHex && !istFarblos(code.capHex) ? code.capHex : codeBodyHex)
    : codeBodyHex;
  let bodyLineEn: string;
  switch (code.bodyBehandlung) {
    case 'klar':
      // Farbort MUSS gelesen werden: ein 'klar'-Code mit Farbort 'liquid'
      // hat seine gesamte Lautstaerke in der Fluessigkeit.
      bodyLineEn = code.farbort === 'liquid'
        ? `Keep the body as clear transparent material exactly as in the reference image — do not tint or recolor the material itself. The bottle is filled with liquid in a saturated ${codeBodyHexFuellung}; the colour comes entirely from the contents and reads clearly through the clear wall, with a visible fill line near the shoulder.`
        : `Keep the body as clear transparent material exactly as in the reference image — do not tint or recolor it.`;
      break;
    case 'frosted':
      bodyLineEn = code.farbort === 'liquid'
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

  // ── Farb-Rollensystem: Traeger aus dem ECHTEN Render-Ergebnis ──────
  // Ein 'opak_recolor'-Code auf nicht einfaerbbarem Glas faellt oben auf
  // "Keep the body in its original tone" — die Physik-Zeile darf nie luegen.
  const traegerOrt: 'Flüssigkeit' | 'Körper' | 'Material' =
    (code.farbort === 'liquid' || code.bodyBehandlung === 'klar_liquid_farbe') ? 'Flüssigkeit'
    : code.bodyBehandlung === 'klar' ? 'Material'
    : (code.bodyBehandlung === 'opak_recolor' && !(colorable || isPlastic)) ? 'Material'
    : 'Körper';
  const traegerHexEcht = traegerOrt === 'Material' ? null
    : traegerOrt === 'Flüssigkeit' ? codeBodyHexFuellung : codeBodyHex;
  const farbsys = farbSystem(traegerHexEcht, traegerOrt, code.capHex, code.akzentHex, code.akzentCue, !!capFields || fall !== 'A');

  // ── Geteilte Bausteine fuer ALLE Prompts (Vollbild, Split-Base, Cap) ─
  const attrLine = attrConstraints.length
    ? `Fixed physical characteristics of this exact product: ${attrConstraints.slice(0, 10).join('; ')}.`
    : '';
  const materialLine = `The body is ${matEN}${isPlastic ? ' — it must clearly read as a plastic container, never as solid metal, aluminium, steel, glass or ceramic' : ''}.`;
  const capMaterialLine = capMaterial ? `The cap is ${capMaterial}.` : '';
  const avoidLine = doNotZeile((traegerOrt === 'Material')
    // Transparenz-Verbote rausfiltern, wenn die Wand sichtbar klar bleibt.
    ? code.doNot.filter(d => !/transparen|durchsichtig|klarglas/i.test(d))
    : code.doNot);
  const studioLine = `Clean seamless white studio background, soft neutral lighting, centered product packshot. No text, no label graphics, no logo, no lettering anywhere on the product.`;
  const codeAkzentEn = akzentCueEn(code.akzentCue, code.akzentHex);
  // ── Render_Rezept: kuratierter Stil-Block, verbatim, VOR den mechanischen
  // Farb-/Finish-Zeilen. Hex-Werte bleiben als Verstaerkung (Anker-Zeile),
  // aber das Rezept gewinnt bei jedem Konflikt — insbesondere bei Umleitung/
  // klar_liquid_farbe, wo die generierte Tint-Zeile sonst blass gegen das
  // Rezept arbeitet (Live-Test XTAG: #00AEEF blass statt gesaettigt, kein
  // Verlauf). Kein Rezept -> exakt das bisherige, generierte Verhalten.
  const rezept = code.rezept;
  const rezeptBlock = rezept
    ? `STYLE RECIPE for this design world — follow it precisely; on any conflict with the colour lines in this prompt, the recipe wins: ${rezept}`
    : '';
  const hexAnker = [
    code.bodyHex ? `body ${code.bodyHex}` : '',
    code.capHex ? `closure ${code.capHex}` : '',
    code.akzentHex ? `accent ${code.akzentHex}` : '',
  ].filter(Boolean).join(', ');
  const ankerLine = rezept && hexAnker ? `Colour anchors reinforcing the recipe: ${hexAnker}.` : '';
  // Rezept gewinnt die Body-Zeile: bei Typ-B-Umleitung oder klar_liquid_farbe
  // wuerde die mechanische Zeile ("liquid is a clean X") dem Rezept
  // widersprechen — dann faellt sie weg. Sonst bleibt sie als Verstaerkung.
  const rezeptGewinnt = !!rezept && (!!code.umleitung || code.bodyBehandlung === 'klar_liquid_farbe');

  // ── Vollbild-Prompt (Fall A/B, ein Render) ─────────────────────────
  const fullLines: string[] = [];
  fullLines.push(`Keep the exact same packaging shape, silhouette, proportions, neck and closure as shown in reference image 1 — change ONLY the surface color and finish. Do NOT add any label, sticker, printed panel or white patch — the surface stays one uninterrupted, continuous material.`);
  if (attrLine) fullLines.push(attrLine);
  if (fall === 'B') {
    fullLines.push(`Image 1 shows the bottle WITH its existing cap, image 2 the replacement cap. REPLACE the original cap from image 1 with the cap from image 2 exactly as shown — do not merge them, do not invent a new cap.`);
  }
  fullLines.push(materialLine);
  if (capMaterialLine) fullLines.push(capMaterialLine);
  if (rezept) {
    // Rezept-Pfad: der kuratierte Block traegt den Stil; die generierten
    // Zeilen schrumpfen auf Anker + (falls konfliktfrei) die Body-Zeile.
    fullLines.push(rezeptBlock);
    if (ankerLine) fullLines.push(ankerLine);
    if (!rezeptGewinnt) fullLines.push(bodyLineEn);
  } else {
    fullLines.push(bodyLineEn);
    if (code.capHex) {
      fullLines.push(`Color the closure/cap as ONE single solid ${code.capHex} tone with ${CAP_FINISH_EN[code.capFinish] || CAP_FINISH_EN.matt} — never the body colour on the cap.`);
    }
    if (codeAkzentEn) fullLines.push(`Add ${codeAkzentEn}.`);
    if (farbsys.regelEn) fullLines.push(farbsys.regelEn);
  }
  if (avoidLine) fullLines.push(avoidLine);
  fullLines.push(studioLine);
  const closureRuleFull = fall === 'A'
    ? 'Do not add, remove, replace or restyle the closure — keep the closure exactly as shown in the reference image.'
    : 'Use ONLY the closure shown in image 2 — do not invent a different closure, do not change its shape or mechanism.';
  const fullPrompt = `${fullLines.filter(Boolean).join(' ')}\n\n${buildHardRule(closureRuleFull, forbidden, code.typoHaltung, code.akzentHex)}`;

  // ── Split-Prompts (Fall C/D): Base und Cap GETRENNT, gleiche Bausteine ─
  // Einzelbild-Edit ist formtreu; zwei Produktbilder zusammen = Drift
  // (bewiesen, 2x reproduziert). Beide Prompts zitieren DENSELBEN Code.
  const baseLines: string[] = [];
  baseLines.push(`Keep the exact same body shape, silhouette and proportions as reference image 1 — change ONLY the surface color and finish. Do NOT add any label, sticker, printed panel or white patch — the surface stays one uninterrupted, continuous material. Preserve the exact narrow threaded neck exactly as in the reference image — same width, same threads, same shoulder; do NOT widen, flare, open up or reshape the neck.`);
  if (attrLine) baseLines.push(attrLine);
  baseLines.push(materialLine);
  if (rezept) {
    baseLines.push(rezeptBlock);
    if (ankerLine) baseLines.push(ankerLine);
    if (!rezeptGewinnt) baseLines.push(bodyLineEn);
  } else {
    baseLines.push(bodyLineEn);
    if (farbsys.regelEn) baseLines.push(farbsys.regelEn);
  }
  if (avoidLine) baseLines.push(avoidLine);
  baseLines.push(studioLine);
  const closureRuleBase = 'Do NOT add, draw, imply or attach any cap, closure, lid, dropper, pipette or pump anywhere on the bottle — the neck stays open exactly as in reference image 1.';
  const basePrompt = `${baseLines.filter(Boolean).join(' ')}\n\n${buildHardRule(closureRuleBase, forbidden, code.typoHaltung, code.akzentHex)}`;

  // Cap: Rezept-Variante (Rezept vorhanden — das ganze Rezept reist mit,
  // die Closure-Behandlung kommt daraus), sonst Recolor (Cap_Hex) oder
  // Preserve (ohne Hex bleibt er roh).
  const akzentLine = codeAkzentEn ? ` Add ${codeAkzentEn}.` : '';
  // Geometrie-Lock fuer den Cap (v46, Live-Test XTAG: Pumpkopf wurde zu
  // einem klobigen weissen Stufen-Pumpkopf umgeformt).
  const capGeoLock = `This is a strict recolor and restyle of the SAME physical closure. Keep silhouette, proportions, wall thickness, collar, and every step and part of the pump/closure EXACTLY as in reference image 1 — identical geometry, identical mechanism. Change ONLY surface colour, finish and tint. Do not add stripes, bars, lines, dots, patterns, badges or any other graphic element beyond what this prompt explicitly specifies.`;
  const capTailLock = `If any part is clear transparent glass in the reference image, keep that part clear — do not tint it. Do NOT add, remove, replace or restyle any part of the closure. Do NOT change its shape, proportions or size. The image contains ONLY this closure exactly as in reference image 1; do NOT add, invent or draw any bottle, jar, vial, container, housing, sleeve, cylinder or chamber that is not already in the reference image — the pump shaft or dip tube stays exactly as shown, nothing added around it. Clean seamless white studio background, soft neutral lighting, centered. No text, no label, no logo, no lettering anywhere.`;
  const capRezeptPrompt = [
    `Keep the exact same closure shape, silhouette, proportions and every individual part exactly as shown in reference image 1 — change ONLY the surface colour and finish.`,
    rezeptBlock,
    `Apply to this closure exactly the closure treatment the recipe describes — and nothing beyond it.${code.capHex ? ` Its closure anchor colour is ${code.capHex} with ${CAP_FINISH_EN[code.capFinish] || CAP_FINISH_EN.matt}; the recipe wins on any conflict.` : ''}`,
    capGeoLock,
    capMaterialLine,
    avoidLine,
    capTailLock,
  ].filter(Boolean).join(' ');
  const capRecolorPrompt = [
    `Keep the exact same closure shape, silhouette, proportions and every individual part exactly as shown in reference image 1 — change ONLY the surface colour and finish. Color the closure as ONE single solid ${code.capHex} tone across the whole closure with ${CAP_FINISH_EN[code.capFinish] || CAP_FINISH_EN.matt}.${akzentLine} Do NOT split it into multiple colored segments and do NOT use more than this one accent on it.`,
    capGeoLock,
    capMaterialLine,
    avoidLine,
    capTailLock,
  ].filter(Boolean).join(' ');
  const capPreservePrompt = `Keep this closure EXACTLY as shown in the reference image — identical shape, identical parts, identical proportions, identical colour, identical material and finish. Do NOT recolor it, do NOT change anything about the closure itself. Only place it cleanly on a seamless white studio background with soft neutral lighting, centered. The image contains ONLY this closure exactly as in the reference; do NOT add, invent or draw any bottle, jar, vial, container, housing, sleeve, cylinder or chamber — the pump shaft or dip tube stays exactly as shown, nothing added around it. No text, no label, no logo, no lettering anywhere.`;
  const capPrompt = split ? (rezept ? capRezeptPrompt : (code.capHex ? capRecolorPrompt : capPreservePrompt)) : null;

  // ── Konzept — deterministisch aus dem Code (kein LLM) ──────────────
  const displayHex = [code.bodyHex, code.capHex, code.akzentHex].filter(Boolean) as string[];
  const produzierbar = {
    finish: [BODY_FINISH_DE[code.finishBody] || BODY_FINISH_DE.matt],
    dekoration: [
      ...(AKZENT_CUE_DE[code.akzentCue] ? [AKZENT_CUE_DE[code.akzentCue]] : []),
      ...(colorable ? ['Einfärbung Primärbehälter'] : ['Farbe via Label/Cap (Behälter nicht einfärbbar)']),
    ],
    farbkonzept: `${code.name} — Hex: ${displayHex.join(', ')}`,
    design_code: code.name,
    design_code_id: code.id,
    ...(code.umleitung ? { design_code_umleitung: code.umleitung } : {}),
  };
  // Herkunft statt Herleitung: ein Hex aus einem real produzierten Produkt
  // ist staerker als ein hergeleiteter — die Rationale nennt Provenienz.
  const rationale = [
    code.brand ? `Farbwelt aus ${code.brand}${code.produkt ? ` ${code.produkt}` : ''} — real produziert, am Regal bewiesen.` : `Farbwelt aus dem kuratierten Design-Code ${code.name}.`,
    ...(code.verlust.length ? [`Auf diesem Teil (Stufe ${code.stufe}/3): ${code.verlust.join('; ')}.`] : []),
  ].join(' ');

  const concept: Concept = {
    konzept_name: code.name,
    story: code.wirkungBeschreibung || '',
    rationale,
    produzierbar,
    szene_id: '',
    palette: { name: code.name, hex: displayHex.slice(0, 3), pantone: [] },
    design_code: {
      id: code.id, name: code.name, umleitung: code.umleitung,
      brand: code.brand || null, produkt: code.produkt || null,
      stufe: code.stufe, verlust: code.verlust, farbort: code.farbort,
      beschreibung: code.wirkungBeschreibung,
    },
    do_not: code.doNot.slice(0, 4),
    farbsystem: farbsys,
    render: {
      bodyLineEn,
      capHex: code.capHex,
      capFinishEn: CAP_FINISH_EN[code.capFinish] || CAP_FINISH_EN.matt,
      akzentEn: codeAkzentEn,
    },
  };

  return { fullPrompt, basePrompt, capPrompt, forbidden, concept };
}

// ── Design-Wand ({codes:true}): leichte Code-Liste mit Facetten ──────
type CodeLeicht = {
  id: string; name: string; brand: string; register: string | null; tempLaut: number | null;
  segments: string[]; bild: string | null; wirkstoffWelt: string[];
  tempTon: number | null; tempForm: number | null; farbtemp: number | null; dekoDichte: number | null;
  hfForm: string | null; hfMaterial: string | null; hfTyp: string | null;
  bodyHex: string | null; capHex: string | null; wirkung: string;
};
const numOrNull = (v: any): number | null => (v != null && v !== '' && !isNaN(Number(v))) ? Number(v) : null;
let codesCache: { t: number; v: CodeLeicht[] } | null = null;
async function ladeCodesLeicht(): Promise<CodeLeicht[]> {
  if (codesCache && Date.now() - codesCache.t < 300000) return codesCache.v;
  const rows = await airtableListAll(DESIGN_CODE_TABLE);
  const v: CodeLeicht[] = rows
    .filter((r: any) => (selectName(r.fields?.['Status']) || '') === 'Aktiv')
    .map((r: any) => ({
      id: r.id, name: String(r.fields['Name'] || ''), brand: String(r.fields['Brand'] || '').trim(),
      register: (selectName(r.fields['Register']) || '').toLowerCase() || null,
      tempLaut: (r.fields['Temp_Laut'] != null && r.fields['Temp_Laut'] !== '') ? Number(r.fields['Temp_Laut']) : null,
      segments: multiSelectNames(r.fields['Segment']),
      bild: (() => { const a = r.fields['Referenz_Bild']; return Array.isArray(a) && a[0] ? (a[0].thumbnails?.large?.url || a[0].url || null) : null; })(),
      wirkstoffWelt: multiSelectNames(r.fields['Wirkstoff_Welt']),
      tempTon: numOrNull(r.fields['Temp_Ton']),
      tempForm: numOrNull(r.fields['Temp_Form']),
      farbtemp: numOrNull(r.fields['Farbtemp']),
      dekoDichte: numOrNull(r.fields['Deko_Dichte']),
      hfForm: selectName(r.fields['HF_Form']) || null,
      hfMaterial: selectName(r.fields['HF_Material']) || null,
      hfTyp: selectName(r.fields['HF_Typ']) || null,
      bodyHex: String(r.fields['Body_Hex'] || '').trim() || null,
      capHex: String(r.fields['Cap_Hex'] || '').trim() || null,
      wirkung: String(r.fields['Wirkung_Keywords'] || '').trim(),
    }));
  codesCache = { t: Date.now(), v };
  return v;
}

// ── Zugangs-Riegel ────────────────────────────────────────────────────
// Nur die eigene Oberflaeche darf rufen, und auch die nicht endlos.
const ULBA_ORIGINS = new Set<string>([
  'https://ulba.vercel.app',
  'http://localhost:3000',
  ...String(process.env.ULBA_ORIGINS || '').split(',').map(o => o.trim()).filter(o => /^https?:\/\//.test(o)),
]);

function riegel(req: VercelRequest, res: VercelResponse, opts?: { originOptional?: boolean }): boolean {
  const origin = String(req.headers.origin || '');
  const erlaubt = origin ? ULBA_ORIGINS.has(origin) : !!opts?.originOptional;
  if (origin && erlaubt) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  return erlaubt;
}

// Pro-Instanz-Zaehler. Serverless heisst: nicht global exakt, aber es kappt
// jeden Dauerbeschuss, und mehr soll es hier nicht.
const ULBA_TAKT = new Map<string, number[]>();
function taktOk(req: VercelRequest, max: number, fensterMs: number): boolean {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unbekannt';
  const jetzt = Date.now();
  const treffer = (ULBA_TAKT.get(ip) || []).filter(t => jetzt - t < fensterMs);
  if (treffer.length >= max) { ULBA_TAKT.set(ip, treffer); return false; }
  treffer.push(jetzt);
  ULBA_TAKT.set(ip, treffer);
  if (ULBA_TAKT.size > 500) {
    for (const [k, v] of ULBA_TAKT) if (!v.some(t => jetzt - t < fensterMs)) ULBA_TAKT.delete(k);
  }
  return true;
}

// ── Main Handler ────────────────────────────────────────────────────
export const config = { api: { bodyParser: true }, maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const offen = riegel(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!offen) return res.status(403).json({ error: 'Zugriff nur von ulba' });
  if (!taktOk(req, 30, 300000)) return res.status(429).json({ error: 'Zu viele Anfragen — kurz warten.' });

  /* ── Die Design-Wand. Ein Modus, eine Antwort: alle aktiven Codes mit
     Bild, plus die Facetten, nach denen sich filtern laesst. 'passend' ist
     nur eine Vorsortierung, die Wand zeigt alles. */
  if ((req.body as any)?.codes === true) {
    try {
      const b = req.body as { register?: string | null; wirkstoff?: string | null; suche?: string | null; segment?: string | null };
      const [alleRoh, wirkstoffListe] = await Promise.all([ladeCodesLeicht(), ladeWirkstoffe().catch(() => [] as WirkstoffRef[])]);
      const alle = alleRoh.filter(c => c.bild);
      // Wirkstoff aus der Suche, gegen die kuratierte Tabelle (eine Wahrheit).
      const wsName = b.wirkstoff || wirkstoffTreffer(b.suche || '', wirkstoffListe)?.name || '';
      const ws = wsName.toLowerCase().split(' ')[0];
      const punkte = (c: CodeLeicht) => {
        let p = 0;
        if (b.register && c.register === b.register) p += 3;
        if (ws && c.wirkstoffWelt.some(w => w.toLowerCase().replace(/_/g, ' ').includes(ws))) p += 2;
        if (b.segment && c.segments.includes(b.segment)) p += 1;
        return p;
      };
      const sortiert = [...alle].sort((x, y) => punkte(y) - punkte(x));
      const facetten = {
        register: [...new Set(alle.map(c => c.register).filter(Boolean))].sort() as string[],
        segment: [...new Set(alle.flatMap(c => c.segments))].sort(),
        form: [...new Set(alle.map(c => c.hfForm).filter(Boolean))].sort() as string[],
        material: [...new Set(alle.map(c => c.hfMaterial).filter(Boolean))].sort() as string[],
        wirkstoff: [...new Set(alle.flatMap(c => c.wirkstoffWelt))].sort(),
      };
      return res.status(200).json({
        codes: sortiert.map(c => ({
          id: c.id, name: c.name, brand: c.brand, bild: c.bild,
          register: c.register, segments: c.segments, wirkstoffWelt: c.wirkstoffWelt,
          laut: c.tempLaut, ton: c.tempTon, form: c.tempForm, farbtemp: c.farbtemp, deko: c.dekoDichte,
          hfForm: c.hfForm, hfMaterial: c.hfMaterial, hfTyp: c.hfTyp,
          bodyHex: c.bodyHex, capHex: c.capHex, wirkung: c.wirkung,
          passend: punkte(c) > 0,
        })),
        facetten,
      });
    } catch {
      return res.status(200).json({ codes: [], facetten: { register: [], segment: [], form: [], material: [], wirkstoff: [] } });
    }
  }

  const {
    systemId,
    query,
    selectedCapId = null,
    tier = 'lite',
    forceCodeId = null,
    nocache: nocacheRoh = false,
  } = req.body as {
    systemId: string;
    query: string;
    selectedCapId?: string | null;
    tier?: Tier;
    forceCodeId?: string | null;
    nocache?: boolean;
  };

  if (!systemId || !query) {
    return res.status(400).json({ error: 'systemId und query sind erforderlich' });
  }
  if (!forceCodeId) {
    return res.status(400).json({ error: 'forceCodeId ist erforderlich — der Render braucht einen gewählten Design-Code' });
  }
  if (tier !== 'lite' && tier !== 'pro') {
    return res.status(400).json({ error: 'tier muss "lite" oder "pro" sein' });
  }

  // nocache umgeht den Cache und kostet einen frischen fal.ai-Lauf —
  // nur mit Dev-Geheimnis im Header.
  const nocache = nocacheRoh === true
    && !!process.env.ULBA_DEV_SECRET
    && req.headers['x-ulba-dev'] === process.env.ULBA_DEV_SECRET;

  const effectiveBrief = query;

  try {
    // ── 1. Cache Check ──────────────────────────────────────────────
    const key = cacheKey(systemId, effectiveBrief, selectedCapId, tier, forceCodeId);
    let cached: any[] = [];
    if (!nocache) try {
      cached = await airtableQuery(
        CACHE_TABLE,
        `{Cache_Key}='${key}'`,
        ['Cache_Key', 'Bild', 'Cap_Bild', 'Rendering_Prompt', 'Konzept_Name', 'Konzept_Story', 'Konzept_Rationale', 'Szene_ID', 'Produzierbar', 'Board'],
        1
      );
    } catch {
      cached = []; // z.B. Feld fehlt → Cache-Miss, frisch rendern.
    }
    if (cached.length > 0) {
      const cachedImg = imgUrl(cached[0].fields['Bild']);
      if (cachedImg) {
        const cf = cached[0].fields;
        let produzierbar: any = null;
        try { produzierbar = cf['Produzierbar'] ? JSON.parse(cf['Produzierbar']) : null; } catch { produzierbar = null; }
        let board: any = {};
        try { board = cf['Board'] ? JSON.parse(cf['Board']) : {}; } catch { board = {}; }
        const cachedConcept: Concept | null = (cf['Konzept_Name'] || produzierbar)
          ? {
              konzept_name: cf['Konzept_Name'] || '',
              story: cf['Konzept_Story'] || '',
              rationale: cf['Konzept_Rationale'] || '',
              produzierbar,
              szene_id: cf['Szene_ID'] || '',
              // Neue Records tragen do_not/farbsystem im Board-JSON; alte
              // Records liefern undefined — beides vertraegt das Frontend.
              palette: board.palette,
              design_code: board.design_code,
              do_not: board.do_not,
              farbsystem: board.farbsystem,
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
    const { fall, primaryUrl, primaryAspect } = determineFall(sys);

    // ── 3. Resolve Cap ──────────────────────────────────────────────
    let capImageUrl: string | null = null;
    let capAspect = 'auto';
    let capFields: any | null = null;
    let resolvedCapId: string | null = selectedCapId;

    const linkedCaps = sys.fields['Caps'] as string[] | undefined;
    if (fall !== 'A' && linkedCaps && linkedCaps.length > 0) {
      const capId = selectedCapId || linkedCaps[0];
      resolvedCapId = capId;
      const capRec = await airtableFetch(CAP_TABLE, capId);
      capFields = capRec.fields;
      const capAtt = imgUrl(capRec.fields['Cap_Bild_Harmonisiert'])
        ? capRec.fields['Cap_Bild_Harmonisiert'] : capRec.fields['Cap_Bild'];
      capImageUrl = imgUrl(capAtt);
      capAspect = aspectFromAttachment(capAtt);
      if (!capImageUrl) throw new Error(`Cap ${capId} hat kein Bild`);
    }

    // ── 4. Render-Strategie ─────────────────────────────────────────
    // Fall C/D: Base und Cap werden GETRENNT recolort und GETRENNT angezeigt.
    // Nie zusammen an ein Modell (Drift), kein Compositing.
    const useSplitRender = (fall === 'C' || fall === 'D') && !!capImageUrl;

    // ── 5. Prompts deterministisch assemblieren ─────────────────────
    const { fullPrompt, basePrompt, capPrompt, forbidden, concept } =
      await assemblePrompt(effectiveBrief, fall, useSplitRender, sys.fields, capFields, forceCodeId);

    // ── 6. Render ───────────────────────────────────────────────────
    // image_urls = NUR das/die Produktfoto(s). Kein Referenz_Bild mehr:
    // Seedream uebernimmt sonst Formen aus der Stil-Referenz (Live-Test
    // XTAG — Geometrie-Kontamination). Detailtreue schlaegt alles.
    // aspect_ratio = Format des jeweiligen Eingabefotos.
    let renderingUrl: string;
    let capRenderingUrl: string | null = null;
    let capPromptUsed: string | null = null;
    const renderingPrompt = useSplitRender ? basePrompt : fullPrompt;

    if (useSplitRender) {
      const [baseUrl, capUrl] = await Promise.all([
        falEdit([primaryUrl], basePrompt, primaryAspect),
        falEdit([capImageUrl!], capPrompt!, capAspect).catch((e) => {
          // Cap-Recolor darf nie den Gesamt-Render killen: Fallback = Roh-Cap.
          console.error('Cap-Recolor fehlgeschlagen — zeige Roh-Cap:', e);
          return capImageUrl!;
        }),
      ]);
      renderingUrl = baseUrl;
      capRenderingUrl = capUrl;
      capPromptUsed = capPrompt;
    } else {
      const imgs = (fall === 'A' || !capImageUrl) ? [primaryUrl] : [primaryUrl, capImageUrl];
      renderingUrl = await falEdit(imgs, fullPrompt, primaryAspect);
    }

    // ── 7. AUSLIEFERN ZUERST, cachen danach ─────────────────────────
    // fal-URLs leben ~1h, reicht zum Anzeigen. Cachen laeuft als
    // Best-Effort DANACH; killt die 60s-Wand es, hat der Nutzer sein Bild.
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
    // Ab hier darf ALLES scheitern, ohne den Nutzer zu betreffen.
    try {
    const imgBuffer: Buffer = Buffer.from(await (await fetchT(renderingUrl, { timeoutMs: 15000, label: 'fal img download' })).arrayBuffer());
    const base64 = imgBuffer.toString('base64');
    const boardJson = JSON.stringify({
      palette: concept.palette,
      design_code: concept.design_code,
      do_not: concept.do_not,
      farbsystem: concept.farbsystem,
    });

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
            Konzept_Name: concept.konzept_name || '',
            Konzept_Story: concept.story || '',
            Konzept_Rationale: concept.rationale || '',
            Szene_ID: concept.szene_id || '',
            Produzierbar: concept.produzierbar ? JSON.stringify(concept.produzierbar) : '',
            Board: boardJson,
            Tier: tier,
            Fall: fall,
            Created_At: new Date().toISOString(),
          },
        }),
      }
    );

    let createData = await createRes.json() as { id: string; error?: any };
    // Haertung: unbekanntes Feld kippt NICHT den ganzen Record. Airtable
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
          Board: boardJson,
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
    // die temporaere fal-URL). Non-fatal.
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

    } catch (cacheErr) {
      // Best-Effort-Cache gescheitert (z.B. 60s-Wand mitten im Upload).
      console.error('Cache-Persist fehlgeschlagen (Antwort war bereits raus):', cacheErr);
    }
    return;
  } catch (err) {
    // Fehler VOR der Auslieferung (fal-Timeout, Airtable-Read, Assembly).
    const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
    console.error('Render error:', message);
    if (!res.headersSent) return res.status(500).json({ error: message });
    return;
  }
}
