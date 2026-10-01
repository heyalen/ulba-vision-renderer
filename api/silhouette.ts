import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Profil, falFreistellen, profilVonPng, aehnlichkeit } from './_form';
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
  // v58-Sicherheit: Secret NUR als Header. ?key= stand in Browser-URLs,
  // Verlaeufen und Vercel-Logs — genau deshalb wird ULBA_DEV_SECRET rotiert.
  const geheim = (req.headers['x-ulba-dev'] as string) || '';
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
