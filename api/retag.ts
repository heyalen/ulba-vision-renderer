import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * api/retag.ts — Systeme mit demselben Auge lesen wie die Referenzfotos.
 *
 * Warum es das gibt: die Attribut-Bibliothek war flaechig vergeben. 19 von 22
 * Systemen trugen bei A1_Body_Geometry (Gewicht 0,2) den Wert "Cylindrical",
 * auch die kubischen. Damit kann keine Bildsuche zwei Teile unterscheiden.
 * Dieser Endpunkt schickt jedes Systembild durch denselben Tagger, den die
 * Bildsuche auf das Referenzfoto anwendet. Gleiche Maschine, gleiches
 * Vokabular, auf beiden Seiten — nur so ist ein Vergleich ueberhaupt gueltig.
 *
 * Aufruf (GET oder POST), Secret als Header x-ulba-dev:
 *   ?dry=1            Vorschau, schreibt nichts (Standard)
 *   ?dry=0            schreibt die Attribute in die System-Tabelle
 *   ?limit=5          nur die ersten N Systeme (zum Antesten)
 *   ?nur=A1,A2,A6     nur diese Kategorien anfassen, Rest bleibt unberuehrt
 */

const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const SYSTEM_TABLE = 'tblB1kWay9TvX3rGv';
const ATTR_TABLE = 'tblsWJ0q2sQ7sXwvk';
const SYS_F = { bild: 'fldhqLDn8TYJ8VmG3', bildAlt: 'fldGcXPHX1jpg40r4', attribute: 'fldZy4cS6MPJJlKYf', name: 'fld6MYHRyYtfVatBe' };
const ATTR_F = { kategorie: 'fldaRa8uT30LC4h5o', name: 'fldkhYMbxvAtglzaI', beschreibung: 'fldduSVAFumDEDziS', gewicht: 'fldBUgInbJ8ec1sV1' };
const SICHTBAR = ['A', 'B', 'C', 'D', 'E', 'F'];

interface AttrWert { id: string; kategorie: string; name: string; beschreibung: string }

function selName(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.name) return String(v.name);
  return '';
}

async function at(pfad: string, params: URLSearchParams): Promise<any> {
  const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${pfad}?${params}`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } });
  if (!r.ok) throw new Error(`Airtable ${r.status} auf ${pfad}`);
  return r.json();
}

async function ladeAlle(tabelle: string, felder: string[], formel?: string): Promise<any[]> {
  const raus: any[] = [];
  let offset: string | null = null;
  do {
    const p = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' });
    felder.forEach(f => p.append('fields[]', f));
    if (formel) p.set('filterByFormula', formel);
    if (offset) p.set('offset', offset);
    const j = await at(tabelle, p);
    raus.push(...(j.records || []));
    offset = j.offset || null;
  } while (offset);
  return raus;
}

function bildUrlVon(f: any): string | null {
  for (const key of [SYS_F.bild, SYS_F.bildAlt]) {
    const a = f[key];
    if (Array.isArray(a) && a[0]?.url) return a[0].url as string;
  }
  return null;
}

async function alsBase64(url: string): Promise<{ media: string; data: string } | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const media = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\/(jpeg|png|webp|gif)$/.test(media)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4_000_000) return null;
    return { media, data: buf.toString('base64') };
  } catch { return null; }
}

async function tagge(bild: { media: string; data: string }, katMap: Map<string, AttrWert[]>): Promise<Map<string, string>> {
  const raus = new Map<string, string>();
  const menue = Array.from(katMap.entries()).map(([kat, w]) =>
    `${kat}:\n` + w.map(x => `  - ${x.name}${x.beschreibung ? ` (${x.beschreibung})` : ''}`).join('\n')
  ).join('\n');

  const system = `Du bist Verpackungsentwickler und liest ein Produktfoto eines Beauty-Packmittels.
Du beschreibst NUR das Packmittel — Huelle und Verschluss. Label, Text, Inhalt und Hintergrund ignorierst du.

Waehle pro Kategorie GENAU EINEN Wert aus der Liste, oder null, wenn das Foto es nicht hergibt.
Nur exakte Schreibweisen aus der Liste. Erfinde nichts.
Sieh genau hin: der Unterschied zwischen zylindrisch, kubisch und facettiert entscheidet alles.
Lieber null als geraten.

${menue}

Antworte NUR mit einem JSON-Objekt {"<Kategorie>":"<Wert oder null>", ...}, kein anderer Text.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens: 1200, temperature: 0, system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: bild.media, data: bild.data } },
          { type: 'text', text: 'Tagge dieses Packmittel.' },
        ],
      }],
    }),
  });
  if (!res.ok) return raus;
  const j = await res.json();
  const txt = (j?.content || []).map((c: any) => c?.text || '').join('').trim();
  let d: any;
  try { d = JSON.parse(txt.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()); } catch { return raus; }
  for (const [kat, wert] of Object.entries(d)) {
    if (typeof wert !== 'string' || !wert || wert === 'null') continue;
    const erlaubt = katMap.get(kat);
    if (!erlaubt) continue;
    const t = erlaubt.find(x => x.name.toLowerCase() === String(wert).toLowerCase());
    if (t) raus.set(kat, t.name);
  }
  return raus;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!process.env.ULBA_DEV_SECRET || req.headers['x-ulba-dev'] !== process.env.ULBA_DEV_SECRET) {
    return res.status(403).json({ error: 'Nur mit Dev-Secret' });
  }
  if (!process.env.AIRTABLE_PAT || !process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Env-Variablen fehlen' });
  }
  const q = req.query as Record<string, string>;
  const dry = q.dry !== '0';
  const limit = q.limit ? parseInt(q.limit, 10) : 0;
  const nur = q.nur ? q.nur.split(',').map(x => x.trim()).filter(Boolean) : null;

  try {
    // 1. Bibliothek laden und auf sichtbare Kategorien eingrenzen
    const attrRecs = await ladeAlle(ATTR_TABLE, Object.values(ATTR_F));
    const werte: AttrWert[] = attrRecs.map(r => ({
      id: r.id,
      kategorie: selName(r.fields[ATTR_F.kategorie]),
      name: typeof r.fields[ATTR_F.name] === 'string' ? r.fields[ATTR_F.name] : '',
      beschreibung: typeof r.fields[ATTR_F.beschreibung] === 'string' ? r.fields[ATTR_F.beschreibung] : '',
    })).filter(w => w.kategorie && w.name);

    const katMap = new Map<string, AttrWert[]>();
    for (const w of werte) {
      if (!SICHTBAR.includes(w.kategorie.charAt(0))) continue;
      if (nur && !nur.some(n => w.kategorie.startsWith(n))) continue;
      const l = katMap.get(w.kategorie) || [];
      l.push(w); katMap.set(w.kategorie, l);
    }
    const nameZuId = new Map<string, string>();
    werte.forEach(w => nameZuId.set(`${w.kategorie}::${w.name}`, w.id));

    // 2. Systeme laden
    let systeme = await ladeAlle(SYSTEM_TABLE, [SYS_F.bild, SYS_F.bildAlt, SYS_F.attribute, SYS_F.name], '{Published}=TRUE()');
    if (limit > 0) systeme = systeme.slice(0, limit);

    // 3. Nacheinander taggen — parallel wuerde das Anthropic-Limit reissen
    const bericht: any[] = [];
    const updates: any[] = [];
    for (const rec of systeme) {
      const name = rec.fields[SYS_F.name] || rec.id;
      const url = bildUrlVon(rec.fields);
      if (!url) { bericht.push({ name, status: 'kein Bild' }); continue; }
      const bild = await alsBase64(url);
      if (!bild) { bericht.push({ name, status: 'Bild nicht ladbar' }); continue; }
      const tags = await tagge(bild, katMap);
      if (tags.size === 0) { bericht.push({ name, status: 'nichts erkannt' }); continue; }

      const neueIds = Array.from(tags.entries())
        .map(([kat, wert]) => nameZuId.get(`${kat}::${wert}`))
        .filter((x): x is string => !!x);

      // Nur die angefassten Kategorien ersetzen. Alles, was ausserhalb der
      // gewaehlten Kategorien getaggt ist, bleibt unberuehrt stehen.
      const bisher: string[] = Array.isArray(rec.fields[SYS_F.attribute]) ? rec.fields[SYS_F.attribute] : [];
      const angefasst = new Set(Array.from(katMap.keys()));
      const behalten = bisher.filter(id => {
        const w = werte.find(x => x.id === id);
        return !w || !angefasst.has(w.kategorie);
      });
      const final = Array.from(new Set([...behalten, ...neueIds]));

      bericht.push({
        name,
        erkannt: Object.fromEntries(tags),
        vorher: bisher.length,
        nachher: final.length,
      });
      updates.push({ id: rec.id, fields: { [SYS_F.attribute]: final } });
    }

    // 4. Schreiben (nur ohne dry), in Bloecken zu 10
    let geschrieben = 0;
    if (!dry) {
      for (let i = 0; i < updates.length; i += 10) {
        const teil = updates.slice(i, i + 10);
        const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${SYSTEM_TABLE}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` },
          body: JSON.stringify({ records: teil }),
        });
        if (r.ok) geschrieben += teil.length;
      }
    }

    return res.status(200).json({
      modus: dry ? 'Vorschau — nichts geschrieben' : 'geschrieben',
      kategorien: Array.from(katMap.keys()),
      systeme: systeme.length,
      geschrieben,
      bericht,
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
