import { VercelRequest, VercelResponse } from '@vercel/node';

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
    [/airless/, 'Airless'],
    [/\bpump(e|en)?\b/, 'Pump'],
    [/spray|sprüh|spruh/, 'Spray'],
    [/\bstick\b/, 'Stick'],
  ];
  const typeMentions = typeMap.filter(([re]) => re.test(q)).map(([, v]) => v)
    .filter((v, i, a) => a.indexOf(v) === i);

  // Closure → REALE Options
  const closureMap: Array<[RegExp, string]> = [
    [/pipette|dropper|tropfer/, 'Pipette'],
    [/schraub|screw/, 'Schraubverschluss'],
    [/flip[-\s]?top|flip[-\s]?cap/, 'Flip-top'],
    [/\bpump(e|en)?\b/, 'Pump'],
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

// active_filters vom Client: erlaubt gezieltes Entfernen einzelner Filter
// (X-Klick auf Chip). Nur bekannte Keys — kein Injizieren neuer Constraints.
function applyActiveFilters<T extends ParsedQuery>(parsed: T, override: any): T {
  if (!override || typeof override !== 'object') return parsed;
  const arr = (v: any): string[] => Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  return {
    ...parsed,
    sizeMentions: 'sizes' in override ? arr(override.sizes) : parsed.sizeMentions,
    materialMentions: 'materials' in override ? arr(override.materials) : parsed.materialMentions,
    typeMentions: 'types' in override ? arr(override.types) : parsed.typeMentions,
    closureMentions: 'closures' in override ? arr(override.closures) : parsed.closureMentions,
    formMentions: 'forms' in override ? arr(override.forms) : parsed.formMentions,
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
  temperatur_laut: string | null; // leise|laut
  temperatur_ton: string | null;  // serioes|verspielt
  hero_ingredient: string | null;
}
async function parseIdentity(query: string): Promise<Identity | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const system = `Du liest einen Beauty-Marken-Brief und gibst NUR die weiche Identitäts-Ebene zurück. Keine Physik.
Antworte NUR mit JSON:
{"register":"pharma-klinisch|tech-premium|clean-minimal|natur-erdig|luxus-ritual|masse-funktional|null","temperatur_laut":"leise|laut|null","temperatur_ton":"serioes|verspielt|null","hero_ingredient":"<zutat oder null>"}
Regeln: temperatur_laut ist ORTHOGONAL zum Register (natur kann laut sein). Nur setzen, was der Brief hergibt, sonst null.`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5', max_tokens: 200, system,
        messages: [{ role: 'user', content: `Brief: "${query}"` }],
      }),
    });
    const data = await res.json() as { content: Array<{ text: string }> };
    const raw = (data.content?.[0]?.text || '').replace(/```json\s?|```/g, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    const nn = (v: any) => (v && v !== 'null') ? String(v) : null;
    return {
      register: nn(p.register), temperatur_laut: nn(p.temperatur_laut),
      temperatur_ton: nn(p.temperatur_ton), hero_ingredient: nn(p.hero_ingredient),
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
    supplier: multiSelectNames(f['Lieferant'])[0] || '',
  };
}

async function resolveCaps(capIds: string[]): Promise<Map<string, { url: string; name: string }>> {
  const map = new Map<string, { url: string; name: string }>();
  if (capIds.length === 0) return map;
  const capRecords = await airtableListAll(CAP_TABLE);
  for (const rec of capRecords) {
    const url = imgUrl(rec.fields['Cap_Bild_Harmonisiert']) || imgUrl(rec.fields['Cap_Bild']);
    const name = rec.fields['Cap_Name'] || rec.fields['Artikelnummer'] || '';
    if (url) map.set(rec.id, { url, name });
  }
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
  wall: FormulaWall
): ProductData[] {
  const inc = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

  return products.filter(p => {
    // ── Spur B: Nutzer-explizite Filter (positiv) ──────────────────
    if (parsed.materialMentions.length > 0) {
      const hit = parsed.materialMentions.some(m =>
        p.material.some(pm => inc(pm, m)) || p.availableMaterials.some(am => inc(am, m)));
      if (!hit) return false;
    }
    if (parsed.typeMentions.length > 0) {
      if (!parsed.typeMentions.some(t => inc(p.type, t))) return false;
    }
    if (parsed.closureMentions.length > 0) {
      if (!parsed.closureMentions.some(c => inc(p.closure, c))) return false;
    }
    if (parsed.formMentions.length > 0) {
      if (p.form.length > 0 && !parsed.formMentions.some(fm => p.form.some(pf => inc(pf, fm)))) return false;
      // Kein Form-Datum am Produkt → nicht ausschließen (Data Gap).
    }
    if (parsed.sizeMentions.length > 0 && p.availableSizes.length > 0) {
      const hasSize = parsed.sizeMentions.some(s => p.availableSizes.some(as => inc(as, s)));
      if (!hasSize) return false;
    }

    // ── Produkt_Regeln (Kategorie-Constraints) ─────────────────────
    if (category) {
      if (category.nichtMaterial.some(nm => p.material.some(pm => inc(pm, nm)))) return false;
      if (category.nichtClosure.some(nc => inc(p.closure, nc))) return false;
      if (category.nichtType.some(nt => inc(p.type, nt))) return false;
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
    if (wall.forbidMaterial.some(fm => p.material.some(pm => inc(pm, fm)))) return false;
    if (wall.forbidType.some(ft => inc(p.type, ft))) return false;

    return true;
  });
}

// ── Claude Ranking (Ebene 2 — wählt innerhalb der erlaubten Menge) ────
interface RankedProduct extends ProductData {
  score: number;
  reasoning: string;
}

async function claudeRank(
  query: string,
  products: ProductData[],
  category: CategoryConstraints | null,
  identity: Identity | null,
  wall: FormulaWall
): Promise<RankedProduct[]> {
  if (products.length === 0) return [];

  const productList = products.map((p, i) =>
    `[${i}] ${p.name} | Type: ${p.type} | Material: ${p.material.join(',')} | Form: ${p.form.join(',')} | Closure: ${p.closure} | Fähigkeiten: ${p.capabilities.join(',') || '—'} | Sizes: ${p.availableSizes.join(',')} | ${p.description}`
  ).join('\n');

  let categoryContext = '';
  if (category) {
    categoryContext = `\nKategorie "${category.category}". Bevorzugt: Material ${category.bevorzugtMaterial.join(', ')}; Closure ${category.bevorzugtClosure.join(', ')}; Type ${category.bevorzugtType.join(', ')}.`;
  }
  let identityContext = '';
  if (identity) {
    identityContext = `\nAbgeleitete Identität — Register: ${identity.register || '?'}; Lautstärke: ${identity.temperatur_laut || '?'}; Ton: ${identity.temperatur_ton || '?'}; Hero: ${identity.hero_ingredient || '?'}. Lautstärke ist orthogonal zum Register.`;
  }
  let wallContext = '';
  if (wall.notes.length > 0) {
    wallContext = `\nFormel-Wand aktiv (bereits gefiltert): ${wall.notes.join(' | ')}.${wall.preferOpaque ? ' "Laut" muss über gesättigte Vollfarbe auf opaker/getönter Hülle laufen (kein Klarglas).' : ''}`;
  }

  const systemPrompt = `Du bist Sourcing-Experte für Beauty-Packaging.
Ranke, wie gut jedes Produkt zum Brief passt — emotional UND funktional.
Die harten physikalischen Wände sind bereits angewandt; ranke innerhalb der erlaubten Menge.
Berücksichtige: Register, Lautstärke/Ton (Q6, orthogonal), Zielgruppe, Material-Sprache, Formsprache.${categoryContext}${identityContext}${wallContext}
Antworte NUR mit JSON-Array, kein anderer Text:
[{"index":0,"score":85,"reasoning":"kurz"}]
Score 0-100. Sei entschieden — spreize die Scores. Bester Fit 90+, schlechter <30.`;

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
        max_tokens: 1500,
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
    const rankings = JSON.parse(m[0]) as Array<{ index: number; score: number; reasoning: string }>;

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
    return products.map(p => ({ ...p, score: 50, reasoning: `Ranking-Fehler: ${grund}${snippet}` }));
  }
}

// ── Main Handler ────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, active_filters } = req.body as { query: string; active_filters?: any };
  if (!query) return res.status(400).json({ error: 'query ist erforderlich' });
  if (!process.env.AIRTABLE_PAT) return res.status(500).json({ error: 'AIRTABLE_PAT env var fehlt' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY env var fehlt' });

  try {
    // 1. Produkte + Regeln parallel laden; Identität parallel ableiten
    const [allProducts, produktRegeln, identity] = await Promise.all([
      airtableListAll(SYSTEM_TABLE, '{Published}=TRUE()'),
      airtableListAll(PRODUKT_REGELN_TABLE),
      parseIdentity(query),
    ]);

    // 2. Spur B parsen + Client-Overrides (Chip-Removal)
    const parsedBase = parseQuery(query);
    const parsed = applyActiveFilters(parsedBase, active_filters);
    const freeHints = parsedBase.freeHints;

    // 3. Spur A: Formel → Wand (deterministisch)
    const formeln = parseFormula(query);
    const wall = buildFormulaWall(formeln);

    // 4. Kategorie (Produkt_Regeln)
    const category = matchCategory(query, produktRegeln);

    // 5. Extraktion
    const products = allProducts.map(extractProduct);

    // 6. Hard Filter (Spur B + Regeln + Formel-Wand)
    const filtered = hardFilter(products, parsed, category, wall);

    // 7. Ranking (Ebene 2)
    const ranked = await claudeRank(query, filtered, category, identity, wall);

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

    // Interne Felder nicht an Client leaken (capIds, excluded)
    const publicResults = ranked.map(({ capIds, excluded, ...rest }) => rest);

    // 8. Log (fire-and-forget)
    const SEARCH_LOG_TABLE = 'tbljh9GowT7JkJcn4';
    fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${SEARCH_LOG_TABLE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` },
      body: JSON.stringify({
        fields: {
          Query: query,
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
      query,
      totalProducts: products.length,
      afterFilter: filtered.length,
      categoryMatch: category?.category || null,
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
