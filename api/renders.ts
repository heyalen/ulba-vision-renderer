import { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';

/* ── api/renders.ts — das Render-Archiv (v49/C2) ─────────────────────────
   GET, optional ?systemId=rec… → Liste der fertigen Renders (Status Done,
   neueste zuerst, max 60) aus Rendering_Cache. Die Galerie im Frontend ist
   die reload-feste Wahrheit; die fal-URLs der Lauf-Bloecke verfallen nach
   ~1h, deshalb zeigen die bildUrl-Felder hier auf die stabile Frontend-
   Route /api/bild?r=<recordId> (relativ — die Galerie laeuft same-origin
   auf ulba.vercel.app und /api/bild loest den Airtable-Anhang frisch auf).
   CORS/Origin-Regeln identisch zu search/render. */

const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const CACHE_TABLE = 'tblsOp1WKPGIquBKQ';

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

// ── Zugangs-Riegel (identisch zu render/search) ───────────────────────
const ULBA_ORIGINS = new Set<string>([
  'https://ulba.vercel.app',
  'http://localhost:3000',
  ...String(process.env.ULBA_ORIGINS || '').split(',').map(o => o.trim()).filter(o => /^https?:\/\//.test(o)),
]);

function riegel(req: VercelRequest, res: VercelResponse): boolean {
  const origin = String(req.headers.origin || '');
  const erlaubt = origin ? ULBA_ORIGINS.has(origin) : false;
  if (origin && erlaubt) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  return erlaubt;
}

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

function hatAnhang(feld: unknown): boolean {
  return Array.isArray(feld) && feld.length > 0 && !!(feld[0] as any)?.url;
}

type RenderEintrag = {
  id: string;
  bildUrl: string;
  capBildUrl: string | null;
  weltName: string;
  teilName: string;
  systemId: string | null;
  codeId: string | null;
  konzeptName: string;
  story: string;
  warnungen: string[];
  // v51: deutsche Umsetzungs-Schritte des Bauplans (Board-JSON) — fuers Overlay.
  umsetzung: string[];
  // v56: gemessene Cap-Element-Breite relativ zur Body-Element-Breite;
  // null bei alten Records -> Frontend-Fallback-Heuristik.
  capScale: number | null;
  // v59: true = Bild ist das fertige Komposit -> Buehne zeigt es contain.
  montiert: boolean;
  engine: string;
  erstellt: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const offen = riegel(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!offen) return res.status(403).json({ error: 'Zugriff nur von ulba' });
  if (!taktOk(req, 60, 300000)) return res.status(429).json({ error: 'Zu viele Anfragen — kurz warten.' });

  const systemId = typeof req.query.systemId === 'string' && /^rec[A-Za-z0-9]{14}$/.test(req.query.systemId)
    ? req.query.systemId : null;

  // v58: Altlasten (Pending > 10 Min, z.B. frueh geschlossener Tab vor der
  // waitUntil-Aera) best-effort als Error markieren — die Galerie soll nie
  // auf ewig-Pendings warten. Laeuft via waitUntil neben der Antwort.
  waitUntil((async () => {
    try {
      const p = new URLSearchParams({
        filterByFormula: `AND({Status}='Pending', DATETIME_DIFF(NOW(), {Created_At}, 'minutes') > 10)`,
        pageSize: '10',
      });
      p.append('fields[]', 'Status');
      const r = await fetchT(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}?${p}`, {
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` }, label: 'stale scan',
      });
      if (!r.ok) return;
      const d = await r.json() as { records?: Array<{ id: string }> };
      for (const rec of d.records || []) {
        await fetchT(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}/${rec.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` },
          body: JSON.stringify({ fields: { Status: 'Error', Render_Log: 'Stale: Pending > 10 Min — automatisch bereinigt (v58)' } }),
          label: 'stale patch',
        }).catch(() => null);
      }
    } catch { /* Kuer — die Liste kommt trotzdem */ }
  })());

  try {
    // Nur fertige Laeufe, neueste zuerst. Das System-Link-Feld laesst sich
    // per Formel nicht nach Record-ID filtern (ARRAYJOIN liefert Namen) —
    // deshalb wird serverseitig in JS nachgefiltert.
    const params = new URLSearchParams({
      filterByFormula: `{Status}='Done'`,
      pageSize: '100',
      'sort[0][field]': 'Created_At',
      'sort[0][direction]': 'desc',
    });
    ['Bild', 'Cap_Bild', 'Konzept_Name', 'Konzept_Story', 'Teil_Name', 'System', 'Design_Code', 'Engine', 'Created_At', 'Board', 'Cap_Scale']
      .forEach(f => params.append('fields[]', f));
    const r = await fetchT(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}?${params}`,
      { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}` }, label: 'airtable renders' }
    );
    if (!r.ok) throw new Error(`Airtable: ${r.status}`);
    const data = await r.json() as { records?: any[] };
    const records = data.records || [];

    const renders: RenderEintrag[] = records
      .filter(rec => hatAnhang(rec.fields?.['Bild']))
      .map(rec => {
        const f = rec.fields || {};
        const sysLink: string[] = Array.isArray(f['System']) ? f['System'] : [];
        const codeLink: string[] = Array.isArray(f['Design_Code']) ? f['Design_Code'] : [];
        // Warnungen aus dem Board-JSON (farbsystem.warnungen) — nur die
        // Zeilen, nie das ganze Board (Payload klein halten).
        let warnungen: string[] = [];
        let umsetzung: string[] = [];
        let montiert = false;
        try {
          const board = f['Board'] ? JSON.parse(f['Board']) : null;
          if (Array.isArray(board?.farbsystem?.warnungen)) warnungen = board.farbsystem.warnungen.map(String).slice(0, 6);
          if (Array.isArray(board?.umsetzung)) umsetzung = board.umsetzung.map(String).slice(0, 8); // v51
          montiert = board?.montiert === true; // v58: Bild ist bereits Komposit
        } catch { warnungen = []; umsetzung = []; }
        return {
          id: rec.id,
          // Stabile Adresse: /api/bild (ulba-Frontend) loest den Anhang auf.
          bildUrl: `/api/bild?r=${rec.id}`,
          // v58: beim Komposit traegt Bild schon den Verschluss — kein Stapel.
          capBildUrl: (!montiert && hatAnhang(f['Cap_Bild'])) ? `/api/bild?r=${rec.id}&k=cap` : null,
          weltName: String(f['Konzept_Name'] || ''),
          teilName: String(f['Teil_Name'] || ''),
          systemId: sysLink[0] || null,
          codeId: codeLink[0] || null,
          konzeptName: String(f['Konzept_Name'] || ''),
          story: String(f['Konzept_Story'] || ''),
          warnungen,
          umsetzung,
          capScale: (typeof f['Cap_Scale'] === 'number' && isFinite(f['Cap_Scale'])) ? f['Cap_Scale'] : null, // v56
          montiert, // v59
          engine: typeof f['Engine'] === 'string' ? f['Engine'] : (f['Engine']?.name || 'seedream'),
          erstellt: String(f['Created_At'] || rec.createdTime || ''),
        };
      })
      .filter(e => !systemId || e.systemId === systemId)
      .slice(0, 60);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ renders });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
    console.error('renders error:', message);
    return res.status(500).json({ error: message, renders: [] });
  }
}
