import { VercelRequest, VercelResponse } from '@vercel/node';

/* ══════════════════════════════════════════════════════════════════════
   /api/vokabular — liefert das emergente Wolken-Vokabular ans Frontend.

   Quelle: Tabelle 'Wolken_Vokabular' (von Skript 7 aus den
   Wirkung_Beschreibung-Texten der Design-Codes destilliert). Das Frontend
   mischt diese Wörter als Nachbarschaften unter die kuratierten Anker —
   wächst das Design_Code-Archiv, wächst die Wolke, ohne Frontend-Deploy.

   Nur Status='aktiv'. Antwort wird am Edge 1h gecacht (s-maxage) — das
   Vokabular ändert sich nur, wenn Skript 7 läuft; stale-while-revalidate
   hält die Wolke auch während der Revalidierung sofort da.
   ══════════════════════════════════════════════════════════════════════ */

const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const TABLE = 'Wolken_Vokabular';

interface VokabRecord {
  wort: string;
  anker: string;
  register: string | null;
  laut_delta: number | null;
  quellcodes: number;
}

function selectName(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.name) return String(v.name);
  return '';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Defensive CORS — Projekt-Ebene deckt es i. d. R. schon, doppelt hält besser.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const worte: VokabRecord[] = [];
    let offset: string | null = null;
    // Paginieren — das Vokabular kann über 100 Einträge wachsen.
    do {
      const params = new URLSearchParams({ pageSize: '100' });
      params.set('filterByFormula', "{Status}='aktiv'");
      ['Wort', 'Anker', 'Register', 'Laut_Delta', 'Quellcodes'].forEach(f => params.append('fields[]', f));
      if (offset) params.set('offset', offset);
      const r = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE)}?${params}`,
        { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } }
      );
      if (!r.ok) {
        // Tabelle existiert (noch) nicht o. ä. → leeres Vokabular statt Fehler:
        // die Wolke fällt dann sauber auf die kuratierten Anker zurück.
        if (r.status === 404 || r.status === 403) {
          res.setHeader('Cache-Control', 's-maxage=300');
          return res.status(200).json({ worte: [] });
        }
        throw new Error(`Airtable ${r.status}`);
      }
      const data: any = await r.json();
      for (const rec of data.records || []) {
        const f = rec.fields || {};
        const wort = String(f['Wort'] || '').trim();
        const anker = selectName(f['Anker']).trim();
        if (!wort || !anker) continue;
        worte.push({
          wort,
          anker,
          register: f['Register'] ? String(f['Register']).trim() : null,
          laut_delta: typeof f['Laut_Delta'] === 'number' ? f['Laut_Delta'] : null,
          quellcodes: typeof f['Quellcodes'] === 'number' ? f['Quellcodes'] : 0,
        });
      }
      offset = data.offset || null;
    } while (offset);

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ worte });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'vokabular failed' });
  }
}
