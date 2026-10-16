import { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'crypto';
import sharp from 'sharp';

/* ── render.ts v49 — der vereinfachte Renderer ────────────────────────────
   v49: (1) NIE BLOCKIEREN — unbestätigte Anforderungen rendern normal mit
   Warnung, belegte Ausschluesse werden automatisch Typ-B-umgeleitet; der
   rote Produzierbarkeits-Fehler existiert nicht mehr. (2) Persistenz-
   Garantie — der Cache-Record entsteht VOR dem fal-Call (Status Pending),
   cacheId geht sofort mit der Antwort raus, Done/Error werden nachgetragen;
   nur Done zaehlt als Cache-Hit. Felder: Status, Engine, Design_Code,
   Teil_Name, Render_Log.
   v50: RENDER_ZONEN — traegt das System ein Zonen-JSON (Render_Zonen, von
   der Zonen-Automation aus dem Foto gelesen), steuern primary_canvas/
   redirect_canvas die Farb-Anwendung zonengenau: der Prompt benennt die
   Ziel-Zone explizit ("apply ONLY to the inner cartridge; the outer clear
   glass wall stays untouched") und ersetzt die Behandlungs-Heuristik.
   Ohne Zonen exakt das bisherige Verhalten.
   v51: KOMPONENTEN-MODELL (DESIGN-ENTSCHEID) — die Welt ist ein BAUPLAN
   aus Design-Komponenten (Design_Komponenten-JSON am Code), das Teil
   traegt Deko-Faehigkeiten (System.Deko_Faehigkeiten, Cap.Einfaerbbar),
   der Renderer UEBERSETZT deterministisch: farbe_fix -> Welt aufs Etikett;
   einfaerbung_masse -> Masse-Einfaerbung (Transparenz der Welt respektiert);
   Verlauf/Grafik -> Direktdruck, sonst Etikett. Das pauschale Etiketten-
   Verbot faellt: Labels sind erste Klasse, praezise beschrieben, Tiegel-
   Label NUR seitlich; die No-Text-Regel bleibt global. Verschluss (v55,
   Alens Regel): die Cap-WAHL bestimmt nur Mechanik/Geometrie — die FARBE
   kommt IMMER von der Welt, sofern Cap.Einfaerbbar; Metall/Chrom bleibt
   wie fotografiert + Hinweis. concept.umsetzung erklaert die Schritte deutsch.
   Ohne Design_Komponenten exakt das v50-Verhalten.
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
   Dazu haerterer Geometrie-Lock (strict recolor of the SAME object) und
   das Seitenverhaeltnis des Produktfotos statt 'auto'.
   v47 (Re-Test XTAG: Pumpkopf-Drift trotz Text-Lock): (1) Geometrie-Anker
   aus den DATEN — die getaggten Attribute des Teils (Attribute/Cap_Attribute,
   Form, Neck_Norm, Closure) werden zur teil-spezifischen Preserve-Aufzaehlung;
   (2) Recolor-spezifischer Cap-Lock ("a chrome part painted white keeps
   chrome's exact geometry"); (3) optionaler Body-Param engine ('seedream'
   default | 'gemini') fuer den A/B-Vergleich der Formtreue — fliesst in den
   Cache-Key; (4) volles fal-Preset-Set fuer aspect_ratio (9:21 etc. — 9:16
   hatte schlanke Flaschen gestreckt).
   v48 (Re-Test: Chrom-Pumpkopf weiss uebermalt, Streifen aus der Grafik-
   Regel, DESIGN-ENTSCHEID): "Der Verschluss wird GEWAEHLT, nie umlackiert."
   (1) Jede pauschale Cap-Umfaerbung ist raus — Cap_Hex geht nie mehr in
   Bild-Prompts; (2) passt der gewaehlte Cap nicht zur Soll-Farbe der Welt,
   kommt eine ehrliche Warnung in farbsystem.warnungen — mit der passenden
   Cap-Variante des Systems, falls es eine gibt.
   v54 (3-Felder-Modell, Alens Konsolidierung): Render_Rezept ist KOMPLETT
   aus dem Render-Pfad entfernt. Der Komponenten-Bauplan (Design_Komponenten)
   ist die einzige Welt-Quelle fuer den Bild-Prompt; die Closure-Praeferenz
   fuer Variantenwahl/Warnung kommt aus Design_Komponenten.verschluss
   (Hex -> white/black/silver/gold + Finish). Welten OHNE Komponenten fallen
   auf das Achsen-Verhalten zurueck (Sicherheitsnetz, nicht Rezept-basiert). */

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
// v52: satte Tints (nie Lavendel), Teilflaechen-Labels (seitlich/partiell),
// farb_hinweis. v53: Komposit-Call wieder raus (Kosten + Qualitaetsrisiko,
// Alens Entscheid) — im Split-Fall exakt ZWEI Renders (Body + gewaehlter Cap),
// das Frontend stapelt die beiden Bilder per CSS zu einem Produkt.
// v54: 3-Felder-Modell — Render_Rezept komplett raus, Bauplan einzige Quelle.
// v55: Cap-Wahl = nur Mechanik; Farbe IMMER von der Welt (wenn Einfaerbbar).
// v56: massstabsgetreuer Cap-Stapel — Silhouetten-Messung beider Split-
// Renders (weisser Studiogrund), capScale in Antwort + Cap_Scale im Cache.
const RENDER_VERSION = 'v56';

// ── v56: Silhouetten-Messung auf weissem Studiogrund ────────────────────
// Downscale auf 256px (glaettet JPEG-Rauschen), Nicht-Fast-Weiss-Scan
// (alle Kanaele > 245 = Hintergrund). Liefert Bildmasse, maximale
// Silhouettenbreite und die minimale Breite im obersten Viertel der
// Silhouette (= Hals/Gewinde). Best-Effort: jeder Fehler -> null.
type SilMass = { imgW: number; maxW: number; neckW: number; silH: number };
async function messeSilhouette(buf: Buffer): Promise<SilMass | null> {
  try {
    const { data, info } = await sharp(buf)
      .removeAlpha()
      .resize(256, 256, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const B = info.width, H = info.height, C = info.channels;
    let top = -1, bottom = -1, maxW = 0;
    const breiten: number[] = new Array(H).fill(0);
    for (let y = 0; y < H; y++) {
      let l = -1, r = -1;
      for (let x = 0; x < B; x++) {
        const i = (y * B + x) * C;
        if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) continue;
        if (l < 0) l = x;
        r = x;
      }
      if (l >= 0) {
        breiten[y] = r - l + 1;
        if (top < 0) top = y;
        bottom = y;
        if (breiten[y] > maxW) maxW = breiten[y];
      }
    }
    if (top < 0 || maxW < 8) return null; // leer/fast leer -> unbrauchbar
    const viertel = top + Math.max(1, Math.round((bottom - top + 1) * 0.25));
    let neckW = Infinity;
    for (let y = top; y < viertel; y++) if (breiten[y] > 0) neckW = Math.min(neckW, breiten[y]);
    if (!isFinite(neckW)) neckW = maxW;
    return { imgW: B, maxW, neckW, silH: bottom - top + 1 };
  } catch { return null; }
}
// Typ-Faktor: wie viel breiter als der Hals der Verschluss real sitzt.
function capTypFaktor(closureText: string): number {
  const t = closureText.toLowerCase();
  if (/pump|spray|pipette|airless|dropper/.test(t)) return 1.1; // Kragen ≈ Hals
  if (/screw|schraub|snap/.test(t)) return 1.25; // Kappe etwas breiter
  return 1.2;
}
// Default-Modell Seedream (A/B 04.08.: hielt Detail + Matt-Haptik besser);
// Gemini 2.5 Flash Image als optionale Engine fuer den Formtreue-Vergleich
// (engine='gemini' im Body). Beide teilen bei fal das I/O-Schema.
// Struktur-Parameter: Seedream v5 edit kennt laut Doku (geprueft 10/2026)
// KEINE strength/guidance/denoise-Regler — Inputs sind nur prompt, images,
// aspect_ratio, resolution, output_format. Formtreue muss deshalb ueber
// Prompt-Locks + Geometrie-Anker + Engine-Vergleich kommen.
const FAL_SEEDREAM_EDIT = 'https://fal.run/fal-ai/bytedance/seedream/v5/lite/edit';
const FAL_GEMINI_EDIT = 'https://fal.run/fal-ai/gemini-25-flash-image/edit';
type Engine = 'seedream' | 'gemini';

type Tier = 'lite' | 'pro';
type RenderFall = 'A' | 'B' | 'C' | 'D';

// Ein fal-Edit-Aufruf → Bild-URL. aspect_ratio: Preset aus dem Eingabefoto
// (aspectFromAttachment), 'auto' nur als letzter Fallback.
async function falEdit(imageUrls: string[], prompt: string, aspectRatio: string = 'auto', endpoint: string = FAL_SEEDREAM_EDIT): Promise<string> {
  const r = await fetchT(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${process.env.FAL_API_KEY}` },
    body: JSON.stringify({ prompt, image_urls: imageUrls, aspect_ratio: aspectRatio }),
    timeoutMs: 120000, label: 'fal.ai edit',
  });
  if (!r.ok) throw new Error(`fal.ai edit (${endpoint}): ${await r.text()}`);
  const d = await r.json() as { images?: Array<{ url: string }> };
  const url = d.images?.[0]?.url;
  if (!url) throw new Error('Kein Bild von fal zurückgekommen');
  return url;
}

// ── Helpers ─────────────────────────────────────────────────────────
function queryHash(q: string): string {
  return createHash('md5').update(q.toLowerCase().trim()).digest('hex').slice(0, 12);
}

function cacheKey(systemId: string, q: string, capId: string | null, tier: Tier, codeId: string | null, engine: Engine): string {
  // RENDER_VERSION zuerst: aendert sich der Render-Code, aendert sich jeder Key.
  // codeId trennt verschiedene Looks auf DEMSELBEN Base+Query; engine trennt
  // den A/B-Vergleich (sonst liefert der Seedream-Cache das Gemini-Ergebnis).
  return `${RENDER_VERSION}_${systemId}_${queryHash(q)}_${capId || 'none'}_${tier}${codeId ? `_c${codeId.slice(-6)}` : ''}${engine === 'gemini' ? '_g' : ''}`;
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
// Volles dokumentiertes Preset-Set (Seedream v5 edit). v46 kannte nur 8
// Presets — eine 1:2.3-Flasche landete auf 9:16 und wurde gestreckt.
const FAL_RATIOS: Array<[string, number]> = [
  ['21:9', 21 / 9], ['3:1', 3], ['2:1', 2], ['16:9', 16 / 9], ['3:2', 3 / 2],
  ['4:3', 4 / 3], ['5:4', 5 / 4], ['1:1', 1], ['4:5', 4 / 5], ['3:4', 3 / 4],
  ['2:3', 2 / 3], ['9:16', 9 / 16], ['1:2', 1 / 2], ['9:21', 9 / 21], ['1:3', 1 / 3],
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
// mitGrafik=false (Bauplan vorhanden, v54): der Komponenten-Bauplan definiert
// die Deko abschliessend — die achsen-generierte Grafikebene faellt komplett
// weg (die Linien-Spec hatte sonst Streifen erzeugt, die niemand bestellt hat).
function buildHardRule(closureRule: string, forbidden: string[], typoHaltung?: string | null, akzentHex?: string | null, mitGrafik: boolean = true): string {
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
    mitGrafik ? grafikRegel(typoHaltung, akzentHex) : '',
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
  // v49: SF-Hinweise (unbestätigt/ausgeschlossen) — gehen in
  // farbsystem.warnungen. Ein Look blockiert NIE mehr.
  sfWarnungen: string[];
  umleitung: string | null;
  brand: string;
  produkt: string;
  wirkungBeschreibung: string | null;
  doNot: string[]; // Do_Not des Codes — Geschmacks-Verbote (deutsch, kuratiert)
  // v51: Bauplan-JSON (Design_Komponenten) — besitzt bei Vorhandensein den
  // Bild-Prompt exklusiv (v54: einzige Welt-Quelle fuer den Prompt).
  komponenten: string | null;
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
  // v51: deutsche Umsetzungs-Schritte der Mapping-Engine fuer die UI.
  umsetzung?: string[];
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
  forceCodeId: string,
  // v48: ID des gewaehlten Caps — fuer die Closure-Warnung (Geschwister-
  // Varianten des Systems nachschlagen, den gewaehlten ausnehmen).
  selectedCapId: string | null
): Promise<{
  fullPrompt: string; basePrompt: string; capPrompt: string | null;
  forbidden: string[]; concept: Concept;
}> {
  const designCodesAll = await airtableListAll(DESIGN_CODE_TABLE);

  // ── Attribut-Ground-Truth — Constraints UND Geometrie-Namen ────────
  // v47: Die getaggten Attribut-NAMEN (System + Cap) werden zum teil-
  // spezifischen Geometrie-Anker im Prompt. Nur vorhandene Tags, nichts
  // erfunden; fehlende Attribute fallen einfach weg.
  const attrIds: string[] = Array.isArray(sysFields['Attribute']) ? sysFields['Attribute'] : [];
  const capAttrIds: string[] = (capFields && Array.isArray(capFields['Cap_Attribute'])) ? capFields['Cap_Attribute'] : [];
  const holeAttr = async (ids: string[]): Promise<any[]> => {
    if (!ids.length) return [];
    const formula = `OR(${ids.slice(0, 25).map(id => `RECORD_ID()='${id}'`).join(',')})`;
    return airtableQuery(ATTRIBUT_TABLE, formula, ['A_Name (Wert)', 'Render_Constraint'], 25);
  };
  let attrConstraints: string[] = [];
  let attrNamen: string[] = [];
  let capAttrNamen: string[] = [];
  try {
    const [sysRecs, capRecs] = await Promise.all([holeAttr(attrIds), holeAttr(capAttrIds).catch(() => [] as any[])]);
    attrConstraints = sysRecs.map(r => String(r.fields['Render_Constraint'] || '').trim()).filter(Boolean);
    attrNamen = sysRecs.map(r => String(r.fields['A_Name (Wert)'] || '').trim()).filter(Boolean);
    capAttrNamen = capRecs.map(r => String(r.fields['A_Name (Wert)'] || '').trim()).filter(Boolean);
  } catch { attrConstraints = []; attrNamen = []; capAttrNamen = []; }

  // Geometrie-Filter: nur FORM-Attribute in den Anker. Farb-/Finish-/Material-
  // Tags ("High Gloss", "Metallic Silver", "Colorless / Clear") beschreiben den
  // IST-Zustand, den der Recolor aendern darf — die wuerden das Umfaerben
  // blockieren oder die alte Farbe zurueckholen. Ausschluss gewinnt.
  const GEO_JA = /cylindric|cubical|square|tall|narrow|elongat|balanced|slim|wide|neck|straight|taper|shoulder|bottom|flat top|double.?wall|thick|thin|wall|edge|smaller than body|larger than body|round|step|ring|plinth|collar|actuator/i;
  const GEO_NEIN = /gloss|matt|metallic|silver|gold|chrome|chrom|lacquer|colou?r|transparent|opaque|clear|frost|visible|hidden|contrast|continuous|untreated|white|black|pcr|plastic|aluminum|aluminium|glass|none/i;
  const geoFilter = (n: string) => GEO_JA.test(n) && !GEO_NEIN.test(n);

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
  // ── v49 — NIE BLOCKIEREN (DESIGN-ENTSCHEID "jede Welt auf jedes Teil") ─
  //   bestätigt      -> direkt (wie immer).
  //   UNBESTAETIGT   -> Render laeuft NORMAL (volle Ausprägung), dazu eine
  //                     Warnung "vor Musterung mit dem Lieferanten klären".
  //                     Die alte Vorsichts-Umleitung bei unknown ist raus.
  //   AUSGESCHLOSSEN -> automatische Typ-B-Umleitung (Farbe in die
  //                     Fluessigkeit) bzw. Kaskade, plus Warnung "nur als
  //                     <Umleitung> umsetzbar". Nie ein Block, nie ein Throw.
  const ANFORDERUNG_DE: Record<string, string> = {
    braucht_einfaerbbar: 'Körper einfärbbar', braucht_opak: 'opake Ausführung',
    braucht_frostbar: 'Mattierung', braucht_klarglas: 'Klarglas-Körper',
    braucht_cap_weiss: 'weisser Verschluss', braucht_metallcap: 'Metall-Verschluss',
  };
  const designCodes: DesignCodeRec[] = designCodesAll
    .filter(r => selectName(r.fields['Status']) === 'Aktiv')
    .map(r => {
      const f = r.fields;
      const anford = multiSelectNames(f['Anforderungen']);
      let bodyBehandlung = (selectName(f['Body_Behandlung']) || 'opak_recolor').toLowerCase();
      let farbort = (selectName(f['Farbort']) || 'koerper').toLowerCase();
      let umleitung: string | null = null;
      const sfWarnungen: string[] = [];

      const wantsBodyColor = ['getönt', 'getoent', 'opak_recolor'].includes(bodyBehandlung)
        && farbort === 'koerper';
      const bodyColorState = koerperFarbe();
      if (wantsBodyColor && bodyColorState === 'unknown') {
        // v49: NICHT mehr umleiten — normal rendern, ehrlich warnen.
        sfWarnungen.push(`Anforderung 'Körper einfärbbar' ist für dieses Teil unbestätigt — vor Musterung mit dem Lieferanten klären.`);
      } else if (wantsBodyColor && bodyColorState === 'excluded') {
        bodyBehandlung = 'klar_liquid_farbe';
        farbort = 'liquid';
        umleitung = `Typ B: Koerper NICHT faerbbar (Lieferant) -> Farbe in die Fluessigkeit umgeleitet, Gebinde bleibt klar`;
        sfWarnungen.push(`Dieser Look ist auf diesem Teil nur als Umleitung umsetzbar: die Farbe wandert in die Flüssigkeit, der Körper bleibt unverändert.`);
      }
      // ── Ausspraegungs-Kaskade (nur noch bei BELEGTEM Ausschluss) ──
      let stufe: 3 | 2 | 1 = umleitung ? 2 : 3;
      const verlust: string[] = [];
      if (umleitung) verlust.push('Körperfarbe — die Farbe sitzt jetzt in der Flüssigkeit, das Gebinde bleibt klar');

      const frostState = checkAnforderung('braucht_frostbar');
      if (bodyBehandlung === 'frosted' && frostState === 'unknown') {
        sfWarnungen.push(`Anforderung 'Mattierung' ist für dieses Teil unbestätigt — vor Musterung mit dem Lieferanten klären.`);
      } else if (bodyBehandlung === 'frosted' && frostState === 'excluded') {
        bodyBehandlung = isGlassBody ? 'klar' : 'opak_recolor';
        stufe = 1;
        verlust.push('mattierte Oberfläche — dieses Teil ist laut Lieferant nicht mattierbar, der Körper bleibt glatt');
        sfWarnungen.push(`Dieser Look ist auf diesem Teil nur ohne Mattierung umsetzbar (Lieferant schliesst sie aus).`);
      }
      if (anford.includes('braucht_klarglas') && !isGlassBody) {
        if (TRANSPARENT_BEHANDLUNG.includes(bodyBehandlung)) { bodyBehandlung = 'opak_recolor'; farbort = 'koerper'; }
        stufe = 1;
        verlust.push('durchsichtiger Körper — dieses Teil ist nicht aus Glas, die Haltung läuft über Farbe, Verschluss und Druck');
        sfWarnungen.push(`Dieser Look lebt von Klarglas — auf diesem Teil läuft die Haltung über Farbe und Druck.`);
      }
      // Restliche Anforderungen: unbestätigt warnen, Ausschluss ehrlich
      // benennen — aber nie blockieren ("beste ehrliche Interpretation").
      for (const a of anford) {
        if (['braucht_einfaerbbar', 'braucht_opak', 'braucht_frostbar', 'braucht_klarglas'].includes(a)) continue; // oben behandelt
        const s = checkAnforderung(a);
        const nameDe = ANFORDERUNG_DE[a] || a;
        if (s === 'unknown') sfWarnungen.push(`Anforderung '${nameDe}' ist für dieses Teil unbestätigt — vor Musterung mit dem Lieferanten klären.`);
        else if (s === 'excluded') sfWarnungen.push(`Anforderung '${nameDe}' ist auf diesem Teil nicht umsetzbar — der Render zeigt die beste ehrliche Interpretation.`);
      }
      return {
        id: r.id,
        name: String(f['Name'] || ''),
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
        stufe, verlust, sfWarnungen,
        umleitung,
        brand: String(f['Brand'] || '').trim(),
        produkt: String(f['Produkt'] || '').trim(),
        wirkungBeschreibung: (() => {
          const v = fieldAny(f, ['Wirkung_Beschreibung', 'Wirkung_Beschreibung ', 'Wirkungsbeschreibung']);
          return v ? String(v).trim() : null;
        })(),
        doNot: teileListe(fieldAny(f, ['Do_Not', 'Do_not', 'DoNot'])),
        komponenten: (() => { const v = fieldAny(f, ['Design_Komponenten']); return v ? String(v).trim() : null; })(),
      };
    });

  // ── Der gewaehlte Code (forceCodeId ist die Entscheidung des Nutzers) ─
  // v49: Produzierbarkeit blockiert NIE mehr — unbestätigt rendert normal
  // mit Warnung, ausgeschlossen rendert umgeleitet mit Warnung. Der einzige
  // verbliebene Fehler: die ID existiert nicht oder der Code ist inaktiv.
  const code = designCodes.find(c => c.id === forceCodeId) || null;
  if (!code) {
    throw new Error(`Design-Code ${forceCodeId} nicht gefunden oder nicht aktiv`);
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

  // v49: 'unknown' rendert wie faerbbar (Nie-Blockieren-Policy; die Warnung
  // traegt die Ehrlichkeit). Nur ein BELEGTER Ausschluss nimmt dem Koerper
  // die Farbe — und der ist oben bereits zur Typ-B-Umleitung geworden.
  const bodyFarbeState = koerperFarbe();
  const colorable = bodyFarbeState !== 'excluded';
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
  // v49: SF-Hinweise (unbestätigt/Umleitung) landen als ehrliche Zeilen auf
  // dem Blatt — das Frontend zeigt farbsystem.warnungen bereits an.
  farbsys.warnungen.push(...code.sfWarnungen);

  // ── v50 — Render_Zonen: die Ziel-Zone kommt aus dem Foto, nicht aus
  // der Heuristik. primary_canvas traegt die Welt; ist er nicht faerbbar,
  // uebernimmt redirect_canvas. Zonen mit colorable 'none' werden dem
  // Modell explizit als unantastbar benannt.
  type Zone = { id: string; material?: string; transparent?: boolean; colorable?: string; notes?: string };
  let zonen: { zones: Zone[]; primary: string; redirect: string | null } | null = null;
  try {
    const zr = sysFields['Render_Zonen'] ? JSON.parse(String(sysFields['Render_Zonen'])) : null;
    if (zr && Array.isArray(zr.zones) && zr.zones.length && typeof zr.primary_canvas === 'string'
        && zr.zones.some((z: any) => z && z.id === zr.primary_canvas)) {
      zonen = {
        zones: zr.zones as Zone[],
        primary: zr.primary_canvas,
        redirect: (typeof zr.redirect_canvas === 'string' && zr.zones.some((z: any) => z && z.id === zr.redirect_canvas)) ? zr.redirect_canvas : null,
      };
    }
  } catch { zonen = null; }
  const ZONE_EN: Record<string, string> = {
    outer_wall: 'outer wall', inner_cartridge: 'inner cartridge', liquid: 'liquid content',
    cap: 'closure', base: 'base', sleeve: 'sleeve',
  };
  let zonenLine = '';
  let zonenFarbLine = '';
  if (zonen) {
    const zb = (id: string) => zonen!.zones.find(x => x.id === id);
    const prim = zb(zonen.primary);
    const zielId = (prim && prim.colorable !== 'none') ? zonen.primary : (zonen.redirect || zonen.primary);
    const ziel = zb(zielId);
    const zielEn = ZONE_EN[zielId] || zielId;
    const unber = zonen.zones.filter(x => x.colorable === 'none' && x.id !== 'cap' && x.id !== zielId);
    zonenLine = `Zone map of this exact part (read from its photo): ${zonen.zones.map(x => `the ${ZONE_EN[x.id] || x.id} is ${x.material || 'as shown'}${x.transparent ? ' (transparent)' : ''}${x.colorable === 'none' ? ' — it stays untouched' : ''}`).join('; ')}. Apply the world's colour treatment ONLY to the ${zielEn}${ziel && ziel.colorable === 'tint' ? ', as a translucent tint' : ''}${unber.length ? `; the ${unber.map(x => ZONE_EN[x.id] || x.id).join(' and ')} stay${unber.length === 1 ? 's' : ''} completely untouched, clear and uncoloured` : ''}.`;
    zonenFarbLine = `The colour for the ${zielEn} is a saturated ${codeBodyHexFuellung} with ${bodyFinishEn}.`;
  }

  // ── v51 — MAPPING-ENGINE: Bauplan × Deko-Faehigkeiten × Zonen × Cap ──
  // Deterministisch, VOR dem Prompt-Bau. Erzeugt die EN-Prompt-Zeilen
  // (kompLines), den Cap-Plan und die deutschen umsetzung-Schritte.
  type Komponenten = {
    behaelter?: { farbe?: string | null; verlauf?: { von?: string; nach?: string; richtung?: string } | null; transparenz?: string; produkt_sichtbar?: boolean; finish?: string; farb_hinweis?: string | null };
    grafik?: { beschreibung?: string; abdeckung?: string };
    label?: { vorhanden?: boolean; farbe?: string | null; abdeckung?: string | null; stil?: string | null };
    verschluss?: { farbe?: string; finish?: string };
    akzente?: string[];
  };
  let komp: Komponenten | null = null;
  try {
    const k = code.komponenten ? JSON.parse(code.komponenten) : null;
    if (k && k.behaelter && typeof k.behaelter === 'object') komp = k as Komponenten;
  } catch { komp = null; }

  const deko = new Set(multiSelectNames(sysFields['Deko_Faehigkeiten']).map(s => s.toLowerCase()));
  const capEinfaerbbar = !!(capFields && capFields['Einfaerbbar'] === true);
  const kompLines: string[] = [];
  const umsetzung: string[] = [];
  // Cap-Plan: einfaerben nur bei Kunststoff-Cap UND ohne explizite Nutzer-Wahl.
  let capPlanEinfaerben = false;
  let capPlanFarbe: string | null = null;
  let capPlanFinishEn = 'a clean matt finish';
  // true sobald der Plan ein Etikett vorsieht — dann faellt das pauschale
  // Label-Verbot aus den Preserve-Zeilen (No-Text bleibt global).
  let kompLabelGeplant = false;

  if (komp) {
    const b = komp.behaelter || {};
    const verlauf = (b.verlauf && b.verlauf.von && b.verlauf.nach) ? b.verlauf : null;
    const grafikTxt = String(komp.grafik?.beschreibung || '').trim();
    const grafikSichtbar = !!komp.grafik && komp.grafik.abdeckung !== 'keine' && grafikTxt && grafikTxt.toLowerCase() !== 'none';
    const TRANS_EN: Record<string, string> = {
      opak: 'opaque', transparent: 'clear transparent',
      leicht_transparent: 'lightly translucent', getoent: 'tinted translucent',
    };
    const transparenzEn = TRANS_EN[b.transparenz || 'opak'] || 'opaque';
    const FINISH_EN_K: Record<string, string> = {
      glossy: 'a clean glossy finish', matt: 'a premium matte finish',
      soft_touch: 'a soft-touch matte coating', metallic: 'a metallic finish',
    };
    const kFinishEn = FINISH_EN_K[b.finish || 'glossy'] || FINISH_EN_K.glossy;
    const RICHTUNG_EN: Record<string, string> = {
      vertikal_oben_nach_unten: 'vertically, fully saturated at the top and fading cleanly downwards',
      vertikal_unten_nach_oben: 'vertically, fully saturated at the bottom and fading cleanly upwards',
      horizontal: 'horizontally', diagonal: 'diagonally',
    };
    const verlaufEn = verlauf
      ? `a smooth gradient from ${verlauf.von} to ${verlauf.nach}, running ${RICHTUNG_EN[verlauf.richtung || ''] || 'vertically'}`
      : '';
    const weltBildEn = [verlauf ? verlaufEn : (b.farbe ? `the solid colour ${b.farbe}` : ''), grafikSichtbar ? grafikTxt : '']
      .filter(Boolean).join(', plus ') || 'the world colour';

    // Label-Geometrie nach Teiltyp: Tiegel IMMER seitlich, Tube front.
    const typeNameK = selectName(sysFields['Type']).toLowerCase();
    const istTiegel = /tiegel|jar/.test(typeNameK);
    const istTube = /tube/.test(typeNameK);
    const labelOrtEn = (abdeckung: string | null | undefined): string => {
      if (istTiegel) return 'ONLY on the side wall of the jar — a clean band that never wraps fully around and NEVER touches or crosses the lid edge or the top';
      if (istTube) return 'on the front face of the tube';
      const map: Record<string, string> = {
        front_panel: 'covering only the front panel',
        wrap: 'as a wrap-around label with one clean seam',
        // v52: Teilflaeche heisst Teilflaeche — der Behaelter bleibt rundum
        // sichtbar, das Label wirkt nie wie eine Vollfront.
        seitlich: 'covering only about one third of the front width, offset to one side — a crisp rectangle with sharp edges, clearly NOT wrapping around; the container surface stays visible all around it',
        partiell: 'as a small partial panel covering only about one third of the front width, offset to one side, with the container surface clearly visible around it',
      };
      return map[abdeckung || 'front_panel'] || 'covering only the front panel';
    };
    const labelOrtDe = istTiegel ? 'nur seitlich (Tiegel-Regel: nie über die Deckelkante)' : istTube ? 'auf der Front' : ({ front_panel: 'auf dem Front-Panel', wrap: 'als Rundum-Etikett', seitlich: 'seitlich versetzt als Teilfläche (ca. 1/3 der Front)', partiell: 'als Teilpanel (ca. 1/3 der Front)' } as Record<string, string>)[komp.label?.abdeckung || 'front_panel'] || 'auf dem Front-Panel';

    const farbeFix = deko.has('farbe_fix');
    const kannMasse = deko.has('einfaerbung_masse');
    const kannDruck = deko.has('direktdruck');
    const kannEtikett = deko.has('etikett');
    const kannLack = deko.has('spruehlackierung');

    // ── 1) Behaelter-Strategie ───────────────────────────────────────
    let labelTraegtWelt = false;
    if (farbeFix && (kannEtikett || kannDruck)) {
      // Behaelterfarbe unantastbar (z.B. Braunglas) -> Welt wandert auf
      // Etikett (bevorzugt) oder Direktdruck; das Material bleibt sichtbar.
      if (kannEtikett) {
        kompLines.push(`The container material and its own colour stay COMPLETELY untouched and visible — do not recolor, tint or coat it; e.g. amber glass stays amber glass. Apply the design world as a clean label ${labelOrtEn(komp.label?.abdeckung)}: the label carries ${weltBildEn}, printed edge to edge on the label, smooth flat edges, NO text, no letters, no logos.`);
        labelTraegtWelt = true;
        umsetzung.push(`${verlauf ? 'Verlauf' : 'Farbwelt'} als Etikett ${labelOrtDe} — die Behälterfarbe ist fix und bleibt sichtbar`);
      } else {
        kompLines.push(`The container material and its own colour stay COMPLETELY untouched and visible. Apply the design world as direct print on the surface: ${weltBildEn}, covering only part of the surface, NO text, no logos.`);
        umsetzung.push(`${verlauf ? 'Verlauf' : 'Farbwelt'} als Direktdruck — die Behälterfarbe ist fix`);
      }
    } else if ((verlauf || grafikSichtbar) && kannDruck) {
      kompLines.push(`Apply the design world as DIRECT PRINT onto the container surface: ${weltBildEn}. The print lies flat on the material and follows its curvature${b.transparenz !== 'opak' ? `; the container wall itself stays ${transparenzEn}` : ''}. ${b.finish ? `The surface has ${kFinishEn}.` : ''} NO text, no letters, no logos in the print.`);
      umsetzung.push(`${verlauf ? 'Verlauf' : 'Grafik'} als Direktdruck auf den Körper`);
    } else if ((verlauf || grafikSichtbar) && kannEtikett) {
      kompLines.push(`Apply the design world as a clean label ${labelOrtEn(komp.label?.abdeckung)}: the label carries ${weltBildEn}, smooth flat edges, NO text, no logos. The container material outside the label stays untouched.`);
      labelTraegtWelt = true;
      umsetzung.push(`${verlauf ? 'Verlauf' : 'Grafik'} als Etikett ${labelOrtDe} — Direktdruck ist auf diesem Teil nicht verfügbar`);
    } else if ((kannMasse || kannLack) && b.farbe) {
      if ((b.transparenz || 'opak') === 'opak') {
        kompLines.push(`Colour the container body as ONE solid opaque ${b.farbe} with ${kFinishEn}, applied in the material itself.`);
        umsetzung.push(`Körper opak ${b.farbe} eingefärbt (${kannMasse ? 'Masse-Einfärbung' : 'Sprühlackierung'})`);
      } else {
        // v52: Tints saufen sonst ab (Indigo wurde Lavendel) — der Ton bleibt
        // dunkel und satt, Licht geht durch, die Farbe verwaessert nie.
        kompLines.push(`Tint the container ${b.farbe} as deeply saturated ${transparenzEn} material with ${kFinishEn} — a dark, rich jewel tone: light passes through, but the tint itself stays dark, dense and intense; the colour never washes out, never pale, never pastel${b.produkt_sichtbar ? '; the product inside stays visible through the tinted wall, reading softly milky through the colour, with a visible fill line' : ''}. Do not make it opaque.`);
        umsetzung.push(`Körper ${b.transparenz === 'getoent' ? 'getönt' : 'leicht transparent'} ${b.farbe} eingefärbt${b.produkt_sichtbar ? ' — Produkt bleibt sichtbar' : ''}`);
      }
    } else if (zonen) {
      // WO uebernimmt die Zonen-Zeile (v50); Farbe der Welt in die Ziel-Zone.
      kompLines.push(zonenLine);
      kompLines.push(`The colour for that zone is ${weltBildEn}.`);
      umsetzung.push('Farbwelt in die sichtbare Innen-Zone — der Körper selbst trägt keine Dekoration');
    } else {
      kompLines.push(bodyLineEn);
      umsetzung.push('Körperbehandlung wie Standard — keine Deko-Fähigkeiten getaggt');
    }
    // v52: optionaler Farb-Charakter aus dem Bauplan ("deep, dark, rich —
    // never lavender") — verankert den Ton explizit gegen Verwaessern.
    if (b.farb_hinweis && String(b.farb_hinweis).trim()) {
      kompLines.push(`Colour character of the container: ${String(b.farb_hinweis).trim()}.`);
    }
    // Zonen-Zeile zusaetzlich (WO + Unantastbares), wenn nicht schon gepusht.
    if (zonen && !kompLines.includes(zonenLine)) kompLines.push(zonenLine);

    // ── 2) Welt-Label (eigener Baustein, falls nicht schon Welt-Traeger) ─
    if (komp.label?.vorhanden && !labelTraegtWelt && kannEtikett) {
      kompLines.push(`Add a clean ${komp.label.farbe || '#FFFFFF'} label ${labelOrtEn(komp.label.abdeckung)}${komp.label.stil ? ` — ${komp.label.stil}` : ''}; smooth flat edges, NO text, no letters, no logos on it.`);
      umsetzung.push(`${komp.label.farbe === '#FFFFFF' || !komp.label.farbe ? 'Weisses' : 'Farbiges'} Label ${labelOrtDe}`);
    }

    kompLabelGeplant = labelTraegtWelt || !!(komp.label?.vorhanden && kannEtikett);

    // ── 3) Akzente ───────────────────────────────────────────────────
    if (Array.isArray(komp.akzente) && komp.akzente.length) {
      kompLines.push(`Accents, exactly as listed and nothing more: ${komp.akzente.slice(0, 3).join('; ')}.`);
    }

    // ── 4) Verschluss-Plan ───────────────────────────────────────────
    // v51 ersetzt den v48-Absolutismus: ein KUNSTSTOFF-Cap darf in die
    // Welt-Farbe (Masse-Einfaerbung ist real) — ausser der Nutzer hat
    // explizit eine Variante gewaehlt. Metall bleibt immer unveraendert.
    const vFarbe = komp.verschluss?.farbe || null;
    const CAP_FIN_K: Record<string, string> = { matt: 'a clean matt finish', glossy: 'a clean glossy finish', metallic: 'a polished metallic finish' };
    capPlanFinishEn = CAP_FIN_K[komp.verschluss?.finish || 'matt'] || CAP_FIN_K.matt;
    // v55 (Alens Regel): Die Cap-WAHL bestimmt nur Mechanik/Geometrie — die
    // FARBE kommt IMMER von der Welt, sofern der Cap einfaerbbar ist. Einzige
    // Ausnahme: Einfaerbbar=false (Metall/Chrom) -> wie fotografiert + Hinweis.
    if (vFarbe) {
      if (capEinfaerbbar || (!capFields && fall === 'A')) {
        // Fall A ohne Cap-Record: der Verschluss im Foto; Einfaerbung nur,
        // wenn kein Metall-Hinweis in den System-Attributen steckt.
        const metallCapHinweis = attrNamen.some(n => /metallic ring|metal|chrome|aluminium|aluminum/i.test(n));
        if (!capFields && metallCapHinweis) {
          umsetzung.push(`Verschluss bleibt wie fotografiert (Metall) — die Welt sieht ${vFarbe} vor`);
        } else {
          capPlanEinfaerben = true;
          capPlanFarbe = vFarbe;
          umsetzung.push(`Verschluss ${vFarbe}${komp.verschluss?.finish ? ` ${komp.verschluss.finish}` : ''} (Masse-Einfärbung des Kunststoff-Caps)`);
        }
      } else {
        // Warnung dazu kommt aus dem Closure-Warnblock unten (v54, mit
        // passender Varianten-Empfehlung) — hier nur der Umsetzungs-Schritt.
        umsetzung.push(`Verschluss bleibt wie fotografiert (Metall/nicht einfärbbar) — die Welt sieht ${vFarbe} vor`);
      }
    }
  }

  // ── Geteilte Bausteine fuer ALLE Prompts (Vollbild, Split-Base, Cap) ─
  const attrLine = attrConstraints.length
    ? `Fixed physical characteristics of this exact product: ${attrConstraints.slice(0, 10).join('; ')}.`
    : '';
  // ── Geometrie-Anker aus den Daten (v47) ────────────────────────────
  // Teil-spezifische Preserve-Aufzaehlung statt generischem "keep the shape":
  // Form + Neck_Norm + Closure + die getaggten Form-Attribute. Der erzwungene
  // Umlack (Chrom -> Weiss) laesst das Modell die Pumpform sonst aus seinem
  // Prior neu erfinden — der Anker benennt jedes Teil, das bleiben muss.
  const FORM_EN: Record<string, string> = {
    rund: 'round', schlank: 'slim', eckig: 'angular', oval: 'oval',
    konisch: 'conical', flach: 'flat', breit: 'wide', quadratisch: 'square',
  };
  const formEnStr = multiSelectNames(sysFields['Form'])
    .map(f => FORM_EN[f.toLowerCase()] || '').filter(Boolean).join(', ');
  const neckNorm = multiSelectNames(sysFields['Neck_Norm']).filter(Boolean).join(', ');
  const geoTraits = [...new Set(attrNamen.filter(geoFilter))].slice(0, 12);
  const geoBits: string[] = [];
  if (formEnStr) geoBits.push(`the ${formEnStr} body silhouette`);
  if (neckNorm) geoBits.push(`the ${neckNorm} neck finish`);
  if (closureCoverage.length) geoBits.push(`the complete ${closureCoverage.join('/')} mechanism with its slim actuator and every collar ring and step`);
  if (geoTraits.length) geoBits.push(`its tagged build: ${geoTraits.join(', ')}`);
  const geoAnkerLine = geoBits.length
    ? `Preserve exactly as in the photo, part by part: ${geoBits.join('; ')}. Keep wall thickness, the visible gap between outer wall and inner cartridge where present, the cartridge's own shoulder, the base, and the overall height-to-width ratio unchanged.`
    : '';
  // Cap-Beschreibung — v48 nur noch fuer die Closure-Warnung (der Cap-Render
  // ist reines Cleanup, er braucht keinen Anker mehr).
  const capClosureEn = capFields
    ? multiSelectNames(capFields['Closure_Type']).concat(selectName(capFields['Closure_Type']) || []).filter(Boolean).join('/')
    : '';
  // Unveraendert-Lock (v48, DESIGN-ENTSCHEID "Der Verschluss wird gewaehlt,
  // nie umlackiert"): der Umlack selbst war der Trigger der Form-Drift —
  // deshalb gibt es ihn nicht mehr. Der Cap bleibt exakt wie fotografiert.
  const capUnveraendertLock = `The closure in the photo stays completely unchanged — identical colour, material, finish, geometry.`;
  // v51: Kunststoff-Cap wird in die Welt-Farbe eingefaerbt (Masse-Einfaerbung
  // ist real) — mit v47-Geometrie-Lock: NUR Farbe/Finish, nie die Form.
  const capRecolorLock = (capPlanEinfaerben && capPlanFarbe)
    ? `Recolor ONLY the closure to a solid ${capPlanFarbe} with ${capPlanFinishEn} — mass-coloured plastic, not paint. Keep its exact geometry: every collar ring, step, edge, thread and the actuator shape stay identical to the photo; change nothing but its colour and finish.`
    : '';
  const materialLine = `The body is ${matEN}${isPlastic ? ' — it must clearly read as a plastic container, never as solid metal, aluminium, steel, glass or ceramic' : ''}.`;
  const capMaterialLine = capMaterial ? `The cap is ${capMaterial}.` : '';
  const avoidLine = doNotZeile((traegerOrt === 'Material')
    // Transparenz-Verbote rausfiltern, wenn die Wand sichtbar klar bleibt.
    ? code.doNot.filter(d => !/transparen|durchsichtig|klarglas/i.test(d))
    : code.doNot);
  const studioLine = kompLabelGeplant
    // v51: Label ist geplant — das Verbot schrumpft auf No-Text (das Etikett
    // selbst bleibt komplett blanko).
    ? `Clean seamless white studio background, soft neutral lighting, centered product packshot. No text, no letters, no numbers, no logo anywhere on the product — any label stays completely blank.`
    : `Clean seamless white studio background, soft neutral lighting, centered product packshot. No text, no label graphics, no logo, no lettering anywhere on the product.`;
  const codeAkzentEn = akzentCueEn(code.akzentCue, code.akzentHex);

  // ── Vollbild-Prompt (Fall A/B, ein Render) ─────────────────────────
  const fullLines: string[] = [];
  fullLines.push(kompLabelGeplant
    // v51: Label geplant -> das pauschale Label-Verbot faellt; die Deko-
    // Beschreibung unten besitzt, WAS auf die Oberflaeche darf.
    ? `Keep the exact same packaging shape, silhouette, proportions, neck and closure as shown in reference image 1 — change ONLY surface colours, finishes and the decoration described below.`
    : `Keep the exact same packaging shape, silhouette, proportions, neck and closure as shown in reference image 1 — change ONLY the surface color and finish. Do NOT add any label, sticker, printed panel or white patch — the surface stays one uninterrupted, continuous material.`);
  if (geoAnkerLine) fullLines.push(geoAnkerLine);
  if (attrLine) fullLines.push(attrLine);
  if (fall === 'B') {
    // v19-Carmen-Muster, v48 reaktiviert: der Ersatz-Cap wird eingesetzt,
    // wie er fotografiert ist. v51: ist er Kunststoff (Einfaerbbar) und der
    // Nutzer hat nicht explizit gewaehlt, wird er in die Welt-Farbe gefaerbt.
    fullLines.push((capPlanEinfaerben && capPlanFarbe)
      ? `Image 1 shows the bottle WITH its existing cap, image 2 the replacement cap. REPLACE the original cap from image 1 with the cap from image 2 — identical geometry, parts and proportions as image 2, do not merge them, do not invent a new cap — but recolor that cap to a solid ${capPlanFarbe} with ${capPlanFinishEn}; change nothing about its shape.`
      : `Image 1 shows the bottle WITH its existing cap, image 2 the replacement cap. REPLACE the original cap from image 1 with the cap from image 2 exactly as shown — do not merge them, do not invent a new cap. Use ONLY the closure shown in image 2, EXACTLY as photographed — identical colour, material, finish and geometry. Do NOT recolor, retint or restyle it. Ignore any closure colour mentioned elsewhere in this prompt.`);
  } else {
    fullLines.push((capPlanEinfaerben && capPlanFarbe) ? capRecolorLock : capUnveraendertLock);
  }
  fullLines.push(materialLine);
  if (capMaterialLine) fullLines.push(capMaterialLine);
  if (komp) {
    // v51/v54: der Bauplan besitzt den Bild-Prompt exklusiv.
    for (const l of kompLines) fullLines.push(l);
  } else {
    if (zonen) { fullLines.push(zonenLine); fullLines.push(zonenFarbLine); }
    else fullLines.push(bodyLineEn);
    // v48: KEINE Cap-Farbzeile mehr. Akzent-Cues sitzen am Verschluss-Kragen
    // (metallic_band/gold_ring) — nur die koerpergebundene Praegung bleibt.
    if (codeAkzentEn && code.akzentCue === 'praegung') fullLines.push(`Add ${codeAkzentEn}.`);
    // Farbhierarchie nur ohne Zonen (die Zone-Zeile ist praeziser) und wenn
    // sie nicht den Verschluss adressiert.
    if (!zonen && farbsys.regelEn && farbsys.laut !== 'Gegenspieler') fullLines.push(farbsys.regelEn);
  }
  if (avoidLine) fullLines.push(avoidLine);
  fullLines.push(studioLine);
  const closureRuleFull = (capPlanEinfaerben && capPlanFarbe)
    // v51: der Cap-Plan besitzt die Closure-Regel — Form-Lock bleibt hart.
    ? (fall === 'A'
        ? `Do not add, remove, replace or reshape the closure. ${capRecolorLock}`
        : `Use ONLY the closure shown in image 2 with its exact geometry, parts and proportions — recolor it to a solid ${capPlanFarbe} with ${capPlanFinishEn} and change nothing else about it.`)
    : fall === 'A'
    ? `Do not add, remove, replace or restyle the closure. ${capUnveraendertLock}`
    : 'Use ONLY the closure shown in image 2, EXACTLY as photographed — identical colour, material, finish and geometry. Do NOT recolor, retint or restyle it. Ignore any closure colour mentioned elsewhere in this prompt.';
  const fullPrompt = `${fullLines.filter(Boolean).join(' ')}\n\n${buildHardRule(closureRuleFull, forbidden, code.typoHaltung, code.akzentHex, !komp)}`;

  // ── Split-Prompts (Fall C/D): Base und Cap GETRENNT, gleiche Bausteine ─
  // Einzelbild-Edit ist formtreu; zwei Produktbilder zusammen = Drift
  // (bewiesen, 2x reproduziert). Beide Prompts zitieren DENSELBEN Code.
  const baseLines: string[] = [];
  baseLines.push(kompLabelGeplant
    ? `Keep the exact same body shape, silhouette and proportions as reference image 1 — change ONLY surface colours, finishes and the decoration described below. Preserve the exact narrow threaded neck exactly as in the reference image — same width, same threads, same shoulder; do NOT widen, flare, open up or reshape the neck.`
    : `Keep the exact same body shape, silhouette and proportions as reference image 1 — change ONLY the surface color and finish. Do NOT add any label, sticker, printed panel or white patch — the surface stays one uninterrupted, continuous material. Preserve the exact narrow threaded neck exactly as in the reference image — same width, same threads, same shoulder; do NOT widen, flare, open up or reshape the neck.`);
  if (geoAnkerLine) baseLines.push(geoAnkerLine);
  if (attrLine) baseLines.push(attrLine);
  baseLines.push(materialLine);
  if (komp) {
    for (const l of kompLines) baseLines.push(l); // v51: Bauplan exklusiv
  } else {
    if (zonen) { baseLines.push(zonenLine); baseLines.push(zonenFarbLine); }
    else {
      baseLines.push(bodyLineEn);
      if (farbsys.regelEn) baseLines.push(farbsys.regelEn);
    }
  }
  if (avoidLine) baseLines.push(avoidLine);
  baseLines.push(studioLine);
  const closureRuleBase = 'Do NOT add, draw, imply or attach any cap, closure, lid, dropper, pipette or pump anywhere on the bottle — the neck stays open exactly as in reference image 1.';
  const basePrompt = `${baseLines.filter(Boolean).join(' ')}\n\n${buildHardRule(closureRuleBase, forbidden, code.typoHaltung, code.akzentHex, !komp)}`;

  // Cap-Render (Split): NUR noch Cleanup — Freisteller auf weissem Studio-
  // Hintergrund, OHNE jede Farbaenderung (v48, DESIGN-ENTSCHEID). Das ist
  // das bewaehrte Preserve-Muster.
  const capPreservePrompt = `Keep this closure EXACTLY as shown in the reference image — identical shape, identical parts, identical proportions, identical colour, identical material and finish. Do NOT recolor it, do NOT change anything about the closure itself. Only place it cleanly on a seamless white studio background with soft neutral lighting, centered. The image contains ONLY this closure exactly as in the reference; do NOT add, invent or draw any bottle, jar, vial, container, housing, sleeve, cylinder or chamber — the pump shaft or dip tube stays exactly as shown, nothing added around it. No text, no label, no logo, no lettering anywhere.`;
  // v51: Split-Cap darf eingefaerbt werden, wenn der Plan es sagt — gleicher
  // Cleanup, nur Farbe/Finish aendern sich (Geometrie-Lock wie v47).
  const capRecolorPrompt = (capPlanEinfaerben && capPlanFarbe)
    ? `Recolor this closure to a solid ${capPlanFarbe} with ${capPlanFinishEn} — mass-coloured plastic, not paint. Keep its EXACT shape: identical parts, identical proportions, every collar ring, step, edge, thread and the actuator shape stay exactly as in the reference image; change nothing but colour and finish. Place it cleanly on a seamless white studio background with soft neutral lighting, centered. The image contains ONLY this closure; do NOT add, invent or draw any bottle, jar, vial, container, housing, sleeve, cylinder or chamber — the pump shaft or dip tube stays exactly as shown, nothing added around it. No text, no label, no logo, no lettering anywhere.`
    : null;
  const capPrompt = split ? (capRecolorPrompt || capPreservePrompt) : null;

  // ── Ehrliche Closure-Warnung (v54: Quelle = Bauplan-Verschluss) ─────
  // Der Bauplan nennt den Soll-Verschluss (Design_Komponenten.verschluss).
  // Bleibt der gewaehlte Cap unveraendert (kein Recolor-Plan) und passt er
  // nicht zum Soll, sagt das Blatt es — und nennt die passende Variante des
  // Systems, wenn es eine gibt. Best-Effort: scheitert das Nachladen, faellt
  // nur der Alternativ-Satz weg, nie der Render.
  const FARBE_DE: Record<string, string> = {
    white: 'Weiss', silver: 'Silber', chrome: 'Chrom', metallic: 'Metallic',
    black: 'Schwarz', matt: 'Matt', gold: 'Gold',
  };
  const prefWorte: string[] = [];
  if (komp?.verschluss) {
    // Hex -> Keyword (white/black/silver/gold); Finish ergaenzt matt/metallic.
    const hexWort = (h: string | null | undefined): string | null => {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
      if (!m) return null;
      const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max - min < 30) return max >= 225 ? 'white' : max <= 55 ? 'black' : 'silver';
      if (r > 170 && g > 120 && b < 110) return 'gold';
      return null;
    };
    const w = hexWort(komp.verschluss.farbe);
    if (w) prefWorte.push(w);
    if (komp.verschluss.finish === 'metallic') prefWorte.push('metallic');
    if (komp.verschluss.finish === 'matt') prefWorte.push('matt');
  }
  const passtZu = (text: string) => {
    const t = text.toLowerCase();
    return prefWorte.some(w => t.includes(w) || (w === 'chrome' && /silver|metallic|aluminium|aluminum/.test(t)) || (w === 'silver' && /chrome|metallic/.test(t)));
  };
  // Nur wenn der Cap unveraendert bleibt (kein Einfaerb-Plan) kann er
  // falsch sein — ein Recolor-Plan erfuellt das Soll ohnehin.
  if (prefWorte.length && capFields && !capPlanEinfaerben) {
    const gewaehltText = [...capAttrNamen, capClosureEn, String(capFields['Cap_Name'] || '')].join(' ');
    if (!passtZu(gewaehltText)) {
      let alternativ = '';
      try {
        const alleCapIds: string[] = (Array.isArray(sysFields['Caps']) ? sysFields['Caps'] : []).filter((id: string) => id !== selectedCapId);
        if (alleCapIds.length) {
          const formula = `OR(${alleCapIds.slice(0, 10).map(id => `RECORD_ID()='${id}'`).join(',')})`;
          const geschwister = await airtableQuery(CAP_TABLE, formula, ['Cap_Name', 'Closure_Type', 'Cap_Attribute'], 10);
          const attrAlle = [...new Set(geschwister.flatMap(g => Array.isArray(g.fields['Cap_Attribute']) ? g.fields['Cap_Attribute'] as string[] : []))];
          const attrRecs = await holeAttr(attrAlle);
          const attrName = new Map(attrRecs.map(r => [r.id, String(r.fields['A_Name (Wert)'] || '')]));
          const treffer = geschwister.find(g => passtZu([
            String(g.fields['Cap_Name'] || ''),
            selectName(g.fields['Closure_Type']),
            ...(Array.isArray(g.fields['Cap_Attribute']) ? (g.fields['Cap_Attribute'] as string[]).map(id => attrName.get(id) || '') : []),
          ].join(' ')));
          if (treffer) alternativ = ` Passende Variante: ${String(treffer.fields['Cap_Name'] || 'andere Cap-Variante dieses Systems')}.`;
        }
      } catch { alternativ = ''; }
      const prefDe = prefWorte.map(w => FARBE_DE[w] || w).join('/');
      farbsys.warnungen.push(`Diese Welt sieht einen Verschluss in ${prefDe} vor — dein gewählter Verschluss bleibt unverändert.${alternativ}`);
    }
  }

  // ── Konzept — deterministisch aus dem Code (kein LLM) ──────────────
  const displayHex = [code.bodyHex, code.capHex, code.akzentHex].filter(Boolean) as string[];
  const produzierbar = {
    finish: [BODY_FINISH_DE[code.finishBody] || BODY_FINISH_DE.matt],
    dekoration: [
      ...(AKZENT_CUE_DE[code.akzentCue] ? [AKZENT_CUE_DE[code.akzentCue]] : []),
      ...(bodyFarbeState === 'ok' ? ['Einfärbung Primärbehälter']
        : bodyFarbeState === 'unknown' ? ['Einfärbung Primärbehälter (unbestätigt — mit Lieferant klären)']
        : ['Farbe via Liquid/Cap (Behälter nicht einfärbbar)']),
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
    // v51: deutsche Umsetzungs-Schritte des Bauplans — fuer die UI.
    ...(komp && umsetzung.length ? { umsetzung } : {}),
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

// ── Cache-Schreibhelfer (v49) ─────────────────────────────────────────
// UNKNOWN_FIELD_NAME kippt nie den ganzen Record: das genannte Feld wird
// gedroppt und erneut versucht (max. 5 Felder). Rueckgabe: Record-ID | null.
async function airtableWrite(method: 'POST' | 'PATCH', url: string, fields: Record<string, any>): Promise<string | null> {
  const f: Record<string, any> = { ...fields };
  for (let i = 0; i < 6; i++) {
    const res = await fetchT(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` },
      body: JSON.stringify({ fields: f }),
      timeoutMs: 15000, label: 'airtable write',
    });
    const data = await res.json() as { id?: string; error?: any };
    if (data.id) return data.id;
    if (data.error?.type === 'UNKNOWN_FIELD_NAME') {
      const m = String(data.error?.message || '').match(/"([^"]+)"/);
      if (m?.[1] && m[1] in f) {
        console.warn(`Cache: unbekanntes Feld "${m[1]}" entfernt, retry.`);
        delete f[m[1]];
        continue;
      }
    }
    console.error('Airtable write Fehler:', JSON.stringify(data.error || data));
    return null;
  }
  return null;
}
const cacheCreate = (fields: Record<string, any>) =>
  airtableWrite('POST', `https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}`, fields);
const cachePatch = (id: string, fields: Record<string, any>) =>
  airtableWrite('PATCH', `https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}/${id}`, fields);

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
    engine: engineRoh = 'seedream',
  } = req.body as {
    systemId: string;
    query: string;
    selectedCapId?: string | null;
    tier?: Tier;
    forceCodeId?: string | null;
    nocache?: boolean;
    // A/B-Schalter (v47): 'gemini' rendert mit Gemini 2.5 Flash Image —
    // bekannt stark bei Identitaets-/Formtreue in Edits. Frontend sendet
    // nichts -> Default seedream, kein Frontend-Change noetig.
    engine?: Engine;
  };
  const engine: Engine = engineRoh === 'gemini' ? 'gemini' : 'seedream';
  const falEndpoint = engine === 'gemini' ? FAL_GEMINI_EDIT : FAL_SEEDREAM_EDIT;

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
    // (v55: capExplizit ist raus — die Cap-Wahl steckt in selectedCapId,
    // die Farbe kommt immer von der Welt; ein ignorierter Body-Param
    // aelterer Frontends aendert den Key nicht.)
    const key = cacheKey(systemId, effectiveBrief, selectedCapId, tier, forceCodeId, engine);
    let cached: any[] = [];
    if (!nocache) try {
      // v49: nur Status 'Done' ist ein Treffer — Pending (laeuft noch) und
      // Error (gescheitert) werden frisch gerendert.
      cached = await airtableQuery(
        CACHE_TABLE,
        `AND({Cache_Key}='${key}',{Status}='Done')`,
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
              umsetzung: board.umsetzung, // v51
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
      await assemblePrompt(effectiveBrief, fall, useSplitRender, sys.fields, capFields, forceCodeId, resolvedCapId);

    const renderingPrompt = useSplitRender ? basePrompt : fullPrompt;
    const capPromptUsed: string | null = useSplitRender ? capPrompt : null;

    // ── 6. Persistenz-Garantie (v49): Record VOR dem fal-Call ───────
    // Der Cache-Record existiert ab jetzt IMMER (Status Pending), die
    // cacheId geht mit der Antwort raus -> /api/bild?r= ist sofort stabil
    // adressierbar und die Galerie verliert nie einen Lauf. Nur Status
    // 'Done' zaehlt beim Lesen als Treffer; Error traegt den Fehlertext.
    const boardJson = JSON.stringify({
      palette: concept.palette, design_code: concept.design_code,
      do_not: concept.do_not, farbsystem: concept.farbsystem,
      ...(concept.umsetzung ? { umsetzung: concept.umsetzung } : {}), // v51
    });
    const cacheId: string | null = await cacheCreate({
      Cache_Key: key,
      System: [systemId],
      Teil_Name: String(sys.fields['Page Titel'] || ''),
      Design_Code: [forceCodeId],
      Status: 'Pending',
      Engine: engine,
      Query_Input: query, // roh, nie sanitisiert — Demand-Signal
      Rendering_Prompt: renderingPrompt,
      Cap_Prompt: capPromptUsed || '',
      Konzept_Name: concept.konzept_name || '',
      Konzept_Story: concept.story || '',
      Konzept_Rationale: concept.rationale || '',
      Szene_ID: concept.szene_id || '',
      Produzierbar: concept.produzierbar ? JSON.stringify(concept.produzierbar) : '',
      Board: boardJson,
      Tier: tier,
      Fall: fall,
      Created_At: new Date().toISOString(),
    }).catch(() => null);

    // ── 7. Render ───────────────────────────────────────────────────
    // image_urls = NUR das/die Produktfoto(s); aspect_ratio = Format des
    // jeweiligen Eingabefotos. Scheitert fal, wird der Record ehrlich auf
    // Error gesetzt (Render_Log) und der Client bekommt den 500 wie bisher.
    let renderingUrl: string;
    let capRenderingUrl: string | null = null;
    try {
      if (useSplitRender) {
        const [baseUrl, capUrl] = await Promise.all([
          falEdit([primaryUrl], basePrompt, primaryAspect, falEndpoint),
          falEdit([capImageUrl!], capPrompt!, capAspect, falEndpoint).catch((e) => {
            // Cap-Cleanup darf nie den Gesamt-Render killen: Fallback = Roh-Cap.
            console.error('Cap-Render fehlgeschlagen — zeige Roh-Cap:', e);
            return capImageUrl!;
          }),
        ]);
        // v53: exakt ZWEI Renders, kein Assembly-Call — capRenderingUrl geht
        // immer mit raus, das Frontend stapelt Cap ueber Body (CSS).
        renderingUrl = baseUrl;
        capRenderingUrl = capUrl;
      } else {
        const imgs = (fall === 'A' || !capImageUrl) ? [primaryUrl] : [primaryUrl, capImageUrl];
        renderingUrl = await falEdit(imgs, fullPrompt, primaryAspect, falEndpoint);
      }
    } catch (falErr) {
      if (cacheId) {
        await cachePatch(cacheId, {
          Status: 'Error',
          Render_Log: String(falErr instanceof Error ? falErr.message : falErr).slice(0, 2000),
        }).catch(() => null);
      }
      throw falErr;
    }

    // ── 7b. v56: Massstab messen (Best-Effort, VOR der Antwort) ─────
    // Beide Split-Outputs werden einmal heruntergeladen (die Buffers
    // speist auch der Persist-Schritt), Silhouetten vermessen und daraus
    // die Cap-ELEMENT-Breite relativ zur Body-Element-Breite berechnet:
    // sil = clamp(neckW * typFaktor / bodyMaxW, 0.18..0.6), dann um die
    // Weissraender beider Bilder korrigiert (Element != Silhouette).
    let capScale: number | null = null;
    let bodyBuf: Buffer | null = null;
    let capBuf: Buffer | null = null;
    if (useSplitRender && capRenderingUrl) {
      try {
        [bodyBuf, capBuf] = await Promise.all([
          fetchT(renderingUrl, { timeoutMs: 12000, label: 'mess body' }).then(async r => Buffer.from(await r.arrayBuffer())),
          fetchT(capRenderingUrl, { timeoutMs: 12000, label: 'mess cap' }).then(async r => Buffer.from(await r.arrayBuffer())),
        ]);
        const [mb, mc] = await Promise.all([messeSilhouette(bodyBuf), messeSilhouette(capBuf)]);
        if (mb && mc) {
          const closureText = capFields
            ? [selectName(capFields['Closure_Type']), ...multiSelectNames(capFields['Closure_Type']), String(capFields['Cap_Name'] || '')].join(' ')
            : '';
          const sil = Math.min(0.6, Math.max(0.18, (mb.neckW * capTypFaktor(closureText)) / mb.maxW));
          capScale = Math.round(sil * (mb.maxW / mb.imgW) * (mc.imgW / mc.maxW) * 1000) / 1000;
        }
      } catch (e) {
        console.error('Massstab-Messung uebersprungen:', e);
        capScale = null;
      }
    }

    // ── 8. AUSLIEFERN ZUERST, Bilder persistieren danach ────────────
    // fal-URLs leben ~1h, reicht zum Anzeigen. Die cacheId ist bereits
    // bekannt und geht sofort mit — Bild-Upload + Status Done folgen.
    if (!res.headersSent) {
      res.status(200).json({
        renderingUrl,
        capRenderingUrl,
        capScale,
        renderingPrompt,
        briefUsed: effectiveBrief,
        rejected: forbidden,
        capId: resolvedCapId,
        cacheId,
        cached: false,
        fall,
        tier,
        concept,
      });
    }

    // ── 9. Bilder in den Record (Best-Effort, nach der Antwort) ─────
    // Ab hier darf alles scheitern, ohne den Nutzer zu betreffen. Ein
    // haengen gebliebener Upload laesst den Record auf Pending/Error —
    // und damit nie als Cache-Hit oder Galerie-Eintrag luegen.
    if (cacheId) try {
      const log: string[] = [];
      // v52: 15s rissen heute ab ("Persist: Timeout 15000ms") — der Download
      // ist Best-Effort NACH der Antwort, er darf sich Zeit nehmen.
      // v56: die Mess-Buffers werden wiederverwendet (kein Doppel-Download).
      const imgBuffer: Buffer = bodyBuf || Buffer.from(await (await fetchT(renderingUrl, { timeoutMs: 45000, label: 'fal img download' })).arrayBuffer());
      const uploadRes = await fetch(
        `https://content.airtable.com/v0/${AIRTABLE_BASE}/${cacheId}/${CACHE_IMAGE_FIELD}/uploadAttachment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` },
          body: JSON.stringify({
            contentType: 'image/jpeg',
            file: imgBuffer.toString('base64'),
            filename: `render_${sys.fields['Page Titel'] || systemId}_${tier}_${Date.now()}.jpg`,
          }),
        }
      );
      if (!uploadRes.ok) {
        const t = await uploadRes.text();
        console.error('Airtable upload (Base) failed:', t);
        await cachePatch(cacheId, { Status: 'Error', Render_Log: `Bild-Upload fehlgeschlagen: ${t.slice(0, 1500)}` }).catch(() => null);
        return;
      }
      // Cap-Bild SYMMETRISCH als echten Anhang (Bytes, nicht die fal-URL).
      if (capRenderingUrl) {
        try {
          const capUpBuf = capBuf || Buffer.from(await (await fetchT(capRenderingUrl, { timeoutMs: 30000, label: 'fal cap download' })).arrayBuffer());
          const capUploadRes = await fetch(
            `https://content.airtable.com/v0/${AIRTABLE_BASE}/${cacheId}/${CACHE_CAP_IMAGE_FIELD}/uploadAttachment`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` },
              body: JSON.stringify({
                contentType: 'image/jpeg',
                file: capUpBuf.toString('base64'),
                filename: `cap_${resolvedCapId || 'cap'}_${Date.now()}.jpg`,
              }),
            }
          );
          if (!capUploadRes.ok) log.push(`Cap-Upload fehlgeschlagen: ${(await capUploadRes.text()).slice(0, 500)}`);
        } catch (e) {
          log.push(`Cap-Upload fehlgeschlagen: ${String(e).slice(0, 500)}`);
        }
      }
      await cachePatch(cacheId, {
        Status: 'Done',
        ...(capScale != null ? { Cap_Scale: capScale } : {}), // v56
        ...(log.length ? { Render_Log: log.join('\n') } : {}),
      }).catch(() => null);
    } catch (cacheErr) {
      console.error('Bild-Persist fehlgeschlagen (Antwort war bereits raus):', cacheErr);
      await cachePatch(cacheId, { Status: 'Error', Render_Log: `Persist: ${String(cacheErr).slice(0, 1500)}` }).catch(() => null);
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
