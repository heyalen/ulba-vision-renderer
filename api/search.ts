import { VercelRequest, VercelResponse } from '@vercel/node';
// fal nimmt image_url auch als data-URI entgegen — das Referenzbild reist
// ohnehin als data-URL vom Frontend an, kein Zwischenspeichern noetig.
import { Profil, falFreistellen, profilVonPng, aehnlichkeit, letzterFalFehler, FORM_VERSION } from './_form';

// ── Config ──────────────────────────────────────────────────────────
const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const SYSTEM_TABLE = 'tblB1kWay9TvX3rGv';
const PRODUKT_REGELN_TABLE = 'tblrL5tEpvvUh6OEj';
const CAP_TABLE = 'tblQvnXPhiKGMoqDp'; // Cap-Tabelle — 1 Record = 1 Verschluss

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

// v57 — Silhouetten heilen sich selbst. Systeme ohne Profil oder mit einer
// aelteren Profilversion werden beim Bildsuchlauf parallel neu gerechnet und
// nach Airtable zurueckgeschrieben. Kein manueller Batch-Aufruf mehr — weder
// nach einer Aenderung der Profilrechnung noch fuer neu angelegte Systeme.
// Non-fatal: was scheitert, behaelt sein altes Profil.
async function silhouettenAuffrischen(records: any[]): Promise<number> {
  const alt = records.filter(r => {
    let v = 0;
    try { v = JSON.parse(r.fields?.['Silhouette'] || '{}')?.v || 0; } catch { v = 0; }
    return v < FORM_VERSION && !!imgUrl(r.fields?.['Bild_Harmonisiert']);
  }).slice(0, 30);
  if (alt.length === 0) return 0;
  // fal erlaubt 10 gleichzeitige Anfragen — und die Freistellung des
  // REFERENZBILDS laeuft parallel zu dieser Funktion. Deshalb: kurz warten,
  // damit die Referenz zuerst durch ist, dann in Dreiergruppen.
  await new Promise(r => setTimeout(r, 1500));
  const updates: Array<{ id: string; fields: any }> = [];
  for (let i = 0; i < alt.length; i += 3) {
    const neu = await Promise.all(alt.slice(i, i + 3).map(async r => {
      try {
        const frei = await falFreistellen(imgUrl(r.fields['Bild_Harmonisiert'])!);
        if (!frei) return null;
        const p = await profilVonPng(frei);
        if (!p) return null;
        const json = JSON.stringify(p);
        r.fields['Silhouette'] = json; // gilt schon fuer diese Suche
        return { id: r.id, fields: { Silhouette: json } };
      } catch { return null; }
    }));
    updates.push(...(neu.filter(Boolean) as Array<{ id: string; fields: any }>));
  }
  for (let i = 0; i < updates.length; i += 10) {
    await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${SYSTEM_TABLE}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` },
      body: JSON.stringify({ records: updates.slice(i, i + 10) }),
    }).catch(() => null);
  }
  return updates.length;
}

// ── v59: Lieferanten ─────────────────────────────────────────────────
// System.Lieferant ist ein VERKNUEPFTES Feld auf die Tabelle "Lieferant"
// (tblsy3CHZbAo6GraB) — die API liefert Record-IDs, keine Namen. Darum:
// Tabelle einmal laden (5-Min-Cache), IDs → Namen aufloesen. Dieselbe
// Tabelle traegt das Profil (Logo, Titelbild, Beschreibung, Standort, Land,
// Website, MOQ, Lieferzeit, Zertifikat, Status). Keine Zweittabelle mehr.
const LIEFERANT_TABLE = 'tblsy3CHZbAo6GraB';
let LIEF: Map<string, any> = new Map();
let liefStand = 0;
async function lieferantenLaden(): Promise<void> {
  if (Date.now() - liefStand < 300000 && LIEF.size) return;
  try {
    const recs = await airtableListAll(LIEFERANT_TABLE);
    LIEF = new Map(recs.map((r: any) => [r.id, r.fields || {}]));
    liefStand = Date.now();
  } catch { /* ohne Map: Namen bleiben leer statt Record-ID */ }
}
function lieferantName(feld: any): string {
  const id = Array.isArray(feld) ? feld[0] : feld;
  if (typeof id !== 'string' || !id) return '';
  if (!id.startsWith('rec')) return id; // falls Feld je wieder Text wird
  return String(LIEF.get(id)?.['Name'] || '');
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
  // v59 — paginiert. Vorher kam nur die erste Seite (100 Records) zurueck:
  // ab Teil 101 waere der Katalog fuer die Suche unsichtbar geworden.
  const alle: any[] = [];
  let offset = '';
  for (let seite = 0; seite < 50; seite++) {
    if (offset) params.set('offset', offset);
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}?${params}`,
      { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } }
    );
    if (!res.ok) throw new Error(`Airtable list ${table}: ${res.status}`);
    const data = await res.json();
    alle.push(...(data.records || []));
    if (!data.offset) break;
    offset = data.offset;
  }
  return alle;
}

// ════════════════════════════════════════════════════════════════════
//  SPUR B — explizite Physik-Specs aus dem Freitext ("1000ml, Glas,
//  rund, Pipette"). Deklaration, keine Ableitung. Werte gegen die REALEN
//  Airtable-Options (deutsch!) gemappt — vorher liefen Bottle/Jar/Dropper
//  ins Leere.
// ════════════════════════════════════════════════════════════════════
interface ParsedQuery {
  raw: string;
  sizeMentions: string[];     // ["50ml"]
  materialMentions: string[]; // ["Glas"]  (real options)
  typeMentions: string[];     // ["Flasche"]
  closureMentions: string[];  // ["Pipette"]
  formMentions: string[];     // ["rund"]  — Geometrie ist hart (Produkt-Eigenschaft)
}

// §8.2-Freiheitsgrade: getippt = Nutzer hat eine Pill VORAB gesetzt.
// KEIN Hard Filter — ein Produkt kann in jedem Finish gerendert werden.
// Diese Hints pre-seeden nur den Pill-State vor dem ersten Render.
interface FreeHints {
  finish: string | null;      // matt|glossy|frosted|soft_touch|metallic
  baseWeight: string | null;  // heavy_base
}

// Kunststoff-Familie (kein generisches "Kunststoff"-Option vorhanden)
const PLASTICS = ['PET', 'R-PET', 'HDPE', 'PP', 'PETG', 'HDPE/LDPE'];

function parseQuery(query: string): ParsedQuery & { freeHints: FreeHints } {
  const q = query.toLowerCase();

  // Größe: "50ml", "100 ml", "1000ML"
  const sizeMatches = query.match(/\d+\s*ml/gi) || [];
  const sizeMentions = sizeMatches.map(s => s.replace(/\s/g, '').toLowerCase());

  // Material → REALE Options
  const materialMentions: string[] = [];
  const addMat = (v: string) => { if (!materialMentions.includes(v)) materialMentions.push(v); };
  if (/\bglas\b|glass|gläser|glaeser/.test(q)) addMat('Glas');
  if (/\bpcr\b|recycl|rezyklat|r-pet|rpet/.test(q)) { addMat('Glas PCR 100 %'); addMat('R-PET'); }
  if (/\bpet\b/.test(q)) addMat('PET');
  if (/petg/.test(q)) addMat('PETG');
  if (/hdpe/.test(q)) addMat('HDPE');
  if (/\bpp\b|polypropylen/.test(q)) addMat('PP');
  if (/alumini|\balu\b/.test(q)) addMat('Aluminium');
  if (/keramik|ceramic/.test(q)) addMat('Keramik');
  if (/plastik|plastic|kunststoff/.test(q)) PLASTICS.forEach(addMat);

  // Type → REALE Options (deutsch)
  const typeMap: Array<[RegExp, string]> = [
    [/flasche|flaschen|bottle/, 'Flasche'],
    [/tiegel|jar/, 'Tiegel'],
    [/\bdose\b/, 'Dose'],
    [/tube|tuben/, 'Tube'],
    [/\bstick\b/, 'Stick'],
    // v68 — Airless/Pumpe/Spray sind MECHANIK, kein Behaelter: sie stehen nur
    // als Verschluss-Filter. Sonst fiel jede Airless-Flasche bei "flasche"
    // raus und "pumpe" fand 0 Systeme (kein System hat Typ "Pump").
  ];
  const typeMentions = typeMap.filter(([re]) => re.test(q)).map(([, v]) => v)
    .filter((v, i, a) => a.indexOf(v) === i);

  // Closure → REALE Options
  const closureMap: Array<[RegExp, string]> = [
    [/pipette|dropper|tropfer/, 'Pipette'],
    [/schraub|screw/, 'Schraubverschluss'],
    [/flip[-\s]?top|flip[-\s]?cap/, 'Flip-top'],
    [/pump/, 'Pump'],   // auch "Dosierpumpe", "Pumpspender
    [/spray|sprüh|spruh/, 'Spray'],
    [/airless/, 'Airless'],
    [/stopfen|stopper/, 'Stopfen'],
    [/snap[-\s]?on/, 'Snap-On'],
  ];
  const closureMentions = closureMap.filter(([re]) => re.test(q)).map(([, v]) => v)
    .filter((v, i, a) => a.indexOf(v) === i);

  // Form/Geometrie → REALE Options (hart: reale Produkt-Eigenschaft)
  const formMap: Array<[RegExp, string]> = [
    [/\brund\b|round/, 'rund'],
    [/\boval\b/, 'oval'],
    [/eckig|square|kantig/, 'eckig'],
    [/quadrat/, 'quadratisch'],
    [/schlank|slim|schmal|tall|hoch/, 'schlank'],
    [/\bbreit\b|wide/, 'breit'],
    [/freeform|organisch/, 'freeform'],
  ];
  const formMentions = formMap.filter(([re]) => re.test(q)).map(([, v]) => v)
    .filter((v, i, a) => a.indexOf(v) === i);

  // Freiheitsgrade (§8.2) → pre-seed Pills, KEIN Filter
  let finish: string | null = null;
  if (/soft[-\s]?touch/.test(q)) finish = 'soft_touch';
  else if (/frosted|gefrostet|satiniert|frost/.test(q)) finish = 'frosted';
  else if (/matt/.test(q)) finish = 'matt';
  else if (/glossy|glänzend|glaenzend|glanz|hochglanz/.test(q)) finish = 'glossy';
  else if (/metallic|metallisch/.test(q)) finish = 'metallic';
  const baseWeight = /schwerer boden|dickboden|heavy base|schwerem boden|dicker boden/.test(q) ? 'heavy_base' : null;

  return {
    raw: query, sizeMentions, materialMentions, typeMentions, closureMentions, formMentions,
    freeHints: { finish, baseWeight },
  };
}

// ── Verschluss-Normalisierung ────────────────────────────────────────
// Ein Term (getippt "dropper", Client-Pill "ScrewCap", parseQuery "Flip-top",
// deutscher Choice "Schraubverschluss") → ein kanonischer SUBSTRING, der in
// den realen Airtable-Choices matcht (Base-Closure UND Cap-Verschlussart,
// beide deutsch: Schraubverschluss/Pump/Airless/Pipette/Flip-Top/Disc-Top/
// Snap-On/Spray/Dosierpumpe). Ohne das matchte "ScrewCap"≠"Schraubverschluss",
// "Dropper"≠"Pipette", "FlipTop"≠"Flip-Top".
const CLOSURE_ALIAS: Array<[RegExp, string]> = [
  [/pump|pumpe|dosierpump/i, 'Pump'],   // Substring von "Pump" UND "Dosierpumpe"
  [/pipette|dropper|tropf/i, 'Pipette'],
  [/schraub|screw/i, 'Schraub'],        // Substring von "Schraubverschluss"
  [/flip/i, 'Flip'],                    // Substring von "Flip-Top"
  [/spray|sprüh|spruh/i, 'Spray'],
  [/airless/i, 'Airless'],
  [/snap/i, 'Snap'],                    // Substring von "Snap-On"
  [/disc/i, 'Disc'],                    // Substring von "Disc-Top"
];
// v60 — Material-Chips kamen englisch ('Glass', 'Acrylic') und trafen die
// deutschen Optionen (Glas, Acryl) nie → 0 Treffer trotz Glas im Grid.
const MATERIAL_ALIAS: Array<[RegExp, string]> = [
  [/^glass$|^glas$/i, 'Glas'], [/^acryl(ic)?$/i, 'Acryl'], [/^alu(minum|minium)?$/i, 'Aluminium'],
  [/^ceramic$|^keramik$/i, 'Keramik'], [/^bamboo$|^bambus$/i, 'Bambus'], [/^wood$|^holz$/i, 'Holz'],
];
function normalizeMaterial(term: string): string {
  const t = term.trim();
  for (const [re, v] of MATERIAL_ALIAS) if (re.test(t)) return v;
  return t;
}
function normalizeClosure(term: string): string {
  for (const [re, v] of CLOSURE_ALIAS) if (re.test(term)) return v;
  return term;
}

// active_filters vom Client: erlaubt gezieltes Entfernen einzelner Filter
// (X-Klick auf Chip). Nur bekannte Keys — kein Injizieren neuer Constraints.
// FIX (Chat-Verfeinerung): Override ist jetzt UNION mit den frisch aus der
// Query geparsten Mentions statt Replace. Vorher hat der mitgeschickte alte
// Chip-State ('sizes' in override → []) ein frisch getipptes "200ml" GELÖSCHT
// → Volumen-Verfeinerung im Chat wirkte nie. Entfernen läuft jetzt über die
// explizite removed-Liste (Client schickt sie beim Chip-X mit), damit ein X
// nicht durch Re-Parsen der rootQuery sofort wieder rückgängig gemacht wird.
function applyActiveFilters<T extends ParsedQuery>(parsed: T, override: any, removed?: any): T {
  const arr = (v: any): string[] => Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  const uniq = (a: string[]) => [...new Set(a)];
  const rm = (a: string[], r: string[]) =>
    a.filter(x => !r.some(y => y.toLowerCase() === x.toLowerCase()));
  const o = (override && typeof override === 'object') ? override : {};
  const r = (removed && typeof removed === 'object') ? removed : {};
  const merge = (fromQuery: string[], key: string) =>
    rm(uniq([...fromQuery, ...(key in o ? arr(o[key]) : [])]), arr(r[key]));
  return {
    ...parsed,
    sizeMentions: merge(parsed.sizeMentions, 'sizes'),
    materialMentions: uniq(merge(parsed.materialMentions, 'materials').map(normalizeMaterial)),
    typeMentions: merge(parsed.typeMentions, 'types'),
    closureMentions: merge(parsed.closureMentions, 'closures').map(normalizeClosure),
    formMentions: merge(parsed.formMentions, 'forms'),
  };
}

// ════════════════════════════════════════════════════════════════════
//  SPUR A — Ableitung. EBENE 1 Formel-Wand (Spec §5.1).
//  DETERMINISTISCH: Wirkstoff/Produkt → Physik → gesperrte Formate.
//  Nie Haiku-geraten. Die Wand gibt eine ERLAUBTE MENGE aus, kein Format:
//  sie sperrt Unmögliches (Klar-Pipette, Tiegel für Serum, PET für Öl)
//  und flaggt, was nur der Render-Gate lösen kann (Klarglas → tönen).
// ════════════════════════════════════════════════════════════════════
type Formel =
  | 'oxidationsempfindlich' | 'niedrigviskos' | 'hochviskos'
  | 'schaeumend' | 'oelhaltig' | 'lichtstabil';

interface FormulaSignal { re: RegExp; formel: Formel; }
const FORMULA_SIGNALS: FormulaSignal[] = [
  { re: /vitamin\s?c|vit[-\s]?c|\bvitc\b|ascorb|retinol|retinal|retinald|peptid|bakuchiol|ferulic/, formel: 'oxidationsempfindlich' },
  { re: /\böl\b|\boel\b|facial oil|gesichtsöl|gesichtsoel|\boil\b|squalan/, formel: 'oelhaltig' },
  { re: /serum|toner|essence|essenz|ampoule|ampulle|\bmist\b|drops|tropfen|lotion|fluid/, formel: 'niedrigviskos' },
  { re: /creme|crème|cream|\bbalm\b|balsam|butter|salbe|paste/, formel: 'hochviskos' },
  { re: /cleanser|reinig|foam|schaum|shampoo|duschgel|body wash|gel wash/, formel: 'schaeumend' },
];

function parseFormula(query: string): Formel[] {
  const q = query.toLowerCase();
  const hits = new Set<Formel>();
  for (const s of FORMULA_SIGNALS) if (s.re.test(q)) hits.add(s.formel);
  if (hits.size === 0) hits.add('lichtstabil');
  return [...hits];
}

interface FormulaWall {
  forbidMaterial: string[];   // reale Material-Options (Base-Ebene)
  forbidType: string[];       // reale Type-Options (Base-Ebene)
  forceTintIfGlass: boolean;  // Klarglas nicht erlaubt → Render muss tönen (SF-Gate)
  preferOpaque: boolean;      // Identität "laut" läuft über Opak/Vollfarbe (Typ-B)
  // CAP-EBENE (nicht Base!): Verschluss-Wahl. Pipette ist ein Cap, kein Base-
  // Attribut → offene Klar-Pipette wird im Cap-Panel DEPRIORISIERT, nicht das
  // Base gefiltert. produkt-truth: der Pipetten-Cap existiert real; bei
  // getöntem Glas ist er legitim (Skin1004/Dr.-Althea-Amber-Pipette).
  deprioritizeOpenDropper: boolean;
  notes: string[];            // Transparenz für UI/Log: WARUM etwas gesperrt ist
}

function buildFormulaWall(formeln: Formel[]): FormulaWall {
  const w: FormulaWall = {
    forbidMaterial: [], forbidType: [],
    forceTintIfGlass: false, preferOpaque: false, deprioritizeOpenDropper: false, notes: [],
  };
  const addMat = (v: string) => { if (!w.forbidMaterial.includes(v)) w.forbidMaterial.push(v); };
  const addType = (v: string) => { if (!w.forbidType.includes(v)) w.forbidType.push(v); };

  for (const f of formeln) {
    switch (f) {
      case 'oxidationsempfindlich':
        // Luft+Licht zersetzen. Base wird NICHT wegen Pipette gefiltert (Pipette
        // = Cap). Base-Wirkung: Klarglas → tönen. Cap-Wirkung: offene Pipette
        // depriorisieren. "laut" → opak/getönt tragen.
        w.forceTintIfGlass = true;
        w.preferOpaque = true;
        w.deprioritizeOpenDropper = true;
        w.notes.push('oxidationsempfindlich → Glas nur getönt/opak (kein Klarglas); offene Pipette im Cap-Panel depriorisiert');
        break;
      case 'niedrigviskos':
        // fließt frei → Tiegel unpraktisch (Base-Format, echte Wand).
        addType('Tiegel');
        w.notes.push('niedrigviskos (Serum/Toner) → Tiegel gesperrt');
        break;
      case 'hochviskos':
        // fließt nicht → Pipette-Cap unbrauchbar (Cap-Ebene, depriorisieren).
        w.deprioritizeOpenDropper = true;
        w.notes.push('hochviskos (Creme/Balm) → Pipetten-Cap depriorisiert');
        break;
      case 'oelhaltig':
        // greift PET-Familie chemisch an (Base-Material, echte Wand).
        addMat('PET'); addMat('R-PET'); addMat('PETG');
        w.notes.push('ölhaltig → PET/R-PET/PETG gesperrt');
        break;
      case 'schaeumend':
        // Menge + nasse Hände → Tiegel raus (Base), Pipette-Cap depriorisiert.
        addType('Tiegel'); w.deprioritizeOpenDropper = true;
        w.notes.push('schäumend/Volumen → Tiegel gesperrt; Pipetten-Cap depriorisiert');
        break;
      case 'lichtstabil':
        // keine Chemie-Wand → Ebene 2 übernimmt komplett.
        break;
    }
  }
  return w;
}

// Opak/einfärbbar = kann "laut/bunt" tragen (Typ-B-Träger). produkt-truth:
// belegte Einfärbbarkeit ODER von Natur opakes Material.
const OPAQUE_MATERIALS = ['PP', 'HDPE', 'HDPE/LDPE', 'Aluminium', 'Keramik'];
function canCarryLoudColor(p: ProductData): boolean {
  if (p.capabilities.includes('einfaerbbar') || p.capabilities.includes('lackierbar')) return true;
  return p.material.some(m => OPAQUE_MATERIALS.includes(m));
}

// ── Identität (Ebene 2) — weiche Schicht für Ranking + Segment-Hint.
//    Haiku, optional, non-fatal. Register/Temperatur haben KEINE Physik-
//    Wahrheit → hier darf ein Modell schätzen. Segment-Routing bleibt
//    vorbereitet (Hint), aktiviert erst mit Code-Profilen.
interface Identity {
  register: string | null;
  // Achsen als ZAHL 0-10 = Cursor-Startposition der Wolke. Die Labels
  // darunter sind abgeleitet (Prompt-Text + Frontend-Kontrakt), nie Quelle.
  temp_laut: number | null;
  temp_ton: number | null;
  hero_ingredient: string | null;
  temperatur_laut: string | null; // leise|laut  (abgeleitet)
  temperatur_ton: string | null;  // serioes|verspielt (abgeleitet)
}
async function parseIdentity(query: string): Promise<Identity | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const system = `Du liest einen Beauty-Marken-Brief und gibst NUR die weiche Identitäts-Ebene zurück. Keine Physik.
Antworte NUR mit JSON:
{"register":"pharma-klinisch|tech-premium|clean-minimal|natur-erdig|luxus-ritual|masse-funktional|null","temp_laut":<0-10 oder null>,"temp_ton":<0-10 oder null>,"hero_ingredient":"<zutat oder null>"}

temp_laut — visuelle Lautstärke, ORTHOGONAL zum Register (natur kann laut sein):
 0-1 fast unsichtbar, apothecary-still, ungefärbt
 2-3 leise clean, weiß/transparent, ein dezenter Ton
 4-5 selbstbewusst aber ruhig, ein klarer Farbton
 6-7 farbig präsent, kräftiger Ton, sichtbarer Akzent
 8-9 knallig, neon, hoher Kontrast, will auffallen
 10  schrill, maximal, mehrere laute Töne gleichzeitig

temp_ton — Haltung:
 0-1 streng klinisch   2-3 seriös/sachlich   4-6 neutral freundlich
 7-8 verspielt/lebendig   9-10 albern, cartoonhaft, ironisch

Setze NUR, was der Brief hergibt. Kein Signal → null (NICHT 5 raten).`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5', max_tokens: 200, temperature: 0, system,
        messages: [{ role: 'user', content: `Brief: "${query}"` }],
      }),
    });
    const data = await res.json() as { content: Array<{ text: string }> };
    const raw = (data.content?.[0]?.text || '').replace(/```json\s?|```/g, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    const nn = (v: any) => (v && v !== 'null') ? String(v) : null;
    const n10 = (v: any) => {
      const x = typeof v === 'number' ? v : parseFloat(v);
      return Number.isFinite(x) ? Math.max(0, Math.min(10, Math.round(x))) : null;
    };
    const laut = n10(p.temp_laut), ton = n10(p.temp_ton);
    // Label nur an den Polen — die Mitte bleibt bewusst unbeschriftet, damit
    // der Prompt-Text nicht mehr behauptet als die Zahl hergibt.
    const lbl = (n: number | null, lo: string, hi: string) =>
      n === null ? null : n <= 4 ? lo : n >= 6 ? hi : null;
    return {
      register: nn(p.register),
      temp_laut: laut, temp_ton: ton,
      hero_ingredient: nn(p.hero_ingredient),
      temperatur_laut: lbl(laut, 'leise', 'laut'),
      temperatur_ton: lbl(ton, 'serioes', 'verspielt'),
    };
  } catch { return null; }
}

// ── Produkt_Regeln Matching (Kategorie-Constraints, bestehend) ─────────
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
  formelFlags: string[];
}

/* Der erste Kompetenz-Beweis: ulba erklaert, WARUM diese Auswahl. Aus den
   Formel_Flags der Kategorie, aktiviert durch Query-Signale (Feld-Doku).
   Kommt VOR die Kacheln — Ebene 1 (Suche), nicht Ebene 2 (Brief). */
function formelHinweis(cat: CategoryConstraints | null, query: string): string | null {
  if (!cat) return null;
  const q = query.toLowerCase();
  const flags = new Set(cat.formelFlags.map(f => f.toLowerCase()));
  const g: string[] = [];
  const oxidAktiv = /vitamin\s*c|ascorb|retinol|retinal|niacin/.test(q);
  if (flags.has('oxidationsempfindlich_moeglich')) {
    g.push(oxidAktiv
      ? 'die Formel ist licht- und oxidationsempfindlich — darum zeige ich dir keine offenen Pipetten in Klarglas'
      : 'solche Formeln sind oft lichtempfindlich — offene Pipetten in Klarglas lasse ich weg');
  }
  if (flags.has('hochviskos')) g.push('sie ist dickflüssig — Pipette und Spray fallen weg, Tiegel, Tube und Pumpe passen');
  if (flags.has('niedrigviskos')) g.push('sie ist dünnflüssig — Tropfer, Pipette und Spray sind hier stark');
  if (flags.has('schaeumend_volumen')) g.push('sie schäumt — darum grössere Formate mit Pumpe oder Flip-Top');
  if (flags.has('oelhaltig_moeglich')) g.push('ölhaltige Formeln vertragen kein PET — Glas und PP bevorzugt');
  if (g.length === 0 && cat.nichtClosure.length > 0) g.push(`${cat.nichtClosure.join(' und ')} lasse ich hier weg`);
  if (g.length === 0) return null;
  const kern = g.slice(0, 2).join('; ');
  return `Ich lese dich als ${cat.category}: ${kern.charAt(0).toUpperCase()}${kern.slice(1)}.`;
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
        formelFlags: Array.isArray(f['Formel_Flags']) ? f['Formel_Flags'].map((x: any) => String(x)) : [],
      };
    }
  }
  return null;
}

// ── Produkt-Extraktion ──────────────────────────────────────────────
interface CapRef { id: string; name: string; imageUrl: string }

interface ProductData {
  id: string;
  name: string;
  type: string;
  material: string[];
  form: string[];
  closure: string;
  description: string;
  imageUrl: string | null;
  capabilities: string[];   // SF_Bestätigt (Tristate — nur BELEGTE Fähigkeiten)
  excluded: string[];       // SF_Ausgeschlossen (intern für Ranking-Hinweis)
  availableSizes: string[];
  availableMaterials: string[];
  capCount: number;
  capIds: string[];
  caps: CapRef[];
  capImages: string[];
  supplier: string;
  // v55 — gespeichertes Silhouettenprofil (Feld "Silhouette", JSON),
  // gerechnet von api/silhouette.ts mit derselben Regel wie das Referenzbild.
  silhouette: Profil | null;
  querschnitt: Querschnitt | null; // v56 — aus Lieferantendaten
  komplettsystem: boolean;         // v56 — Bauweise "system": Verschluss nicht austauschbar
  verschluesse?: string[];         // v56 — Basis + alle verknuepften Caps
}

function extractProduct(rec: any): ProductData {
  const f = rec.fields;

  // NEU: SF-Tristate statt alter Booleans. Nur BELEGTE Fähigkeiten.
  const capabilities = multiSelectNames(f['SF_Bestätigt']);
  const excluded = multiSelectNames(f['SF_Ausgeschlossen']);

  const capIds = (f['Caps'] as string[] | undefined || []).filter(Boolean);

  return {
    id: rec.id,
    name: f['Page Titel'] || f['System ID'] || rec.id,
    type: selectName(f['Type']),
    material: multiSelectNames(f['Material']),
    form: multiSelectNames(f['Form']),
    closure: selectName(f['Closure']),
    description: f['Kurzbeschreibung'] || '',
    imageUrl: imgUrl(f['Bild_Harmonisiert']),
    capabilities,
    excluded,
    availableSizes: multiSelectNames(f['Available_Sizes']),
    availableMaterials: multiSelectNames(f['Available_Materials']),
    capCount: capIds.length,
    capIds,
    caps: [],
    capImages: [],
    supplier: lieferantName(f['Lieferant']),
    querschnitt: querschnittVonSystem({ form: multiSelectNames(f['Form']) } as any, f),
    // Feld "Bauweise" (base+cap_separat | system) — ueber den Wert erkannt,
    // damit eine Umbenennung des Feldes nichts bricht.
    komplettsystem: Object.values(f).some(v => v === 'system' || (v as any)?.name === 'system'),
    silhouette: (() => {
      const roh = f['Silhouette'];
      if (typeof roh !== 'string' || !roh) return null;
      try {
        const p = JSON.parse(roh);
        return Array.isArray(p?.breiten) ? (p as Profil) : null;
      } catch { return null; }
    })(),
  };
}

async function resolveCaps(capIds: string[]): Promise<Map<string, { url: string; name: string }>> {
  const map = new Map<string, { url: string; name: string }>();
  if (capIds.length === 0) return map;
  const capRecords = await airtableListAll(CAP_TABLE);
  for (const rec of capRecords) {
    const url = imgUrl(rec.fields['Cap_Bild_Harmonisiert']) || imgUrl(rec.fields['Cap_Bild']);
    // v64: Anzeigename = Verschlussart ("Pump", "Pipette"), nicht "XY — Cap 1".
    const name = selectName(rec.fields['Closure_Type']) || rec.fields['Cap_Name'] || '';
    if (url) map.set(rec.id, { url, name });
  }
  return map;
}

// Cap-Verschlussart je Cap-Record → Map capId → "Pump"|"Pipette"|… .
// Nötig, weil der Verschluss am CAP hängt, nicht am Base (UNIQUE-Base =
// "Schraubverschluss", trägt aber Pump-Caps). Zugriff per Feld-ID
// (fldVxgwWH9Bi0OWzn = Cap-Verschlussart) → stabil gegen Umbenennung.
// Paginiert (airtableListAll zieht nur 1 Seite): bei >100 Caps würde sonst
// ein Teil des Inventars durch den Verschluss-Filter fallen.
const CAP_CLOSURE_FIELD = 'fldVxgwWH9Bi0OWzn';
async function loadCapClosureMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let offset: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' });
    params.set('fields[]', CAP_CLOSURE_FIELD);
    if (offset) params.set('offset', offset);
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${CAP_TABLE}?${params}`,
      { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } }
    );
    if (!res.ok) return map; // non-fatal: Filter fällt auf Base-Closure zurück
    const data = await res.json();
    for (const rec of (data.records || [])) {
      const c = rec.fields?.[CAP_CLOSURE_FIELD];
      const name = c && typeof c === 'object' ? c.name : (typeof c === 'string' ? c : '');
      if (name) map.set(rec.id, name);
    }
    offset = data.offset;
  } while (offset);
  return map;
}

// ── Hard Filter — Merge beider Spuren. Reihenfolge = производ-truth:
//    1) Nutzer-Spec (Spur B, positiv)  2) Produkt_Regeln  3) FORMEL-WAND.
//    Die Formel-Wand subtrahiert IMMER zuletzt → Wand gewinnt gegen
//    Nutzerwunsch (getippte Pipette für Vit-C wird entfernt).
// ─────────────────────────────────────────────────────────────────────
function hardFilter(
  products: ProductData[],
  parsed: ParsedQuery,
  category: CategoryConstraints | null,
  wall: FormulaWall,
  capClosures: Map<string, string>
): ProductData[] {
  const inc = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
  // FIX (PETG≠PET): Material braucht Token-Grenzen statt Substring.
  // "PETG".includes("PET") war true → Glas-Tiegel mit Available_Materials
  // [PETG] rutschte durch den PET-Filter. Jetzt: Treffer nur, wenn vor/nach
  // dem Begriff kein Buchstabe/keine Ziffer steht. "Glas PCR 100 %" matcht
  // weiter "Glas" (Grenze = Space), "R-PET" matcht "PET" (Grenze = "-",
  // gewollt: rezykliertes PET IST PET), "PETG" matcht "PET" NICHT mehr.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchMat = (hay: string, needle: string) =>
    new RegExp(`(^|[^a-z0-9])${esc(needle)}($|[^a-z0-9])`, 'i').test(hay);
  // FIX (200ml≠1200ml + Kartenwahrheit): ml-Vergleich numerisch statt
  // Substring — "1200ml".includes("200ml") war true.
  const mlOf = (s: string) => { const m = s.match(/(\d+)\s*ml/i); return m ? parseInt(m[1], 10) : NaN; };
  const sizeEq = (a: string, b: string) => { const x = mlOf(a), y = mlOf(b); return !isNaN(x) && x === y; };

  return products.filter(p => {
    // ── Spur B: Nutzer-explizite Filter (positiv) ──────────────────
    if (parsed.materialMentions.length > 0) {
      const hit = parsed.materialMentions.some(m =>
        p.material.some(pm => matchMat(pm, m)) || p.availableMaterials.some(am => matchMat(am, m)));
      if (!hit) return false;
    }
    if (parsed.typeMentions.length > 0) {
      // Alte Projekte schicken noch "Typ: Airless/Pump/Spray" als Pill —
      // Mechanik sitzt am Verschluss (Base oder Cap), nicht am Typ.
      const mechanik = (t: string) => /^(airless|pump|spray)$/i.test(t);
      if (!parsed.typeMentions.some(t => inc(p.type, t) || (mechanik(t) && (inc(p.closure, t) ||
        p.capIds.some(cid => { const cc = capClosures.get(cid); return cc ? inc(cc, t) : false; }))))) return false;
    }
    if (parsed.closureMentions.length > 0) {
      // Verschluss sitzt am Base ODER an einem Cap. UNIQUE-Base ist
      // "Schraubverschluss", trägt aber Pump-Caps → früher fälschlich
      // rausgefiltert. Jetzt: Treffer, wenn Base-Closure ODER irgendeine
      // Cap-Verschlussart matcht (c ist bereits normalisiert, s. normalizeClosure).
      const hit = parsed.closureMentions.some(c =>
        inc(p.closure, c) ||
        p.capIds.some(cid => { const cc = capClosures.get(cid); return cc ? inc(cc, c) : false; }));
      if (!hit) return false;
    }
    if (parsed.formMentions.length > 0) {
      if (p.form.length > 0 && !parsed.formMentions.some(fm => p.form.some(pf => inc(pf, fm)))) return false;
      // Kein Form-Datum am Produkt → nicht ausschließen (Data Gap).
    }
    if (parsed.sizeMentions.length > 0 && p.availableSizes.length > 0) {
      const hasSize = parsed.sizeMentions.some(s => p.availableSizes.some(as => sizeEq(as, s)));
      if (!hasSize) return false;
    }

    // ── Produkt_Regeln (Kategorie-Constraints) ─────────────────────
    if (category) {
      if (category.nichtMaterial.some(nm => p.material.some(pm => matchMat(pm, nm)))) return false;
      if (category.nichtClosure.some(nc => inc(p.closure, nc))) return false;
      // Mechanik-Woerter in Nicht_Typen ("Airless") gelten fuer den Verschluss.
      if (category.nichtType.some(nt => inc(p.type, nt) || (/^(airless|pump|pumpe|spray)$/i.test(nt.trim()) && inc(p.closure, nt.trim().replace(/e$/i, ''))))) return false;
      if ((category.volumeMin !== null || category.volumeMax !== null) && p.availableSizes.length > 0) {
        const mls = p.availableSizes.map(s => parseInt(s.replace(/[^0-9]/g, ''), 10)).filter(n => !isNaN(n));
        if (mls.length > 0) {
          const ok = mls.some(ml =>
            !(category.volumeMin !== null && ml < category.volumeMin) &&
            !(category.volumeMax !== null && ml > category.volumeMax));
          if (!ok) return false;
        }
      }
    }

    // ── FORMEL-WAND (Ebene 1, Base) — gewinnt immer, subtrahiert zuletzt ──
    // Nur Base-Attribute (Material/Type). Verschluss NICHT hier — Pipette ist
    // ein Cap und wird im Cap-Panel depriorisiert, nicht das Base gefiltert.
    if (wall.forbidMaterial.some(fm => p.material.some(pm => matchMat(pm, fm)))) return false;
    if (wall.forbidType.some(ft => inc(p.type, ft))) return false;

    return true;
  });
}

// ── Claude Ranking (Ebene 2 — wählt innerhalb der erlaubten Menge) ────
interface RankedProduct extends ProductData {
  score: number;
  wand?: boolean; // v56 — an einer harten Identitaetsgrenze abgeprallt
  formNaehe?: number | null; // v55 — Silhouetten-Naehe 0..100, null = nicht gemessen
  reasoning: string;
  // v47 — Bildpfad: wo dieses Teil vom Referenzbild abweicht. Jeder Treffer
  // sagt selbst, was nicht stimmt, statt es zu verschweigen.
  abweichung?: string[];
}

async function claudeRank(
  query: string,
  products: ProductData[],
  category: CategoryConstraints | null,
  identity: Identity | null,
  wall: FormulaWall,
  merkmale: (p: ProductData) => string = () => '',
): Promise<RankedProduct[]> {
  if (products.length === 0) return [];

  const productList = products.map((p, i) => {
    const mk = merkmale(p);
    return `[${i}] ${p.name} | Type: ${p.type} | Material: ${p.material.join(',')} | Form: ${p.form.join(',')} | Closure: ${p.closure} | Fähigkeiten: ${p.capabilities.join(',') || '—'} | Sizes: ${p.availableSizes.join(',')}${mk ? ` | Merkmale: ${mk}` : ''} | ${p.description}`;
  }).join('\n');

  let categoryContext = '';
  if (category) {
    categoryContext = `\nKategorie "${category.category}". Bevorzugt: Material ${category.bevorzugtMaterial.join(', ')}; Closure ${category.bevorzugtClosure.join(', ')}; Type ${category.bevorzugtType.join(', ')}.`;
  }
  let identityContext = '';
  if (identity) {
    const fmtAxis = (n: number | null, lbl: string | null) =>
      n === null ? '?' : `${n}/10${lbl ? ` (${lbl})` : ''}`;
    identityContext = `\nAbgeleitete Identität — Register: ${identity.register || '?'}; Lautstärke: ${fmtAxis(identity.temp_laut, identity.temperatur_laut)}; Ton: ${fmtAxis(identity.temp_ton, identity.temperatur_ton)}; Hero: ${identity.hero_ingredient || '?'}. Lautstärke ist orthogonal zum Register (0 = still, 10 = schrill).`;
  }
  let wallContext = '';
  if (wall.notes.length > 0) {
    wallContext = `\nFormel-Wand aktiv (bereits gefiltert): ${wall.notes.join(' | ')}.${wall.preferOpaque ? ' "Laut" muss über gesättigte Vollfarbe auf opaker/getönter Hülle laufen (kein Klarglas).' : ''}`;
  }

  const systemPrompt = `Du bist Sourcing-Experte für Beauty-Packaging.
Ranke, wie gut jedes Produkt zum Brief passt — emotional UND funktional.
Die harten physikalischen Wände sind bereits angewandt; ranke innerhalb der erlaubten Menge.
Berücksichtige: Register, Lautstärke/Ton (Q6, orthogonal), Zielgruppe, Material-Sprache, Formsprache.
"Merkmale" sind am Foto belegte Eigenschaften (Geometrie, Wandstärke, Oberfläche, Farbe, Kappe) — nimm sie wörtlich: wer "eckig" oder "matt" sucht, bekommt Teile mit genau diesem Merkmal zuerst.${categoryContext}${identityContext}${wallContext}
Antworte NUR mit JSON-Array, kein anderer Text:
[{"index":0,"score":85,"reasoning":"kurz"}]
Score 0-100. Sei entschieden — spreize die Scores. Bester Fit 90+, schlechter <30.
reasoning: MAXIMAL 6 Wörter. Laenger sprengt das Antwortlimit und das Ranking faellt komplett aus.`;

  // prefer_opaque-Boost (Typ-B als Score-Regel, nicht nur als Prompt-Text):
  // bei "laut" steigen opak/einfärbbare Bases, klares Glas fällt. Deterministisch
  // NACH dem Ranking angewandt — verlässt sich nicht darauf, dass Haiku es tut.
  const applyOpaqueBoost = (ranked: RankedProduct[]): RankedProduct[] => {
    if (!wall.preferOpaque) return ranked;
    return ranked.map(r => {
      let s = r.score;
      let why = '';
      if (canCarryLoudColor(r)) { s = Math.min(100, s + 20); why = ' [+opak/einfärbbar: kann laut/bunt tragen]'; }
      else if (r.material.includes('Glas')) { s = Math.max(0, s - 15); why = ' [-Klarglas: trägt "laut" nur begrenzt]'; }
      return { ...r, score: s, reasoning: r.reasoning + why };
    }).sort((a, b) => b.score - a.score);
  };

  let rawText = '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        // 1500 reichten bei ~40 Produkten nicht: das JSON-Array brach mitten
        // im letzten Objekt ab, JSON.parse warf, und der Fallback setzte ALLE
        // Treffer auf flat 50 (Symptom: jede Karte zeigt "50 MATCH").
        max_tokens: 4000,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Brief: "${query}"\n\nProdukte:\n${productList}` }],
      }),
    });

    const data = await res.json() as any;
    // Shape-sicher: den Text-Block finden statt [0] anzunehmen.
    if (data?.error) throw new Error(`Anthropic API: ${data.error?.message || JSON.stringify(data.error)}`);
    const textBlock = Array.isArray(data?.content)
      ? data.content.find((b: any) => b?.type === 'text' || typeof b?.text === 'string')
      : null;
    rawText = (textBlock?.text || '').trim();
    if (!rawText) throw new Error(`kein Text-Block (stop_reason=${data?.stop_reason || '?'})`);

    // JSON-Array aus evtl. Fließtext extrahieren ("hier ist dein Ranking: [...]").
    const cleaned = rawText.replace(/```json\s?|```/g, '').trim();
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (!m) throw new Error(`kein JSON-Array in Antwort`);
    // Tolerantes Parsing: bricht das Array ab (Token-Limit), waren bisher ALLE
    // Scores verloren. Jetzt werden die vollstaendig uebertragenen Objekte
    // einzeln gerettet — ein abgeschnittener Schwanz kostet nur den Schwanz.
    type Ranking = { index: number; score: number; reasoning: string };
    let rankings: Ranking[];
    try {
      rankings = JSON.parse(m[0]) as Ranking[];
    } catch {
      rankings = (m[0].match(/\{[^{}]*\}/g) || [])
        .map(o => { try { return JSON.parse(o) as Ranking; } catch { return null; } })
        .filter((o): o is Ranking => !!o && typeof o.index === 'number' && typeof o.score === 'number');
      if (rankings.length === 0) throw new Error('JSON-Array unlesbar (auch teilweise nicht)');
    }

    const ranked = rankings
      .filter(r => products[r.index])
      .map(r => ({ ...products[r.index], score: r.score, reasoning: r.reasoning }))
      .filter(r => r.id)
      .sort((a, b) => b.score - a.score);

    return applyOpaqueBoost(ranked);
  } catch (e) {
    // Fehler SICHTBAR machen (im UI statt in Logs): Grund + Rohtext-Anfang.
    const grund = e instanceof Error ? e.message : String(e);
    const snippet = rawText ? ` | raw: ${rawText.slice(0, 80)}` : '';
    // Fallback: NICHT flat 50. Ein identischer Score auf jeder Karte sieht aus
    // wie ein kaputtes Produkt und verschweigt, dass gar nicht gerankt wurde.
    // Stattdessen gestaffelt nach Eingangsreihenfolge (= Hardfilter-Ordnung),
    // damit die Liste lesbar bleibt und der Ausfall am Score sichtbar ist.
    return products.map((p, i) => ({
      ...p,
      score: Math.max(35, 72 - i * 2),
      reasoning: `Ranking-Fehler (ungerankt): ${grund}${snippet}`,
    }));
  }
}

// ── Main Handler ────────────────────────────────────────────────────
// ══ Bildpfad (v47) ═══════════════════════════════════════════════════
// Foto rein -> bestellbare Teile raus. Drei Ebenen, nach Verlaesslichkeit
// getrennt: Form (Geometrie, sicher) > Anmutung (Material/Finish, mittel)
// > Masse (Volumen, geraten). Regel: die unsicheren Ebenen SCOREN, sie
// FILTERN nie. Ein Teil mit perfekter Schulter und falschem Volumen landet
// auf Platz 4 — nicht im Nichts.

interface Bildlesart {
  typ: string | null;            // Flasche | Tiegel | Tube | Spender | Airless | Dose
  form: string[];                // rund | eckig | oval | konisch | zylindrisch
  schulter: string | null;       // weich | eckig | abfallend | keine
  proportion: string | null;     // gedrungen | ausgewogen | schlank
  verschluss: string | null;     // Pipette | Pumpe | Schraubkappe | Sprueher | Disc | keiner
  material: string[];            // Glas | PET | PP | HDPE | Aluminium | Keramik
  transparenz: string | null;    // klar | getoent | opak
  finish: string | null;         // matt | glaenzend | frosted | soft_touch | metallic
  volumen: string | null;        // "30ml"
  prosa: string;                 // "gedrungen, weich, apothekenhaft"
  geraten: string[];             // Felder, die geschaetzt sind -> Frontend zeichnet sie gestrichelt
}

const CLOSURE_OPTIONEN = ['Schraubverschluss', 'Pump', 'Flip-top', 'Spray', 'Pipette', 'Airless', 'Stopfen', 'Snap-On'];
const TYP_ALS_VERSCHLUSS = ['pump', 'spray', 'airless'];

function leerLesart(): Bildlesart {
  return { typ: null, form: [], schulter: null, proportion: null, verschluss: null,
    material: [], transparenz: null, finish: null, volumen: null, prosa: '', geraten: [] };
}

function alsListe(v: any): string[] {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}
function alsText(v: any): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return (!t || t.toLowerCase() === 'null' || t === '?') ? null : t;
}


// Die Lesart als Suchsatz — damit Kategorie, Identitaet und Ranking
// dieselbe Sprache bekommen wie bei einer getippten Suche.
// ══ Ein Blick, ein Urteil (v51) ══════════════════════════════════════
// Vorher lasen zwei getrennte Modellaufrufe dasselbe Foto: einer fuer die
// groben Tabellenfelder, einer fuer die Attribut-Bibliothek. Sie durften
// sich widersprechen — und taten es: die Lesart sagte "eckig", der Tagger
// "Cylindrical". Damit lief die Geometrie-Wand ins Leere.
//
// Jetzt: ein Aufruf, der beides in einem Zug entscheidet, mit demselben
// Modell und derselben Aufloesung, mit der die Systeme getaggt sind.
// Widerspruch ist damit strukturell ausgeschlossen.
let letzterBildfehler = '';

// v56 — Querschnitt. Von vorne ist ein Zylinder dasselbe Rechteck wie ein
// Quader: die Silhouette kann rund/eckig PRINZIPIELL nicht sehen. Diese
// Tatsache kommt aus einer einzigen, eng gefassten Frage an ein staerkeres
// Modell, mit Pflicht zum sichtbaren Beleg. Eine Frage mit Beleg ist etwas
// anderes als ein Formularfeld, das nebenbei angekreuzt wird — dort entstand
// "Form: rund" fuer den eckigen NUXE-Flakon.
type Querschnitt = 'rund' | 'eckig' | 'oval';

// Was ein FOTO unterscheiden kann: einem geschlossenen Deckel sieht man
// nicht an, ob er geschraubt, geschnappt oder gesteckt ist (selbst die
// Lieferantendaten sind da uneinheitlich: ENVERS GLAS = "Schraubverschluss"
// in der Tabelle, "Neck: Snap-On" im Text). Pumpe, Spray, Pipette,
// Airless und Flip-Top dagegen sieht man.
function verschlussKlasse(v: string): string {
  const n = normalizeClosure(v);
  return /schraub|snap|stopfen|screw|cork/i.test(n) ? 'deckel' : n;
}
async function querschnittLesen(dataUrl: string): Promise<Querschnitt | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([\s\S]+)$/.exec(dataUrl.trim());
  if (!m) return null;
  const [, mediaType, b64] = m;
  const system = `Du bestimmst nur EINE Sache: den waagrechten Querschnitt des
KOERPERS eines Kosmetik-Packmittels. Kappe, Pumpe und Etikett ignorieren.
- "eckig": quadratisch/rechteckig. Belege: senkrechte Kanten, flache Seitenflaechen,
  Lichtreflexe brechen an den Kanten ab, Ecken sichtbar (auch abgerundete Ecken).
- "rund": Zylinder/Kugel. Belege: durchlaufende, gebogene Reflexe, keine senkrechten
  Kanten, Etikett biegt sich um den Koerper.
- "oval": elliptisch, flach gedrueckter Zylinder ohne Kanten.
Bei echter Unsicherheit "unsicher". Antworte NUR mit JSON:
{"beleg":"<was du konkret siehst, ein Satz>","querschnitt":"rund|eckig|oval|unsicher"}`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5', max_tokens: 150, temperature: 0, system,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: 'Querschnitt des Koerpers?' },
        ] }],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const txt = (j?.content || []).map((c: any) => c?.text || '').join('');
    const q = (/"querschnitt"\s*:\s*"(rund|eckig|oval)"/i.exec(txt) || [])[1];
    return q ? (q.toLowerCase() as Querschnitt) : null;
  } catch { return null; }
}

// Querschnitt eines Systems — aus den LIEFERANTENDATEN ("Shape: Square"),
// die verlaesslicher sind als jedes Tagging (Brigitte: Tag "eckig", Lumson
// sagt "Round", Ø40 mm). Fallback: das Formfeld.
function querschnittVonSystem(p: ProductData, roh: any): Querschnitt | null {
  const texte = Object.values(roh || {}).filter(v => typeof v === 'string').join('\n');
  const m = /(?:Shape|Form)[:\s]*(?:Wert:\s*)?(Square|Rectangular|Cubic|Round|Cylindrical|Oval|Elliptical|Quadrat\w*|Rechteck\w*|Rund|Zylind\w*)/i.exec(texte);
  if (m) {
    const w = m[1].toLowerCase();
    if (/square|rectangular|cubic|quadrat|rechteck/.test(w)) return 'eckig';
    if (/oval|elliptical/.test(w)) return 'oval';
    return 'rund';
  }
  const f = (p.form || []).join(' ').toLowerCase();
  if (/eckig|square/.test(f)) return 'eckig';
  if (/oval/.test(f)) return 'oval';
  if (/rund|round/.test(f)) return 'rund';
  return null;
}

async function lesenUndTaggen(
  dataUrl: string,
  katMap: Map<string, AttrWert[]>
): Promise<{ lesart: Bildlesart; tags: Map<string, string> } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([\s\S]+)$/.exec(dataUrl.trim());
  if (!m) return null;
  const [, mediaType, b64] = m;
  if (b64.length > 5_000_000) return null;

  const menue = Array.from(katMap.entries()).map(([kat, werte]) =>
    `${kat}:\n` + werte.map(w => `  - ${w.name}${w.beschreibung ? ` (${w.beschreibung})` : ''}`).join('\n')
  ).join('\n');

  const system = `Du bist Verpackungsentwickler und liest ein Foto eines Beauty-Packmittels.
Du beschreibst NUR das Packmittel — Huelle und Verschluss. Label, Aufdruck, Inhalt,
Fluessigkeit und Hintergrund ignorierst du vollstaendig.

Du lieferst zwei Dinge in EINEM Urteil. Sie muessen zueinander passen: wenn der
Koerper eckig ist, ist er nicht zylindrisch, und umgekehrt. Widerspruch ist ein
Fehler.

TEIL 1 — Tabellenfelder. Nur diese Schreibweisen:
typ         Tiegel | Flasche | Tube | Airless | Pump | Spray | Stick | Dose
            -> der BEHAELTER, nicht der Verschluss. Eine Flasche mit
               Pumpspender ist "Flasche" mit verschluss "Pump", NICHT typ
               "Pump". "Pump", "Spray" und "Airless" als TYP nur, wenn der
               Behaelter selbst das System ist und sich nicht als Flasche,
               Tiegel oder Tube beschreiben laesst.
form        rund | oval | eckig | quadratisch | schlank | breit | freeform | spezial
            -> MEHRERE: Querschnitt UND Proportion. Flach und breit mit geraden
               Kanten = ["eckig","breit"]. Hoch und schmal mit rundem Querschnitt
               = ["rund","schlank"].
verschluss  Schraubverschluss | Pump | Flip-top | Spray | Pipette | Airless | Stopfen | Snap-On
            -> exakt eine dieser acht Schreibweisen. Nicht "Pump Dispenser",
               nicht "Schraubkappe", nicht "Dropper".
material    Glas | PET | R-PET | HDPE | PP | Aluminium | Keramik | PETG | HDPE/LDPE
volumen     5ml|10ml|15ml|20ml|30ml|50ml|75ml|100ml|125ml|150ml|200ml|250ml|300ml|500ml|1000ml
            -> immer schaetzen, Kappe als Massstab (20-25 mm breit)

TEIL 2 — Attribute. Pro Kategorie GENAU EINEN Wert aus der Liste oder null.
Keine Mindestanzahl. Eine leere Kategorie ist ein gueltiges Ergebnis und besser
als ein geratener Wert. Fuelle nicht auf.

Sieh bei der Koerpergeometrie besonders genau hin. Zylindrisch, kubisch und
facettiert sind an Silhouette, Kantenverlauf und Lichtreflexen klar zu trennen —
dieser Unterschied entscheidet spaeter alles. Waehle nicht reflexhaft
"Cylindrical", nur weil es bei Kosmetik haeufig ist. Eine Flasche mit geraden
Seitenkanten und rechteckigem Grundriss ist kubisch, auch wenn die Ecken
verrundet sind.

${menue}

Antworte NUR mit JSON, kein anderer Text:
{"typ":"<Wert oder null>","form":["<Werte>"],"verschluss":"<Wert oder null>",
 "material":["<Werte>"],"volumen":"<Wert>",
 "schulter":"<weich|eckig|abfallend|keine|null>",
 "proportion":"<gedrungen|ausgewogen|schlank|null>",
 "transparenz":"<klar|getoent|opak|null>",
 "finish":"<matt|glaenzend|frosted|soft_touch|metallic|null>",
 "prosa":"<3-6 Woerter Formcharakter>",
 "attribute":{"A1_Body_Geometry":"<Wert oder null>","A2_Body_Proportion":"<Wert oder null>", ...}}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        // Haiku reicht, wenn Lesart und Attribute aus EINEM Urteil kommen —
        // der Widerspruch war das Problem, nicht die Sehkraft. Und es haelt
        // die Suche bei Zehntelrappen statt Rappen.
        model: 'claude-haiku-4-5', max_tokens: 2000, temperature: 0, system,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            { type: 'text', text: 'Lies und tagge dieses Packmittel.' },
          ],
        }],
      }),
    });
    if (!res.ok) {
      letzterBildfehler = `Modell ${res.status}: ${(await res.text()).slice(0, 200)}`;
      return null;
    }
    const j = await res.json();
    const txt = (j?.content || []).map((c: any) => c?.text || '').join('').trim();
    let d: any;
    try {
      d = JSON.parse(txt.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    } catch {
      letzterBildfehler = `Antwort war kein JSON: ${txt.slice(0, 150)}`;
      return null;
    }

    const l = leerLesart();
    l.typ = alsText(d.typ);
    l.form = alsListe(d.form);
    l.schulter = alsText(d.schulter);
    l.proportion = alsText(d.proportion);
    // Das Modell erfindet gelegentlich Varianten ("Pump Dispenser"). Die
    // Alias-Tabelle gibt es ohnehin — hier wird sie zum Tuerwaechter.
    const vRoh = alsText(d.verschluss);
    l.verschluss = vRoh
      ? (CLOSURE_OPTIONEN.find(o => normalizeClosure(o) === normalizeClosure(vRoh)) || vRoh)
      : null;
    l.material = alsListe(d.material);
    l.transparenz = alsText(d.transparenz);
    l.finish = alsText(d.finish);
    l.volumen = alsText(d.volumen);
    l.prosa = alsText(d.prosa) || '';
    for (const f of ['material', 'transparenz', 'finish', 'volumen']) l.geraten.push(f);

    const tags = new Map<string, string>();
    for (const [kat, wert] of Object.entries(d.attribute || {})) {
      if (typeof wert !== 'string' || !wert || wert === 'null') continue;
      const erlaubt = katMap.get(kat);
      if (!erlaubt) continue;
      const t = erlaubt.find(w => w.name.toLowerCase() === wert.toLowerCase());
      if (t) tags.set(kat, t.name);
    }
    return { lesart: l, tags };
  } catch (e: any) {
    letzterBildfehler = String(e?.message || e).slice(0, 200);
    return null;
  }
}

function lesartAlsQuery(l: Bildlesart): string {
  return [
    l.typ, l.form.join(' '), l.schulter ? `${l.schulter}e Schulter` : '',
    l.proportion, l.verschluss, l.material.join(' '),
    l.transparenz, l.finish, l.prosa,
  ].filter(Boolean).join(', ');
}

function lesartKontext(l: Bildlesart): string {
  const z = (k: string, v: string | null) => v ? `${k}: ${v}` : '';
  return `\n\n[Referenzbild — so liest ulba das Teil]\n` + [
    z('Typ', l.typ), z('Form', l.form.join('/') || null), z('Schulter', l.schulter),
    z('Proportion', l.proportion), z('Verschluss', l.verschluss),
    z('Material (geschlossen)', l.material.join('/') || null),
    z('Transparenz', l.transparenz), z('Finish', l.finish),
    z('Volumen (geschaetzt)', l.volumen), z('Charakter', l.prosa),
  ].filter(Boolean).join(' | ') +
  `\nGewichte die GEOMETRIE am staerksten (Typ, Grundform, Schulter, Proportion, Verschluss).` +
  ` Material und Finish zaehlen mittel — ein Teil kann in mehreren Materialien kommen.` +
  ` Das Volumen ist geraten und darf ein sonst perfektes Teil NICHT abwerten.`;
}


// ══ Attribut-Bibliothek ══════════════════════════════════════════════
// 199 kuratierte Werte in 33 Kategorien, jede mit eigenem Gewicht — das
// eigentliche Sehvokabular von ulba. Der Bildpfad liest ein Foto AUSSCHLIESS-
// LICH in dieser Sprache, damit Foto und Archiv dasselbe meinen. Ein Modell,
// das "gedrungen" sagt, waehrend die Tabelle "Squat / Wide" kennt, matcht nie.
// Feld-IDs statt Namen: Namen koennen umbenannt werden, IDs nicht.
const ATTR_TABLE = 'tblsWJ0q2sQ7sXwvk';
const ATTR_F = {
  kategorie: 'fldaRa8uT30LC4h5o',
  name: 'fldkhYMbxvAtglzaI',
  beschreibung: 'fldduSVAFumDEDziS',
  gewicht: 'fldBUgInbJ8ec1sV1',
  systeme: 'flddgNw5dJbydl7bE',
  caps: 'fld8pRogynhcnmFD1',    // v65 — Cap.Cap_Attribute (inverse)
};

// v65 — Kappen-Merkmale haengen am CAP-Record, nicht am System: Kappen-
// geometrie (B), Kappenmaterial (D2), Kappenfarbe (E2), Kappenoberflaeche (E6).
// Das Systembild zeigt bei base+cap_separat gar keine Kappe; alles, was dort
// ueber Kappen getaggt wurde, war geraten. Beim Vergleich zaehlt ein Treffer,
// wenn IRGENDEIN Cap des Systems den Wert traegt — wie beim Verschluss.
const CAP_KAT = /^(B\d|D2|E2|E6)_/;

// G* (Label, Typografie, Umverpackung) und H1 (Nachhaltigkeit) sind nicht am
// nackten Teil ablesbar und gehoeren zur Design-Ebene — der Tagger laesst sie aus.
const SICHTBARE_PRAEFIXE = ['A', 'B', 'C', 'D', 'E', 'F'];

interface AttrWert {
  id: string; kategorie: string; name: string; beschreibung: string;
  gewicht: number; systeme: string[]; caps: string[];
}

// 5-Minuten-Cache: die Bibliothek wird jetzt bei JEDER Suche gebraucht (v65:
// auch die Textsuche sieht die Merkmale), aendert sich aber selten.
let ATTR_CACHE: AttrWert[] = [];
let attrStand = 0;
async function attributeLaden(): Promise<AttrWert[]> {
  if (Date.now() - attrStand < 300000 && ATTR_CACHE.length) return ATTR_CACHE;
  try { ATTR_CACHE = await ladeAttributBibliothek(); attrStand = Date.now(); } catch { /* alter Stand bleibt */ }
  return ATTR_CACHE;
}

async function ladeAttributBibliothek(): Promise<AttrWert[]> {
  const raus: AttrWert[] = [];
  let offset: string | null = null;
  do {
    const p = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' });
    Object.values(ATTR_F).forEach(f => p.append('fields[]', f));
    if (offset) p.set('offset', offset);
    const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${ATTR_TABLE}?${p}`,
      { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } });
    if (!r.ok) break;
    const j = await r.json();
    for (const rec of (j.records || [])) {
      const f = rec.fields || {};
      const kat = selectName(f[ATTR_F.kategorie]);
      const name = typeof f[ATTR_F.name] === 'string' ? f[ATTR_F.name] : '';
      if (!kat || !name) continue;
      raus.push({
        id: rec.id, kategorie: kat, name,
        beschreibung: typeof f[ATTR_F.beschreibung] === 'string' ? f[ATTR_F.beschreibung] : '',
        gewicht: typeof f[ATTR_F.gewicht] === 'number' ? f[ATTR_F.gewicht] : 0.03,
        systeme: Array.isArray(f[ATTR_F.systeme]) ? f[ATTR_F.systeme] : [],
        caps: Array.isArray(f[ATTR_F.caps]) ? f[ATTR_F.caps] : [],
      });
    }
    offset = j.offset || null;
  } while (offset);
  return raus;
}

// Nach Kategorie gruppiert — das ist zugleich das Menue fuer den Tagger und
// die Struktur, in der spaeter verglichen wird.
function nachKategorie(werte: AttrWert[]): Map<string, AttrWert[]> {
  const m = new Map<string, AttrWert[]>();
  for (const w of werte) {
    if (!SICHTBARE_PRAEFIXE.includes(w.kategorie.charAt(0))) continue;
    const l = m.get(w.kategorie) || [];
    l.push(w);
    m.set(w.kategorie, l);
  }
  return m;
}

// systemId -> Kategorie -> gesetzte Attributnamen. Der Link wird von der
// Bibliothek aus gelesen, nicht vom System aus: eine Richtung genuegt, und
// diese haengt an keiner Feldbenennung in der System-Tabelle.
function systemTags(werte: AttrWert[]): Map<string, Map<string, Set<string>>> {
  const m = new Map<string, Map<string, Set<string>>>();
  for (const w of werte) {
    if (CAP_KAT.test(w.kategorie)) continue; // Kappen-Merkmale: siehe capTags
    for (const sysId of w.systeme) {
      const proSys = m.get(sysId) || new Map<string, Set<string>>();
      const proKat = proSys.get(w.kategorie) || new Set<string>();
      proKat.add(w.name);
      proSys.set(w.kategorie, proKat);
      m.set(sysId, proSys);
    }
  }
  return m;
}


// capId -> Kategorie -> Attributnamen (nur Kappen-Kategorien).
function capTags(werte: AttrWert[]): Map<string, Map<string, Set<string>>> {
  const m = new Map<string, Map<string, Set<string>>>();
  for (const w of werte) {
    if (!CAP_KAT.test(w.kategorie)) continue;
    for (const capId of w.caps) {
      const proCap = m.get(capId) || new Map<string, Set<string>>();
      const proKat = proCap.get(w.kategorie) || new Set<string>();
      proKat.add(w.name);
      proCap.set(w.kategorie, proKat);
      m.set(capId, proCap);
    }
  }
  return m;
}

// System + alle seine Caps -> Kategorie -> Werte. Das ist die Sicht, in der
// verglichen wird: ein System "hat" eine Kappeneigenschaft, wenn eines seiner
// bestellbaren Caps sie traegt.
function merkmaleVon(
  sysId: string, capIds: string[],
  tags: Map<string, Map<string, Set<string>>>,
  caps: Map<string, Map<string, Set<string>>>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  tags.get(sysId)?.forEach((v, k) => out.set(k, new Set(v)));
  for (const c of capIds) {
    caps.get(c)?.forEach((v, k) => {
      const z = out.get(k) || new Set<string>();
      v.forEach(x => z.add(x));
      out.set(k, z);
    });
  }
  return out;
}

// Kompakte Merkmalzeile fuer das Text-Ranking: "Kubisch; dickwandig; matt;
// Kappe: Zylinder/Alu/Silber". Vorher sah Haiku von 200 Bibliothekswerten
// nichts — die ganze Tagging-Arbeit war fuer die Textsuche unsichtbar.
function merkmalZeile(m: Map<string, Set<string>>): string {
  const kurz = (k: string) => k.replace(/^[A-Z]\d_/, '').replace(/_/g, ' ');
  const koerper: string[] = [], kappe: string[] = [];
  Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b)).forEach(([kat, werte]) => {
    const w = Array.from(werte).join('/');
    (CAP_KAT.test(kat) ? kappe : koerper).push(`${kurz(kat)}=${w}`);
  });
  return [...koerper, ...(kappe.length ? [`Kappe: ${kappe.join(', ')}`] : [])].join('; ');
}

// Deterministischer Text-Boost: ein Suchwort, das eindeutig auf einen
// Bibliothekswert zeigt, wird nicht dem Sprachmodell ueberlassen. Treffer
// heben, Widersprueche senken (Veredelung D/E nur heben — ein Teil in Kupfer
// ist dasselbe bestellbare Teil wie in Klarglas). Gedeckelt auf +/-18, damit
// das Ranking von Haiku die Reihenfolge behaelt und nur geschaerft wird.
const SYNONYME: [RegExp, string, string][] = [
  [/\b(eckig|kubisch|quadratisch|square|cubic)/i, 'A1_Body_Geometry', 'Cubical / Square'],
  [/\b(zylind|cylind|rund(e|er|es)?\b)/i, 'A1_Body_Geometry', 'Cylindrical'],
  [/\b(bauchig|kugel|spherical|bulbous)/i, 'A1_Body_Geometry', 'Spherical / Bulbous'],
  [/\b(facett|hexagon|sechseck)/i, 'A1_Body_Geometry', 'Hexagonal / Faceted'],
  [/\b(tropfen|teardrop)/i, 'A1_Body_Geometry', 'Teardrop'],
  [/(nach unten (verj[uü]ng|schmaler|enger)|unten schmal|oben breit|tapered down|umgekehrt konisch)/i, 'A1_Body_Geometry', 'Tapered Downwards'],
  [/(nach oben (verj[uü]ng|schmaler|enger)|oben schmal|unten breit|tapered up|pyramid|konisch)/i, 'A1_Body_Geometry', 'Tapered Upwards'],
  [/\b(skulptur|freeform|organisch)/i, 'A1_Body_Geometry', 'Sculptural / Freeform'],
  [/\b(schlank|hoch und schmal|elongated|tall)/i, 'A2_Body_Proportion', 'Tall & Narrow (Elongated)'],
  [/\b(gedrungen|squat|breit und flach)/i, 'A2_Body_Proportion', 'Squat & Wide'],
  [/\b(reisegr|mini|travel)/i, 'A2_Body_Proportion', 'Mini / Travel Size'],
  [/\b(scharfe schulter|sharp shoulder|kantige schulter)/i, 'A3_Body_Shoulder', 'Sharp Shoulder'],
  [/\b(runde schulter|rounded shoulder)/i, 'A3_Body_Shoulder', 'Rounded Shoulder'],
  [/\b(schwer|dickwandig|dicker boden|heavy|thick)/i, 'A5_Body_Wall', 'Thick-Walled'],
  [/\b(d[uü]nnwandig|thin-walled)/i, 'A5_Body_Wall', 'Thin-Walled'],
  [/\b(tailliert|waisted)/i, 'A6_Body_Contour', 'Waisted'],
  [/\b(matt|matte)\b/i, 'E4_Light_Refraction', 'Matte / Light-Absorbing'],
  [/\b(gl[aä]nzend|hochglanz|glossy|gloss)/i, 'E4_Light_Refraction', 'High Gloss / Reflective'],
  [/\b(frosted|mattiert|satiniert|milchig)/i, 'E3_Translucency', 'Frosted'],
  [/\b(opak|opaque|blickdicht|undurchsichtig)/i, 'E3_Translucency', 'Fully Opaque'],
  [/\b(transparent|klarglas|durchsichtig|klar)\b/i, 'E3_Translucency', 'Fully Transparent'],
  [/\b(geb[uü]rstet|brushed)/i, 'E5_Body_Surface', 'Brushed Metal Finish'],
  [/\b(rillen|gerillt|ribbed|grooved)/i, 'E5_Body_Surface', 'Horizontal Ribs / Grooves'],
  [/\b(soft-?touch|gummiert)/i, 'E5_Body_Surface', 'Soft-Touch Coating'],
  [/\b(pr[aä]gung|embossed|relief)/i, 'E5_Body_Surface', 'Embossed Relief / 3D Pattern'],
  [/\b(braunglas|amber|bernstein)/i, 'E1_Body_Color', 'Amber / Brown'],
  [/\b(schwarz|black)\b/i, 'E1_Body_Color', 'Black'],
  [/\b(wei[sß]+|white)\b/i, 'E1_Body_Color', 'White'],
  [/\b(pastell|pastel)/i, 'E1_Body_Color', 'Pastel (Soft Colors)'],
  [/\b(knallig|bunt|saturated|bold)/i, 'E1_Body_Color', 'Bold Saturated'],
  [/\b(kobalt|cobalt|dunkelblau)/i, 'D1_Body_Material', 'Cobalt / Dark Blue Glass'],
  [/\b(alu|aluminium|aluminum)\b/i, 'D1_Body_Material', 'Aluminum'],
  [/\b(keramik|porzellan|ceramic)/i, 'D1_Body_Material', 'Ceramic / Porcelain'],
  [/\b(metallkappe|metal cap|alukappe|aluminium cap)/i, 'D2_Cap_Material', 'Aluminum Cap'],
  [/\b(holzkappe|holzdeckel|wood cap|bambus)/i, 'D2_Cap_Material', 'Wood Cap'],
  [/\b(goldkappe|gold cap|goldene kappe|gold)\b/i, 'E2_Cap_Color', 'Metallic Gold Cap'],
  [/\b(silberkappe|silver cap|silberne kappe|silber|silver)\b/i, 'E2_Cap_Color', 'Metallic Silver Cap'],
  [/\b(ros[eé]gold|rose gold)/i, 'E2_Cap_Color', 'Rose Gold Cap'],
  [/\b(schwarze kappe|black cap)/i, 'E2_Cap_Color', 'Black Cap'],
  [/\b(wei[sß]+e kappe|white cap)/i, 'E2_Cap_Color', 'White Cap'],
  [/\b([uü]berkappe|overcap)/i, 'B5_Overcap', 'Decorative Overcap'],
  [/\b(flache kappe|flat cap|low cap)/i, 'B4_Cap_Height', 'Low (Flat)'],
  [/\b(hohe kappe|oversized cap|high cap)/i, 'B4_Cap_Height', 'High / Oversized'],
];
// v67 — Was die Query beim Namen nennt: Synonyme + jeder deutsche Bibliotheks-
// Label wörtlich ("nach unten verjüngend", "dickwandig"). Neue Bibliothekswerte
// sind damit ohne Code-Änderung suchbar. Pro Kategorie gewinnt der erste Treffer
// (Synonym vor Label), damit "konisch" nicht zugleich oben und unten heisst.
const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
const woerter = (t: string) => norm(t).split(/[^a-z0-9&]+/).filter(Boolean);
// Tippfehler-tolerant: Levenshtein-Abstand, erlaubt 1 (ab 4 Zeichen) bzw. 2 (ab 8).
function abstand(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
const aehnlichWort = (q: string, w: string) => {
  if (q === w) return true;
  if (w.length < 5 || q[0] !== w[0]) return false;   // Anfangsbuchstabe muss stimmen
  const max = w.length >= 10 ? 2 : 1;
  return abstand(q, w, max) <= max;
};
// Kommt die Wortfolge `label` (tippfehler-tolerant, zusammenhängend) in der Query vor?
function enthaeltFolge(qw: string[], label: string[], frei: boolean[]): number {
  if (!label.length || label.length > qw.length) return -1;
  for (let i = 0; i + label.length <= qw.length; i++) {
    let ok = true;
    for (let j = 0; j < label.length; j++) if (!frei[i + j] || !aehnlichWort(qw[i + j], label[j])) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
const FUELL = new Set(['und', 'mit', 'in', 'aus', 'der', 'die', 'das', 'ein', 'eine', 'fuer', 'bitte', 'ich', 'will', 'suche', 'brauche', 'nach', 'oben', 'unten']);
// v68 — Tippfehler in Grundbegriffen ("flashe", "tigel", "pipete", "aluminum")
// werden VOR dem Parsen auf das Fachwort gezogen. Gleiche Regel wie bei den
// Merkmalen: Anfangsbuchstabe muss stimmen, 1 Fehler (2 ab 10 Zeichen).
const GRUNDWOERTER = ['flasche', 'flaschen', 'tiegel', 'tuben', 'airless', 'pumpe', 'spray', 'pipette',
  'tropfer', 'schraubverschluss', 'stopfen', 'aluminium', 'keramik', 'kunststoff', 'plastik', 'recycling',
  'eckig', 'quadratisch', 'schlank', 'organisch', 'flip-top'];
function korrigiere(query: string): string {
  return query.replace(/[a-zäöüß-]{5,}/gi, wort => {
    const w = norm(wort);
    if (GRUNDWOERTER.includes(w)) return wort;
    const treffer = GRUNDWOERTER.find(g => aehnlichWort(w, g));
    return treffer || wort;
  });
}

function gewollteMerkmale(query: string, attrWerte: AttrWert[]): [string, string][] {
  const qw = woerter(query);
  const raus = new Map<string, string>();
  const frei = qw.map(() => true);
  for (const [re, kat, wert] of SYNONYME) {
    if (!re.test(query) || raus.has(kat)) continue;
    raus.set(kat, wert);
    qw.forEach((w, i) => { if (re.test(w)) frei[i] = false; });
  }
  // Längere Labels zuerst, damit "nach unten verjuengend" vor "verjuengend"-Teiltreffern gewinnt.
  // Nur der deutsche Bibliotheks-Label zaehlt (der englische Name waere zu
  // nah an anderen Woertern: "Glas" ≈ "Glass Cap"). Kappen-Kategorien nur,
  // wenn die Query von der Kappe spricht — "matt" meint sonst den Koerper.
  const kappeGemeint = /(kappe|cap|deckel|verschluss)/i.test(query);
  const kandidaten = attrWerte.map(w => ({ w, folge: woerter((w.beschreibung || '').split('·')[0]) }))
    .filter(({ w, folge }) => folge.length && folge.join('').length >= 4 && !(folge.length === 1 && FUELL.has(folge[0])) && (kappeGemeint || !CAP_KAT.test(w.kategorie)))
    .sort((x, y) => (y.folge.join(' ').length - x.folge.join(' ').length) || (+CAP_KAT.test(x.w.kategorie) - +CAP_KAT.test(y.w.kategorie)));
  // Jedes Suchwort wird nur einmal vergeben: "matt" gehoert dem Koerper, nicht zusaetzlich der Kappe.
  for (const { w, folge } of kandidaten) {
    if (raus.has(w.kategorie)) continue;
    const i = enthaeltFolge(qw, folge, frei);
    if (i < 0) continue;
    raus.set(w.kategorie, w.name);
    for (let j = 0; j < folge.length; j++) frei[i + j] = false;
  }
  return Array.from(raus.entries());
}

function attributBoost(ranked: RankedProduct[], gewollt: [string, string][], tags: Map<string, Map<string, Set<string>>>, caps: Map<string, Map<string, Set<string>>>): RankedProduct[] {
  if (!gewollt.length) return ranked;
  return ranked.map(r => {
    const m = merkmaleVon(r.id, r.capIds, tags, caps);
    let delta = 0; const why: string[] = [];
    for (const [kat, wert] of gewollt) {
      const hat = m.get(kat);
      if (!hat || hat.size === 0) continue;             // ungetaggt: neutral
      if (hat.has(wert)) { delta += 6; why.push(`+${wert}`); }
      else if (!istVeredelung(kat)) { delta -= 6; why.push(`-${wert}`); }
    }
    delta = Math.max(-18, Math.min(18, delta));
    if (!delta) return r;
    return { ...r, score: Math.max(0, Math.min(100, r.score + delta)), reasoning: `${r.reasoning} [${why.join(' ')}]`.trim() };
  }).sort((a, b) => b.score - a.score);
}

// Gewichteter Attribut-Vergleich. Gezaehlt wird nur, wo BEIDE Seiten etwas
// gesagt haben — ein System wird nicht dafuer bestraft, dass eine Kategorie
// bei ihm ungetaggt ist, und das Bild nicht fuer das, was es nicht sieht.
// Veredelung ist nicht Identitaet. Dasselbe Teil in Kupfer metallisiert ist
// dasselbe bestellbare Teil wie in Klarglas — der Look kommt bei ulba ohnehin
// aus den Design-Codes. Ein Referenzfoto zeigt fast immer ein veredeltes
// Produkt, ein Lieferantenfoto das nackte Teil. Wuerden Farbe, Oberflaeche,
// Transluzenz und Material abwerten, faende die Suche das Teil nie wieder.
// Diese Kategorien zaehlen deshalb nur, wenn sie passen — nie dagegen.
function istVeredelung(kat: string): boolean {
  return kat.startsWith('D') || kat.startsWith('E');
}

function attributScore(
  sysId: string,
  bildTags: Map<string, string>,
  tags: Map<string, Map<string, Set<string>>>,
  katGewicht: Map<string, number>,
  // true, wenn die Silhouette das Referenzbild gemessen hat: dann zaehlen
  // die A-Kategorien (Geometrie) hier NICHT — eine Messung laesst sich
  // nicht von einer Schaetzung ueberstimmen. Die Attribute behalten, was
  // die Silhouette nicht sieht: Kappe, Verschluss, Material, Oberflaeche.
  geometrieGemessen = false,
  capIds: string[] = [],
  caps: Map<string, Map<string, Set<string>>> = new Map(),
): { score: number; treffer: string[]; differenz: string[]; geometrieBruch: boolean } {
  const proSys = merkmaleVon(sysId, capIds, tags, caps);
  const treffer: string[] = [];
  const differenz: string[] = [];
  let geometrieBruch = false;
  if (proSys.size === 0 || bildTags.size === 0) return { score: 0, treffer, differenz, geometrieBruch };
  let max = 0, punkte = 0;
  for (const [kat, bildWert] of bildTags) {
    if (geometrieGemessen && /^A\d/i.test(kat)) continue;
    // v57 — Verschlussmechanik zaehlt NUR in den Hardfacts: dort mit allen
    // verknuepften Caps. Das Tagging sieht nur das Basisbild (meist mit
    // Schraubkappe) und bestrafte Circus mit Pipetten-Cap als "Screw Thread
    // statt Dropper". Ein Merkmal, eine Quelle.
    if (/closure_mechanism/i.test(kat)) continue;
    const sysWerte = proSys.get(kat);
    if (!sysWerte || sysWerte.size === 0) continue; // Kategorie ungetaggt -> zaehlt nicht
    const g = katGewicht.get(kat) || 0.03;
    const veredelung = istVeredelung(kat);
    // Veredelung geht nicht in den Nenner: sie kann Punkte bringen, aber
    // keine kosten. Form entscheidet, Oberflaeche schmueckt.
    if (!veredelung) max += g;
    if (sysWerte.has(bildWert)) { punkte += veredelung ? g * 0.3 : g; treffer.push(kat); }
    else if (veredelung) { /* andere Veredelung, gleiches Teil — kein Abzug */ }
    else {
      differenz.push(`${kat.replace(/^[A-Z]\d_/, '')}: ${Array.from(sysWerte)[0]} statt ${bildWert}`);
      // Die Koerpergeometrie ist keine Nuance, sondern die Frage selbst:
      // eine kubische Referenz wird nicht durch einen Zylinder beantwortet.
      if (kat === 'A1_Body_Geometry') geometrieBruch = true;
    }
  }
  return { score: max > 0 ? (punkte / max) * 100 : 0, treffer, differenz, geometrieBruch };
}

// Harte Fakten aus der System-Tabelle, im Vokabular der Tabelle selbst.
// Typ und Form tragen das meiste Gewicht: sie sind am Foto belegbar.
function hardfactScore(p: ProductData, l: Bildlesart): { score: number; abweichung: string[]; typBruch: boolean } {
  const ab: string[] = [];
  let max = 0, punkte = 0;
  // Ein Tiegel ist keine Flasche. Der Typ ist am Foto so sicher wie nichts
  // sonst — weicht er ab, ist es schlicht die falsche Antwort.
  let typBruch = false;
  const kl = (x: string) => x.toLowerCase().trim();

  if (l.typ) {
    max += 30;
    if (p.type && kl(p.type) === kl(l.typ)) punkte += 30;
    else if (p.type) {
      // Die Type-Liste mischt Behaelterformen mit Verschlussarten. Liest das
      // Modell "Pump" als Typ und das Teil traegt tatsaechlich eine Pumpe,
      // ist das keine falsche Antwort, sondern dieselbe in anderen Worten.
      const verwechselt = TYP_ALS_VERSCHLUSS.includes(kl(l.typ))
        && !!p.closure && normalizeClosure(p.closure) === normalizeClosure(l.typ);
      if (verwechselt) punkte += 22;
      else { ab.push(`${p.type} statt ${l.typ}`); typBruch = true; }
    }
  }
  if (l.form.length) {
    max += 25;
    if (p.form.length) {
      // Jaccard: [eckig, breit] gegen [eckig, schlank] ist ein halber Treffer,
      // nicht "falsch". Form ist in dieser Tabelle mehrwertig.
      const A = new Set(l.form.map(kl)), B = new Set(p.form.map(kl));
      let schnitt = 0;
      A.forEach(x => { if (B.has(x)) schnitt++; });
      const union = new Set([...Array.from(A), ...Array.from(B)]).size;
      const j = union > 0 ? schnitt / union : 0;
      punkte += 25 * j;
      if (j < 1) {
        const fehlt = Array.from(A).filter(x => !B.has(x));
        if (fehlt.length) ab.push(`${p.form.join('/')} statt ${l.form.join('/')}`);
      }
    }
  }
  if (l.verschluss) {
    max += 15;
    const hat = p.verschluesse && p.verschluesse.length ? p.verschluesse : (p.closure ? [normalizeClosure(p.closure)] : []);
    if (hat.includes(normalizeClosure(l.verschluss))) punkte += 15;
    else if (hat.some(v => verschlussKlasse(v) === verschlussKlasse(l.verschluss!))) punkte += 12;
    else if (hat.length) ab.push(`${p.closure || hat[0]} statt ${l.verschluss}`);
  }
  if (l.material.length) {
    // Material ist am Foto oft nicht das Material: eine metallisierte
    // Glasflasche liest sich als Aluminium. Kleiner Bonus bei Treffer,
    // kein Abzug bei Abweichung.
    const alle = [...p.material, ...p.availableMaterials].map(kl);
    if (l.material.some(mm => alle.some(a => a === kl(mm) || a.startsWith(kl(mm))))) { max += 6; punkte += 6; }
  }
  if (l.volumen) {
    max += 15;
    const ziel = parseInt(l.volumen.replace(/[^0-9]/g, ''), 10);
    const gr = p.availableSizes.map(x => parseInt(x.replace(/[^0-9]/g, ''), 10)).filter(n => !isNaN(n));
    if (!isNaN(ziel) && gr.length) {
      if (gr.some(g => g === ziel)) punkte += 15;
      else {
        const naechste = gr.reduce((a, b) => Math.abs(b - ziel) < Math.abs(a - ziel) ? b : a);
        const faktor = Math.max(naechste, ziel) / Math.max(1, Math.min(naechste, ziel));
        // Das Volumen ist geschaetzt — eine Nachbargroesse bleibt fast voll
        // wertig, ein doppeltes Volumen ist ein anderes Produkt.
        punkte += faktor < 1.35 ? 11 : faktor < 2 ? 5 : 0;
        ab.push(`${naechste} ml statt geschaetzt ${ziel} ml`);
      }
    }
  }
  return { score: max > 0 ? (punkte / max) * 100 : 0, abweichung: ab, typBruch };
}

// ── Zugangs-Riegel (v46) ──────────────────────────────────────────────
// Der Renderer stand offen: CORS '*', keine Auth, kein Limit. Jeder mit der
// URL konnte auf ulbas fal.ai-/Anthropic-Guthaben rendern lassen. Ab hier
// gilt: nur die eigene Oberflaeche darf rufen, und auch die nicht endlos.
const ULBA_ORIGINS = new Set<string>([
  'https://ulba.vercel.app',
  'http://localhost:3000',
  // Zusatz-Origins (Preview-Deploys, spaeter die eigene Domain) ohne
  // Code-Deploy: ENV ULBA_ORIGINS = kommagetrennte Liste voller Origins.
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // v68 — Server-zu-Server (Suchtest aus Airtable): gleicher Schluessel wie
  // /api/harmonize. Ohne gesetztes RENDER_SECRET bleibt dieser Weg zu.
  const secret = process.env.RENDER_SECRET || '';
  const offen = riegel(req, res) || (!!secret && req.headers['x-render-secret'] === secret);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!offen) return res.status(403).json({ error: 'Zugriff nur von ulba' });
  if (!taktOk(req, 40, 300000)) return res.status(429).json({ error: 'Zu viele Anfragen — kurz warten.' });
  await lieferantenLaden();

  const { query, image, bildlesart: lesartKorrigiert, active_filters, removed_filters } = req.body as {
    query?: string;
    // v47 — Bildpfad. `image` = data-URL (Frontend skaliert vorher).
    // `bildlesart` = vom Nutzer korrigierte Chips; kommt sie mit, entfaellt
    // der Vision-Call komplett (Korrektur kostet nichts).
    image?: string;
    bildlesart?: Partial<Bildlesart>;
    active_filters?: any;
    removed_filters?: any;
  };
  // v60 — Auffrischen gespeicherter Teile (Favoriten/Projekte im Browser):
  // liefert pro ID nur die Felder, die veralten koennen. Keine Modelle.
  if (Array.isArray((req.body as any)?.ids)) {
    try {
      const ids = Array.from(new Set(((req.body as any).ids as unknown[]).filter((x): x is string => typeof x === 'string' && /^rec[A-Za-z0-9]{14}$/.test(x)))).slice(0, 400);
      if (!ids.length) return res.status(200).json({ frisch: [] });
      const will = new Set(ids);
      const recs = await airtableListAll(SYSTEM_TABLE, '{Published}=TRUE()');
      const teile = recs.filter((r: any) => will.has(r.id)).map(extractProduct);
      try {
        const capMap = await resolveCaps(Array.from(new Set(teile.flatMap(t => t.capIds))));
        for (const t of teile) {
          t.caps = t.capIds.map(id => { const c = capMap.get(id); return c ? { id, name: c.name, imageUrl: c.url } : null; })
            .filter((c): c is CapRef => c !== null);
          t.capImages = t.caps.map(c => c.imageUrl);
          t.capCount = t.caps.length;
        }
      } catch { /* Caps optional */ }
      return res.status(200).json({ frisch: teile.map(t => ({ id: t.id, name: t.name, supplier: t.supplier, imageUrl: t.imageUrl, type: t.type, material: t.material, availableSizes: t.availableSizes, closure: t.closure, caps: t.caps, capImages: t.capImages, capCount: t.capCount })),
        fehlt: ids.filter(id => !teile.some(t => t.id === id)) });
    } catch (e: any) { return res.status(200).json({ frisch: [], error: String(e?.message || e).slice(0, 160) }); }
  }

  if (!query && !image && !lesartKorrigiert) {
    return res.status(400).json({ error: 'query oder image ist erforderlich' });
  }
  if (!process.env.AIRTABLE_PAT) return res.status(500).json({ error: 'AIRTABLE_PAT env var fehlt' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY env var fehlt' });

  try {
    // 0. Bildpfad: erst lesen, dann suchen. Eine korrigierte Lesart vom
    //    Nutzer schlaegt das Modell — sie kommt ohne neuen Vision-Call.
    let lesart: Bildlesart | null = null;
    if (lesartKorrigiert) {
      lesart = { ...leerLesart(), ...lesartKorrigiert } as Bildlesart;
    }
    // Bei image wird weiter unten gelesen — erst muss die Bibliothek da sein,
    // weil Lesart und Attribute aus EINEM Aufruf kommen.
    const bildModus = lesart !== null || !!image;
    // Getippter Text hat Vorrang; ohne ihn spricht das Bild.
    const eigeneWorte = (query || '').trim();
    // Die endgueltige Query steht erst, wenn das Bild gelesen ist — das
    // passiert nach dem Laden der Bibliothek, weil beides aus einem Aufruf
    // kommt. Fuer das parallele Laden reicht solange, was schon da ist.
    const vorlaeufigeQuery = (eigeneWorte ? korrigiere(eigeneWorte) : '') || (lesart ? lesartAlsQuery(lesart) : 'Packmittel');

    // 1. Produkte + Regeln parallel laden; Identität parallel ableiten.
    //    (v64: Design-Codes werden hier nicht mehr geladen — der Design-Raum
    //    holt sie über /api/render; design_looks hatte 0 Leser im Frontend.)
    // Im reinen Bildmodus braucht es keine Identitaets-Ableitung: ein Foto
    // stellt eine geometrische Frage, keine emotionale. Das spart einen
    // Modell-Call pro Suche.
    const [allProducts, produktRegeln, identity, attrWerte] = await Promise.all([
      airtableListAll(SYSTEM_TABLE, '{Published}=TRUE()'),
      airtableListAll(PRODUKT_REGELN_TABLE),
      (bildModus && !eigeneWorte) ? Promise.resolve(null) : parseIdentity(vorlaeufigeQuery),
      attributeLaden(), // v65: immer — auch die Textsuche sieht die Merkmale
    ]);

    // Das Foto im Vokabular des Archivs taggen — 33 Kategorien, gewichtet.
    const katMap = nachKategorie(attrWerte);
    let gewollt: [string, string][] = [];
    const katGewicht = new Map<string, number>();
    katMap.forEach((werte, kat) => katGewicht.set(kat, werte[0]?.gewicht ?? 0.03));
    const tags = systemTags(attrWerte);
    const kappenTags = capTags(attrWerte);
    const merkmale = (p: ProductData) => merkmalZeile(merkmaleVon(p.id, p.capIds, tags, kappenTags));
    let bildTags = new Map<string, string>();
    // v55 — die Silhouette ist das Geometrie-Signal: sie misst den Koerper
    // als Zahl, wo das Sprachmodell sich zwischen "Cylindrical" und
    // "Spherical" entscheiden musste und jeder Uebergang verloren ging.
    // Faellt fal aus, laeuft die Suche ohne sie weiter (non-fatal).
    let refProfil: Profil | null = null;
    let formFehler = '';
    let refQuerschnitt: Querschnitt | null = null;
    if (image) {
      const [gelesen, qs, frei] = await Promise.all([
        lesenUndTaggen(image, katMap),
        querschnittLesen(image).catch(() => null),
        falFreistellen(image).catch((e: any) => { formFehler = 'fal: ' + String(e?.message || e).slice(0, 120); return null; }),
        // v57 — an vierter Stelle, damit [gelesen, qs, frei] unveraendert bleibt
        silhouettenAuffrischen(allProducts).catch(() => 0),
      ]);
      if (!gelesen && !lesart) return res.status(422).json({
        error: 'Bild konnte nicht gelesen werden. Beschreibe das Teil kurz in Worten.',
        detail: letzterBildfehler || 'kein Detail',
      });
      if (gelesen) {
        // Eine vom Nutzer korrigierte Lesart schlaegt das Modell — der
        // Aufruf liefert dann nur noch die Attribut-Tags.
        if (!lesart) lesart = gelesen.lesart;
        bildTags = gelesen.tags;
      }
      refQuerschnitt = qs as Querschnitt | null;
      if (frei) refProfil = await profilVonPng(frei).catch((e: any) => { formFehler = 'Profil: ' + String(e?.message || e).slice(0, 120); return null; });
      else if (!formFehler) formFehler = 'fal lieferte kein Bild (' + (letzterFalFehler || 'ohne Meldung') + ')';

      // Geometrie wird GEMESSEN, nicht geraten. Haiku las denselben eckigen
      // Flakon morgens als "eckig/breit" und abends als "rund/schlank" —
      // ein Wuerfel darf keine Chips beschriften. Seitenverhaeltnis 0,9
      // heisst gedrungen, egal was das Sprachmodell meint. Nur Felder, die
      // der Nutzer nicht selbst korrigiert hat, werden ueberschrieben.
      if (refProfil && lesart) {
        const sv = refProfil.seitenverhaeltnis;
        const messProportion = sv < 0.45 ? 'schlank' : sv < 0.78 ? 'ausgewogen' : 'gedrungen';
        if (!lesartKorrigiert?.proportion) lesart.proportion = messProportion;
        if (!lesartKorrigiert?.form) {
          const groesse = sv < 0.45 ? 'schlank' : sv > 0.78 ? 'breit' : null;
          let basis = (lesart.form || []).filter(w => !/schlank|breit|gedrungen|ausgewogen/i.test(w));
          if (refQuerschnitt) basis = [refQuerschnitt, ...basis.filter(w => !/rund|eckig|oval/i.test(w))];
          lesart.form = groesse ? [...basis, groesse] : basis;
        }
        lesart.geraten = (lesart.geraten || []).filter(f => f !== 'proportion' && f !== 'form');
      }
    }

    const effektiveQuery = (eigeneWorte ? korrigiere(eigeneWorte) : '') || (lesart ? lesartAlsQuery(lesart) : '');
    if (!effektiveQuery) return res.status(400).json({ error: 'Kein lesbarer Suchinhalt' });

    // 2. Spur B parsen + Client-Overrides (Chip-Removal)
    const parsedBase = parseQuery(effektiveQuery);
    let parsed = applyActiveFilters(parsedBase, active_filters, removed_filters);
    const freeHints = parsedBase.freeHints;

    // 2b. Bildregel: aus einem Foto darf nur der Typ hart filtern. Material,
    //     Groesse, Form und Verschluss sind geschlossen oder geraten — die
    //     scoren. Sonst schneidet eine Fehllesung die richtige Antwort weg.
    //     Getippte Worte des Nutzers bleiben unangetastet.
    if (bildModus && !eigeneWorte) {
      parsed = { ...parsed, sizeMentions: [], materialMentions: [], closureMentions: [], formMentions: [] };
    }

    // 3. Spur A: Formel → Wand (deterministisch)
    const formeln = parseFormula(effektiveQuery);
    const wall = buildFormulaWall(formeln);

    // 4. Kategorie (Produkt_Regeln)
    const category = matchCategory(effektiveQuery, produktRegeln);

    // 5. Extraktion
    const products = allProducts.map(extractProduct);

    // 5b. Cap-Verschlussarten nur laden, wenn ein Verschluss-Filter aktiv ist
    //     (spart den Extra-Call im Normalfall). Der Verschluss hängt am Cap,
    //     nicht am Base → ohne diese Map filtert "Pump" alle Bases weg.
    // Im Bildmodus immer: ein System traegt meist mehrere Verschluesse
    // (Basis + verknuepfte Caps) — nur den Basis-Verschluss zu vergleichen
    // erklaerte Carmen faelschlich zu "Schraubverschluss statt Pump".
    const capClosures = (parsed.closureMentions.length > 0 || !!image || !!lesart)
      ? await loadCapClosureMap()
      : new Map<string, string>();

    // 6. Hard Filter (Spur B + Regeln + Formel-Wand)
    for (const p of products) {
      const alle = [p.closure, ...p.capIds.map(id => capClosures.get(id) || '')].filter(Boolean);
      p.verschluesse = [...new Set(alle.map(normalizeClosure))];
    }
    let filtered = hardFilter(products, parsed, category, wall, capClosures);

    // 6b. Nie eine leere Liste ohne Erklaerung. Greift der Filter im
    //     Bildmodus zu scharf, faellt die Suche auf das ganze Archiv zurueck
    //     und das Ranking entscheidet — mit Abweichung an jeder Karte.
    let bildFallback = false;
    if (bildModus && filtered.length < 3) { filtered = products; bildFallback = true; }

    // 7. Ranking. Zwei Wege, je nachdem, was gefragt wurde.
    let ranked: RankedProduct[];
    if (bildModus && !eigeneWorte) {
      // Reiner Bildmodus: rein deterministisch. Harte Fakten (60 %) und der
      // gewichtete Attribut-Vergleich (40 %) entscheiden — nachvollziehbar,
      // reproduzierbar, ohne Sprachmodell im Ranking.
      // Spreizung: Rechteckige Umrisse liegen alle bei 89–98 % — als
      // Rohwert sieht 98 gegen 91 wie Gleichstand aus. Pro Suche relativ
      // zum besten und schlechtesten Kandidaten gedehnt, halb-halb mit dem
      // Rohwert, damit ein schwaches Feld nicht kuenstlich stark wirkt.
      const silRoh = new Map<string, number>();
      // v57c — Schulter gibt es nur bei Flaschen. Ein schraeg fotografierter
      // Tiegel zeigt den Deckelrand als Ellipse, das misst sich wie eine runde
      // Schulter (Kupfertiegel: 35°) und hat ENVERS GLAS verdraengt. Ist eine
      // Seite ein Tiegel, wird die Schulter auf beiden Seiten ausgeblendet.
      const ohneSchulter = (pr: Profil): Profil => ({ ...pr, schulter: null, schulterEnde: null });
      const refIstTiegel = /tiegel/i.test(lesart?.typ || '');
      if (refProfil) for (const p of filtered) if (p.silhouette) {
        const tiegel = refIstTiegel || /tiegel/i.test(p.type || '');
        silRoh.set(p.id, tiegel
          ? aehnlichkeit(ohneSchulter(refProfil), ohneSchulter(p.silhouette))
          : aehnlichkeit(refProfil, p.silhouette));
      }
      const silWerte = [...silRoh.values()];
      const silMax = silWerte.length ? Math.max(...silWerte) : 100;
      const silMin = silWerte.length ? Math.min(...silWerte) : 0;
      const silSpreiz = (v: number) => silMax - silMin < 1 ? v : Math.round(0.5 * v + 0.5 * 100 * (v - silMin) / (silMax - silMin));

      ranked = filtered.map(p => {
        const hf = hardfactScore(p, lesart!);
        const at = attributScore(p.id, bildTags, tags, katGewicht, refProfil !== null, p.capIds, kappenTags);
        // Arbeitsteilung (v55): die SILHOUETTE misst den Koerper als Zahl
        // und ersetzt die harte A1-Wand — sie kennt den Uebergang zwischen
        // bauchig und zylindrisch, den eine Kategorie nicht kennt. Die
        // ATTRIBUTE steuern bei, was die Silhouette nicht sieht: Kappe,
        // Kappen-Koerper-Verhaeltnis, Verschluss, Oberflaeche. HARDFACTS
        // filtern (Typ-Wand bleibt) und ergaenzen Volumen.
        const silR = silRoh.get(p.id);
        const sil = silR !== undefined ? silSpreiz(silR) : null;
        let gesamt: number;
        if (sil !== null) {
          // Die Form ENTSCHEIDET, der Rest ORDNET nur. Als Summe konnten
          // zwanzig kleine Uebereinstimmungen (Material, Verschluss) eine
          // grosse Formdifferenz aufwiegen: Circus (Form 68) schlug Carmen
          // (Form 93), weil Carmen eine andere Kappe traegt — die bei ulba
          // ein eigenes, austauschbares Teil ist. Multiplikativ kann der
          // Rest die Form hoechstens um 30 % druecken.
          const rest = at.score > 0 ? at.score * 0.6 + hf.score * 0.4 : hf.score;
          gesamt = sil * (0.8 + 0.2 * Math.max(0, Math.min(100, rest)) / 100);
        } else {
          gesamt = at.score > 0 ? at.score * 0.7 + hf.score * 0.3 : hf.score;
          if (at.geometrieBruch) gesamt *= 0.45;
        }
        if (hf.typBruch) gesamt *= 0.5;
        // Querschnitt-Wand (v56): rund vs. eckig ist eine harte Tatsache,
        // die der Umriss nicht sehen kann. Kein Ausschluss — die Teile
        // rutschen nur hinter alle mit passendem Querschnitt.
        let qBruch = false;
        if (refQuerschnitt && p.querschnitt && refQuerschnitt !== p.querschnitt) {
          const nah = (refQuerschnitt === 'oval' || p.querschnitt === 'oval');
          gesamt *= nah ? 0.8 : 0.6;
          qBruch = true;
        }
        // Mit gemessener Form sind die alten Formtext-Vergleiche
        // ("rund/schlank statt rund/breit") Rauschen — ersetzt durch den
        // Querschnitt, der wirklich zaehlt.
        const hfAb = refProfil ? hf.abweichung.filter(x => !/schlank|breit|gedrungen|ausgewogen|eckig|rund/i.test(x)) : hf.abweichung;
        // Komplettsystem (Pump/Airless mit Refill): bei ulba ist die Kappe
        // sonst ein eigenes, austauschbares Teil — darum ignoriert die
        // Silhouette sie. Bei einem System ist sie Teil der Identitaet.
        let sysBruch = false;
        const sysV = p.verschluesse && p.verschluesse.length ? p.verschluesse : (p.closure ? [normalizeClosure(p.closure)] : []);
        if (p.komplettsystem && lesart!.verschluss && sysV.length
            && !sysV.some(v => verschlussKlasse(v) === verschlussKlasse(lesart!.verschluss!))) {
          gesamt *= 0.6; sysBruch = true;
        }
        const naeh = [
          ...(qBruch ? [`${p.querschnitt} statt ${refQuerschnitt}`] : []),
          ...(sysBruch ? [`Komplettsystem (${p.closure})`] : []),
          ...hfAb, ...at.differenz];
        return {
          ...p,
          score: Math.round(Math.max(0, Math.min(100, gesamt))),
          reasoning: sil !== null
            ? `Form ${sil}% nah${at.treffer.length ? `, gleiche ${at.treffer.length} von ${bildTags.size} Bildmerkmalen` : ''}${naeh.length ? `, abweichend in ${naeh.length}` : ''}.`
            : at.treffer.length
              ? `Gleiche ${at.treffer.length} von ${bildTags.size} Bildmerkmalen${naeh.length ? `, abweichend in ${naeh.length}` : ''}.`
              : 'Passung ueber Typ, Form, Verschluss und Material.',
          abweichung: naeh.slice(0, 4),
          formNaehe: silR ?? null,
          wand: hf.typBruch || qBruch || sysBruch,
        } as RankedProduct;
      }).sort((a, b) => b.score - a.score);
    } else {
      // Text dabei: Claude rankt weiter, die Bildlesart kommt als Kontext.
      const rankQuery = lesart ? effektiveQuery + lesartKontext(lesart) : effektiveQuery;
      ranked = await claudeRank(rankQuery, filtered, category, identity, wall, merkmale);
      gewollt = gewollteMerkmale(effektiveQuery, attrWerte);
      ranked = attributBoost(ranked, gewollt, tags, kappenTags);
      if (lesart) {
        for (const r of ranked) {
          const hf = hardfactScore(r, lesart);
          const at = attributScore(r.id, bildTags, tags, katGewicht, false, r.capIds, kappenTags);
          let g = r.score * 0.4 + at.score * 0.4 + hf.score * 0.2;
          if (at.geometrieBruch) g *= 0.6;
          r.score = Math.round(Math.max(0, Math.min(100, g)));
          r.abweichung = [...hf.abweichung, ...at.differenz].slice(0, 4);
        }
        ranked.sort((a, b) => b.score - a.score);
      }
    }

    // 7b. Caps für Top-Ergebnisse auflösen
    const TOP_N_FOR_CAPS = 30;
    const neededCapIds = Array.from(new Set(ranked.slice(0, TOP_N_FOR_CAPS).flatMap(r => r.capIds)));
    if (neededCapIds.length > 0) {
      try {
        const capMap = await resolveCaps(neededCapIds);
        for (const r of ranked) {
          r.caps = r.capIds.map(id => {
            const c = capMap.get(id);
            return c ? { id, name: c.name, imageUrl: c.url } : null;
          }).filter((c): c is CapRef => c !== null);
          r.capImages = r.caps.map(c => c.imageUrl);
          r.capCount = r.caps.length;
        }
      } catch { /* Cap-Daten optional */ }
    }

    // Wie viele Treffer sind wirklich nah? Eine Suchmaschine, die 18 Teile
    // ausbreitet, obwohl zwei passen, ist wieder ein Katalog. Nah heisst:
    // innerhalb von 12 Punkten zur Spitze und mindestens 50 Punkte absolut.
    // Der Rest bleibt erreichbar, wird aber nicht als Antwort behauptet.
    let nah = 0, aehnlich = 0;
    if (bildModus && ranked.length > 0) {
      const spitze = ranked[0].score;
      nah = ranked.filter(r => r.score >= Math.max(50, spitze - 8)).length;
      nah = Math.min(Math.max(nah, 1), 4);
      // Zweite Stufe — Alens Anforderung: gibt es keinen Volltreffer,
      // zeigt ulba trotzdem, was in der Form verwandt ist, klar als
      // "aehnlich" gekennzeichnet statt als Antwort behauptet.
      // "Aehnlich" heisst: gleiche Gattung, andere Auspraegung — nicht das
      // Beste vom Rest. Wer an einer Identitaetswand abgeprallt ist
      // (Querschnitt, Typ, Komplettsystem, Material), gehoert nicht hierher.
      // Lieber weniger zeigen als Falsches als verwandt verkaufen.
      const kandidaten = ranked.slice(nah).filter(r => !r.wand && r.score >= Math.max(45, spitze - 20)).slice(0, 4);
      if (kandidaten.length) {
        const ids = new Set(kandidaten.map(r => r.id));
        ranked = [...ranked.slice(0, nah), ...kandidaten, ...ranked.slice(nah).filter(r => !ids.has(r.id))];
      }
      aehnlich = kandidaten.length;
    }

    // v66 — Merkmale fuer das Frontend: Datenblatt + Eingrenz-Chips. Label
    // ist der deutsche Untertitel aus der Bibliothek ("Kubisch · gerade
    // Kanten" -> "Kubisch"), Kappen-Werte aus allen Caps des Systems.
    const labelVon = new Map<string, string>();
    for (const w of attrWerte) {
      const kurz = (w.beschreibung || '').split('·')[0].trim();
      labelVon.set(`${w.kategorie}::${w.name}`, kurz && kurz.length <= 28 ? kurz : w.name);
    }
    const merkmalListe = (sysId: string, capIds: string[]) => {
      const out: { kat: string; wert: string; label: string }[] = [];
      merkmaleVon(sysId, capIds, tags, kappenTags).forEach((werte, kat) =>
        werte.forEach(wert => out.push({ kat, wert, label: labelVon.get(`${kat}::${wert}`) || wert })));
      return out;
    };

    // Interne Felder nicht an Client leaken (capIds, excluded)
    const publicResults = ranked.map(({ capIds, excluded, ...rest }) => ({ ...rest, merkmale: merkmalListe(rest.id, capIds) }));
    // v67 — Merkmale, die die Query (tippfehler-tolerant) nennt, kommen als
    // aktive Filter-Pillen zurück (wie Typ/Material). Nur, wenn mindestens
    // ein Ergebnis passt — sonst lieber alles zeigen als nichts.
    // Keine Doppel-Pille: Material/Verschluss stehen schon als harte Filter oben.
    const merkmalWahl = gewollt
      .filter(([kat]) => !(kat.startsWith('D1_') && parsed.materialMentions.length) && !(kat.startsWith('F1_') && parsed.closureMentions.length))
      .map(([kat, wert]) => ({ key: `${kat}::${wert}`, label: labelVon.get(`${kat}::${wert}`) || wert }))
      .filter(x => publicResults.some(r => r.merkmale.some(m => `${m.kat}::${m.wert}` === x.key)));

    // 8. Log (fire-and-forget)
    const SEARCH_LOG_TABLE = 'tbljh9GowT7JkJcn4';
    fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${SEARCH_LOG_TABLE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` },
      body: JSON.stringify({
        fields: {
          Query: bildModus && !eigeneWorte ? `[BILD] ${effektiveQuery}` : effektiveQuery,
          Category_Match: category?.category || '',
          Total_Products: products.length,
          After_Filter: filtered.length,
          Top_Results: JSON.stringify(ranked.slice(0, 5).map(r => ({ id: r.id, name: r.name, score: r.score }))),
          Parsed_Filters: JSON.stringify({
            sizes: parsed.sizeMentions, materials: parsed.materialMentions,
            types: parsed.typeMentions, closures: parsed.closureMentions, forms: parsed.formMentions,
            formeln, wall: wall.notes,
          }),
          Timestamp: new Date().toISOString(),
        },
      }),
    }).catch(() => {});

    return res.status(200).json({
      results: publicResults,
      merkmal_wahl: merkmalWahl,
      query: effektiveQuery,
      // v47 — korrigierbare Chips. `geraten` sagt dem Frontend, welche
      // gestrichelt zu zeichnen sind. Korrektur zurueckschicken als
      // `bildlesart` — dann ordnet sich die Liste ohne neuen Vision-Call.
      bildlesart: lesart,
      // Diagnose: wurde die Geometrie gemessen? Wenn nicht, warum.
      form_messung: image ? (refProfil
        ? { aktiv: true, seitenverhaeltnis: +refProfil.seitenverhaeltnis.toFixed(2), profil: refProfil.breiten.map(b => +b.toFixed(2)) }
        : { aktiv: false, grund: formFehler || 'unbekannt' }) : null,
      bild_tags: Array.from(bildTags.entries()).map(([kat, wert]) => ({ kat, wert })),
      nah,
      aehnlich,
      bild_fallback: bildFallback,
      totalProducts: products.length,
      afterFilter: filtered.length,
      categoryMatch: category?.category || null,
      // v30 — Kompetenz-Satz fuer den Chat (vor den Kacheln)
      hinweis: formelHinweis(category, effektiveQuery),
      // Spur B — Chips (unverändertes Frontend-Kontrakt + neu: forms)
      parsedFilters: {
        sizes: parsed.sizeMentions, materials: parsed.materialMentions,
        types: parsed.typeMentions, closures: parsed.closureMentions, forms: parsed.formMentions,
      },
      // Spur A — abgeleitete Ebenen (Transparenz + Segment-Prep)
      engine: {
        formel_eigenschaften: formeln,
        register: identity?.register || null,
        temperatur_laut: identity?.temperatur_laut || null,
        temperatur_ton: identity?.temperatur_ton || null,
        hero_ingredient: identity?.hero_ingredient || null,
        // Cursor-Startposition — bewusst dasselbe Shape wie design_code im
        // Render: { wert, gesetzt, quelle }. Jede künftige Achse liefert es
        // identisch, damit die Führungs-Chips generisch daraus entstehen.
        achsen: {
          temp_laut: { wert: identity?.temp_laut ?? null, gesetzt: identity?.temp_laut != null, quelle: 'brief' },
          temp_ton:  { wert: identity?.temp_ton  ?? null, gesetzt: identity?.temp_ton  != null, quelle: 'brief' },
          register:  { wert: identity?.register  ?? null, gesetzt: !!identity?.register,        quelle: 'brief' },
        },
      },
      // Wand — was gesperrt wurde + Render-Direktiven (SF-Gate liest force_tint)
      wall: {
        notes: wall.notes,
        force_tint_if_glass: wall.forceTintIfGlass,
        prefer_opaque: wall.preferOpaque,
        forbidden: {
          material: wall.forbidMaterial, type: wall.forbidType, // Base-Ebene
        },
      },
      // Cap-Wand — Verschluss-Ebene fürs "Verschluss wählen"-Panel.
      // deprioritize_open_dropper: Pipetten-Cap nach hinten sortieren + Hinweis,
      // NICHT entfernen (bei getöntem Glas legitim).
      cap_wall: {
        deprioritize_open_dropper: wall.deprioritizeOpenDropper,
      },
      // §8.2 Freiheitsgrade — pre-seed Pill-State vor erstem Render
      free_hints: {
        finish: freeHints.finish,
        base_weight: freeHints.baseWeight,
        form: parsed.formMentions[0] || null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
    console.error('Search error:', message);
    return res.status(500).json({ error: message });
  }
}
