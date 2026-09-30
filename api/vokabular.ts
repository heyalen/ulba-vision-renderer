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

// ── Zugangs-Riegel (v46) ──────────────────────────────────────────────
// Der Renderer stand offen: CORS '*', keine Auth, kein Limit. Jeder mit der
// URL konnte auf ulbas fal.ai-/Anthropic-Guthaben rendern lassen. Ab hier
// gilt: nur die eigene Oberflaeche darf rufen, und auch die nicht endlos.
const ULBA_ORIGINS = new Set<string>([
  'https://ulba.vercel.app',
  'http://localhost:3000',
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const offen = riegel(req, res, { originOptional: true });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!offen) return res.status(403).json({ error: 'Zugriff nur von ulba' });
  if (!taktOk(req, 60, 300000)) return res.status(429).json({ error: 'Zu viele Anfragen' });

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
