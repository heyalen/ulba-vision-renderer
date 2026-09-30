import type { VercelRequest, VercelResponse } from '@vercel/node';
import sharp from 'sharp';

/**
 * api/silhouette.ts — Form vergleichen, ohne Farbe zu sehen.
 *
 * Warum: Ein Sprachmodell muss sich zwischen "Cylindrical" und "Spherical"
 * entscheiden, wo in Wahrheit ein Uebergang liegt — es traf mal richtig, mal
 * nicht, und jede Gewichtsschraube danach loeste einen Fall und riss einen
 * anderen auf. Ein Bild-Embedding waere der naechste Reflex gewesen, kodiert
 * aber Farbe sehr stark: ein kupfern metallisierter Tiegel laege dann weit weg
 * von demselben Tiegel in Klarglas. Genau der Fehler, den wir gerade behoben
 * haben, nur unsichtbar.
 *
 * Deshalb: die SILHOUETTE vergleichen. BiRefNet stellt frei und liefert ein
 * PNG mit Alphakanal — dieser Kanal IST der Umriss. Darauf ist Farbe physisch
 * nicht mehr vorhanden, nicht bloss heruntergewichtet. Ein bauchiger Koerper
 * hat ein anderes Breitenprofil als ein Zylinder, egal ob kupfern oder klar.
 *
 * Arbeitsteilung danach:
 *   Silhouette  -> welche Form
 *   Attribute   -> welches Material, welche Oberflaeche, welcher Verschluss
 *   Hardfacts   -> was hart filtert (Typ, Volumen)
 *
 * Aufruf (Secret als Header x-ulba-dev oder ?key=):
 *   GET  ?systeme=1&skip=0&limit=5   Profile der Systeme berechnen und speichern
 *   GET  ?systeme=1&dry=1            nur zeigen, nichts schreiben
 *   POST { image_url }               ein Referenzbild gegen alle Systeme ranken
 */

const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const SYSTEM_TABLE = 'tblB1kWay9TvX3rGv';
const F = {
  name: 'fld6MYHRyYtfVatBe',
  bild: 'fldGcXPHX1jpg40r4',
  bildHarmonisiert: 'fldhqLDn8TYJ8VmG3',
};
// Long-Text-Feld, das Alen anlegt. Ueber den Namen angesprochen, weil die ID
// erst nach dem Anlegen existiert.
const SILHOUETTE_FELD = 'Silhouette';

// Aufloesung des Breitenprofils. 24 Baender treffen die Balance: fein genug,
// um Schulter, Bauch und Taille zu unterscheiden, grob genug, um gegen
// Freistellungs-Rauschen und leichte Perspektive unempfindlich zu bleiben.
const BAENDER = 24;

interface Profil {
  seitenverhaeltnis: number;  // Breite / Hoehe der Bounding Box
  fuellgrad: number;          // Flaeche / Bounding Box — rund vs. eckig
  schwerpunkt: number;        // 0 = Masse oben, 1 = Masse unten
  breiten: number[];          // BAENDER Werte, 0..1, relativ zur groessten Breite
}

async function falFreistellen(bildUrl: string): Promise<string | null> {
  const r = await fetch('https://fal.run/fal-ai/birefnet/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${process.env.FAL_API_KEY}` },
    body: JSON.stringify({ image_url: bildUrl, model: 'General Use (Light)', refine_foreground: true }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.image?.url || null;
}

/** Alphakanal -> Bounding Box -> normalisiertes Breitenprofil. */
async function profilVonPng(pngUrl: string): Promise<Profil | null> {
  const res = await fetch(pngUrl);
  if (!res.ok) return null;
  const roh = Buffer.from(await res.arrayBuffer());

  // Auf feste Arbeitsbreite bringen, damit die Rechnung unabhaengig von der
  // Aufloesung des Ausgangsbildes ist.
  const { data, info } = await sharp(roh)
    .ensureAlpha()
    .extractChannel('alpha')
    .resize(256, 256, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const B = info.width, H = info.height;

  // Klarglas ist der Normalfall, nicht der Randfall: BiRefNet gibt bei
  // transparentem Material eine halbdurchsichtige Maske zurueck — kraeftige
  // Kanten, schwache Flaeche dazwischen. Mit einer hohen Schwelle zaehlte nur
  // der Rand als Teil, und der Fuellgrad eines Glasflakons fiel auf 0,27.
  // Deshalb: niedrige Schwelle fuer die Raender, und pro Zeile zwischen
  // linkem und rechtem Rand auffuellen. Packmittel-Silhouetten sind konvex —
  // was zwischen den Kanten liegt, gehoert zum Teil, ob man hindurchsieht
  // oder nicht.
  const SCHWELLE = 16;
  const MIN_BREITE = Math.max(2, Math.round(B * 0.015)); // gegen Rauschpixel

  // Pro Zeile die Spanne bestimmen
  const spannen: Array<[number, number] | null> = [];
  for (let y = 0; y < H; y++) {
    let links = -1, rechts = -1;
    for (let x = 0; x < B; x++) {
      if (data[y * B + x] > SCHWELLE) { if (links < 0) links = x; rechts = x; }
    }
    spannen.push(links >= 0 && rechts - links + 1 >= MIN_BREITE ? [links, rechts] : null);
  }

  let minX = B, maxX = -1, minY = H, maxY = -1, flaeche = 0, summeY = 0;
  for (let y = 0; y < H; y++) {
    const sp = spannen[y];
    if (!sp) continue;
    const [links, rechts] = sp;
    if (links < minX) minX = links;
    if (rechts > maxX) maxX = rechts;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const w = rechts - links + 1;
    flaeche += w;
    summeY += w * y;
  }
  if (maxX < 0 || flaeche < 50) return null; // nichts erkannt

  const bw = maxX - minX + 1, bh = maxY - minY + 1;

  // Breitenprofil ueber die Hoehe — das Herzstueck. Eine bauchige Flasche
  // waechst zur Mitte hin, ein Zylinder bleibt flach, ein Tiegel ist kurz
  // und durchgehend breit, eine Schulterflasche springt oben zurueck.
  const breiten: number[] = [];
  let maxBreite = 1;
  for (let i = 0; i < BAENDER; i++) {
    const y0 = minY + Math.floor((i * bh) / BAENDER);
    const y1 = minY + Math.max(y0 - minY + 1, Math.floor(((i + 1) * bh) / BAENDER));
    let breiteste = 0;
    for (let y = y0; y < Math.min(y1, minY + bh); y++) {
      const sp = spannen[y];
      if (sp) breiteste = Math.max(breiteste, sp[1] - sp[0] + 1);
    }
    breiten.push(breiteste);
    if (breiteste > maxBreite) maxBreite = breiteste;
  }

  return {
    seitenverhaeltnis: bw / bh,
    fuellgrad: flaeche / (bw * bh),
    schwerpunkt: (summeY / flaeche - minY) / bh,
    breiten: breiten.map(b => b / maxBreite),
  };
}

/**
 * Aehnlichkeit zweier Silhouetten, 0..100.
 * Das Breitenprofil traegt das meiste — es beschreibt die Formsprache
 * (Schulter, Bauch, Taille, Verjuengung). Seitenverhaeltnis und Fuellgrad
 * trennen zusaetzlich gedrungen von schlank und rund von eckig.
 */
function aehnlichkeit(a: Profil, b: Profil): number {
  let abstand = 0;
  for (let i = 0; i < BAENDER; i++) abstand += Math.abs(a.breiten[i] - b.breiten[i]);
  const profilNaehe = Math.max(0, 1 - abstand / BAENDER / 0.45);

  const sv = Math.abs(Math.log(Math.max(0.05, a.seitenverhaeltnis) / Math.max(0.05, b.seitenverhaeltnis)));
  const svNaehe = Math.max(0, 1 - sv / 0.9);

  const fg = Math.abs(a.fuellgrad - b.fuellgrad);
  const fgNaehe = Math.max(0, 1 - fg / 0.35);

  const sp = Math.abs(a.schwerpunkt - b.schwerpunkt);
  const spNaehe = Math.max(0, 1 - sp / 0.25);

  return Math.round(100 * (profilNaehe * 0.55 + svNaehe * 0.25 + fgNaehe * 0.12 + spNaehe * 0.08));
}

async function airtableAlle(): Promise<any[]> {
  const raus: any[] = [];
  let offset: string | null = null;
  do {
    const p = new URLSearchParams({ pageSize: '100', filterByFormula: '{Published}=TRUE()' });
    if (offset) p.set('offset', offset);
    const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${SYSTEM_TABLE}?${p}`,
      { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } });
    if (!r.ok) throw new Error(`Airtable ${r.status}`);
    const j = await r.json();
    raus.push(...(j.records || []));
    offset = j.offset || null;
  } while (offset);
  return raus;
}

// Airtable liefert Felder unter ihren NAMEN, nicht unter IDs — deshalb hier
// dieselben Namen wie in search.ts, nicht die Feld-IDs von oben.
function nameVon(rec: any): string {
  const f = rec.fields || {};
  return f['Page Titel'] || f['System ID'] || f[F.name] || rec.id;
}

function bildUrlVon(f: any): string | null {
  for (const k of ['Bild_Harmonisiert', F.bildHarmonisiert, F.bild]) {
    const a = f[k];
    if (Array.isArray(a) && a[0]?.url) return a[0].url as string;
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const geheim = (req.headers['x-ulba-dev'] as string) || (req.query.key as string) || '';
  if (!process.env.ULBA_DEV_SECRET || geheim !== process.env.ULBA_DEV_SECRET) {
    return res.status(403).json({ error: 'Nur mit Dev-Secret' });
  }
  if (!process.env.FAL_API_KEY || !process.env.AIRTABLE_PAT) {
    return res.status(500).json({ error: 'FAL_API_KEY oder AIRTABLE_PAT fehlt' });
  }

  const q = req.query as Record<string, string>;

  try {
    // ── Modus 1: Profile der Systeme berechnen ────────────────────────
    if (q.systeme === '1') {
      const dry = q.dry === '1';
      const skip = q.skip ? parseInt(q.skip, 10) : 0;
      const limit = q.limit ? parseInt(q.limit, 10) : 5;
      const alle = await airtableAlle();
      const teil = alle.slice(skip, skip + limit);

      const bericht: any[] = [];
      const updates: any[] = [];
      for (const rec of teil) {
        const name = nameVon(rec);
        const url = bildUrlVon(rec.fields);
        if (!url) { bericht.push({ name, status: 'kein Bild' }); continue; }
        const frei = await falFreistellen(url);
        if (!frei) { bericht.push({ name, status: 'Freistellen fehlgeschlagen' }); continue; }
        const p = await profilVonPng(frei);
        if (!p) { bericht.push({ name, status: 'keine Silhouette erkannt' }); continue; }
        bericht.push({
          name,
          seitenverhaeltnis: +p.seitenverhaeltnis.toFixed(2),
          fuellgrad: +p.fuellgrad.toFixed(2),
          schwerpunkt: +p.schwerpunkt.toFixed(2),
          profil: p.breiten.map(b => +b.toFixed(2)),
        });
        updates.push({ id: rec.id, fields: { [SILHOUETTE_FELD]: JSON.stringify(p) } });
      }

      let geschrieben = 0;
      if (!dry) {
        for (let i = 0; i < updates.length; i += 10) {
          const bl = updates.slice(i, i + 10);
          const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${SYSTEM_TABLE}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` },
            body: JSON.stringify({ records: bl }),
          });
          if (r.ok) geschrieben += bl.length;
          else return res.status(500).json({ error: `Schreiben fehlgeschlagen: ${(await r.text()).slice(0, 200)}`, bericht });
        }
      }

      const naechster = skip + teil.length;
      return res.status(200).json({
        modus: dry ? 'Vorschau — nichts geschrieben' : 'geschrieben',
        fortschritt: `${naechster} von ${alle.length}`,
        weiter: naechster < alle.length ? `&skip=${naechster}` : 'fertig',
        geschrieben,
        bericht,
      });
    }

    // ── Modus 2: ein Referenzbild gegen alle Systeme ranken ───────────
    const bildUrl = (req.body as any)?.image_url || q.image_url;
    if (!bildUrl) return res.status(400).json({ error: 'image_url fehlt (oder ?systeme=1 nutzen)' });

    const frei = await falFreistellen(bildUrl);
    if (!frei) return res.status(422).json({ error: 'Freistellen fehlgeschlagen' });
    const ref = await profilVonPng(frei);
    if (!ref) return res.status(422).json({ error: 'Keine Silhouette erkannt' });

    const alle = await airtableAlle();
    const treffer: any[] = [];
    for (const rec of alle) {
      const roh = rec.fields[SILHOUETTE_FELD];
      if (typeof roh !== 'string' || !roh) continue;
      let p: Profil;
      try { p = JSON.parse(roh); } catch { continue; }
      treffer.push({
        name: nameVon(rec),
        id: rec.id,
        aehnlichkeit: aehnlichkeit(ref, p),
      });
    }
    treffer.sort((a, b) => b.aehnlichkeit - a.aehnlichkeit);

    return res.status(200).json({
      freigestellt: frei,
      referenz: {
        seitenverhaeltnis: +ref.seitenverhaeltnis.toFixed(2),
        fuellgrad: +ref.fuellgrad.toFixed(2),
        schwerpunkt: +ref.schwerpunkt.toFixed(2),
        profil: ref.breiten.map(b => +b.toFixed(2)),
      },
      verglichen: treffer.length,
      ranking: treffer,
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
