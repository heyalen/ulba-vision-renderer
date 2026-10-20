import { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { montiereKomposit, MontageKal } from './render';

/* ── api/kalibrierung.ts — Hand-Kalibrierung der Montage (v62) ───────────
   POST { capId, cacheId, skala, versatzY } vom "Anpassen"-Regler:
   1) schreibt Montage_Skala / Montage_Versatz_Y an den Cap-Record
      (gilt ab jetzt deterministisch fuer ALLE Renders dieses Caps);
   2) re-montiert den aktuellen Cache-Record aus den gespeicherten
      Body_Bild + Cap_Bild Attachments OHNE fal-Call und ersetzt das
      Bild-Attachment — Alen sieht das Ergebnis sofort;
   3) v75: re-montiert in waitUntil ALLE weiteren Done-Records derselben
      System+Cap-Kombi (Match ueber die capId im Cache_Key, dort steht sie
      seit jeher als "_<capId>_"-Segment) — max 15 pro Lauf, Rest im Log.
   v75: cacheId ist OPTIONAL — ohne cacheId (Vorschau vor dem ersten
   Render) werden nur die Cap-Felder geschrieben, kein Re-Komposit.
   Origin-/Takt-Regeln identisch zu search/renders. */

const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const CACHE_TABLE = 'tblsOp1WKPGIquBKQ';
const CAP_TABLE = 'tblQvnXPhiKGMoqDp';
const CACHE_IMAGE_FIELD = 'fldFd5qi64yELhKna'; // Bild

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

// ── Zugangs-Riegel (identisch zu render/search/renders) ───────────────
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
  return true;
}

const HDR = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` });
function anhang(feld: unknown): string | null {
  if (!Array.isArray(feld) || !feld.length) return null;
  const a = feld[0] as { url?: string };
  return a?.url || null;
}
const REC = /^rec[A-Za-z0-9]{14}$/;

/* v75 — EIN Done-Record aus Body_Bild+Cap_Bild re-montieren und das
   Bild-Attachment ersetzen. Gemeinsamer Kern fuer den direkten Record und
   die Geschwister-Records derselben System+Cap-Kombi. */
async function reMontiereRecord(
  recId: string, kal: MontageKal, closureText: string
): Promise<{ ok: boolean; neueUrl?: string | null; capScale?: number | null; versatzIgnoriert?: boolean; grund?: string }> {
  const cacheRes = await fetchT(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}/${recId}`, { headers: HDR(), label: 'cache read' });
  if (!cacheRes.ok) return { ok: false, grund: `Cache-Read: ${cacheRes.status}` };
  const cf = ((await cacheRes.json()) as any)?.fields || {};
  // v73: Bild als Body-Fallback NUR, wenn es kein Komposit ist — sonst
  // wuerde der Cap auf ein fertiges Bild montiert (JAPA-Befund 1792x2496).
  let bildIstKomposit = false;
  try { bildIstKomposit = (cf['Board'] ? JSON.parse(cf['Board']) : {})?.montiert === true; } catch { bildIstKomposit = false; }
  const bodyUrl = anhang(cf['Body_Bild']) || (!bildIstKomposit ? anhang(cf['Bild']) : null);
  const capUrl = anhang(cf['Cap_Bild']);
  if (!bodyUrl || !capUrl) {
    return { ok: false, grund: 'Diesem Render fehlen gespeicherte Einzelbilder (Body_Bild/Cap_Bild) — bitte frisch rendern, dann anpassen.' };
  }
  const [bodyBuf, capBuf] = await Promise.all([
    fetchT(bodyUrl, { timeoutMs: 30000, label: 'body download' }).then(async r => Buffer.from(await r.arrayBuffer())),
    fetchT(capUrl, { timeoutMs: 30000, label: 'cap download' }).then(async r => Buffer.from(await r.arrayBuffer())),
  ]);
  const mont = await montiereKomposit(bodyBuf, capBuf, closureText, kal);
  if (!mont) return { ok: false, grund: 'Montage mit diesen Werten nicht moeglich — Werte wurden trotzdem gespeichert.' };

  // Bild-Attachment ERSETZEN (erst leeren, dann hochladen) + Flags.
  await fetchT(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}/${recId}`, {
    method: 'PATCH', headers: HDR(), label: 'bild leeren',
    body: JSON.stringify({ fields: { Bild: [] } }),
  });
  const up = await fetchT(
    `https://content.airtable.com/v0/${AIRTABLE_BASE}/${recId}/${CACHE_IMAGE_FIELD}/uploadAttachment`,
    {
      method: 'POST', headers: HDR(), label: 'komposit upload', timeoutMs: 45000,
      body: JSON.stringify({ contentType: 'image/jpeg', file: mont.jpeg.toString('base64'), filename: `komposit_kalibriert_${Date.now()}.jpg` }),
    }
  );
  if (!up.ok) return { ok: false, grund: `Komposit-Upload: ${up.status} ${(await up.text()).slice(0, 300)}` };
  let board = {} as any;
  try { board = cf['Board'] ? JSON.parse(cf['Board']) : {}; } catch { board = {}; }
  await fetchT(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}/${recId}`, {
    method: 'PATCH', headers: HDR(), label: 'cache flags',
    body: JSON.stringify({ fields: { Cap_Scale: mont.capScale, Montage_Konfidenz: mont.diag.versatzIgnoriert ? 'pruefen' : 'auto_ok', Board: JSON.stringify({ ...board, montiert: true }) } }), // v73
  }).catch(() => null);
  // Frische Attachment-URL fuer die sofortige Anzeige holen.
  const nach = await fetchT(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}/${recId}`, { headers: HDR(), label: 'cache re-read' });
  const neueUrl = nach.ok ? anhang((((await nach.json()) as any)?.fields || {})['Bild']) : null;
  return { ok: true, neueUrl, capScale: mont.capScale, versatzIgnoriert: !!mont.diag.versatzIgnoriert };
}

/* v75 — alle weiteren Done-Records derselben System+Cap-Kombi nachziehen.
   Match: Cache_Key enthaelt "_<capId>_" (Format seit v45:
   version_systemId_hash_capId_tier...). Laeuft in waitUntil, max 15 pro
   Lauf — der Rest landet im Log und zieht beim naechsten Speichern nach. */
async function reMontiereGeschwister(capId: string, ausser: string, kal: MontageKal, closureText: string): Promise<void> {
  try {
    const formel = encodeURIComponent(`AND({Status}='Done', FIND('_${capId}_', {Cache_Key}))`);
    const liste = await fetchT(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}?filterByFormula=${formel}&maxRecords=40&fields%5B%5D=Cache_Key`,
      { headers: HDR(), label: 'geschwister liste' }
    );
    if (!liste.ok) { console.error('geschwister liste:', liste.status); return; }
    const ids = ((((await liste.json()) as any)?.records || []) as { id: string }[])
      .map(r => r.id).filter(id => id !== ausser);
    const jetzt = ids.slice(0, 15);
    if (ids.length > 15) console.log(`kalibrierung v75: ${ids.length - 15} weitere Kombi-Records warten auf den naechsten Lauf`);
    for (const id of jetzt) {
      const e = await reMontiereRecord(id, kal, closureText).catch(err => ({ ok: false, grund: String(err) } as const));
      if (!e.ok) console.error(`kalibrierung v75: Geschwister ${id} nicht re-montiert — ${('grund' in e && e.grund) || '?'}`);
    }
    if (jetzt.length) console.log(`kalibrierung v75: ${jetzt.length} Kombi-Records re-montiert (Cap ${capId})`);
  } catch (err) {
    console.error('kalibrierung v75 geschwister:', err instanceof Error ? err.message : err);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const offen = riegel(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!offen) return res.status(403).json({ error: 'Zugriff nur von ulba' });
  if (!taktOk(req, 20, 300000)) return res.status(429).json({ error: 'Zu viele Anfragen — kurz warten.' });

  const { capId, cacheId, skala: skalaRoh, versatzY: versatzRoh } = (req.body || {}) as {
    capId?: string; cacheId?: string; skala?: number; versatzY?: number;
  };
  // v63: Hand-Werte gewinnen roh — weite Grenzen (5%..200% Breite, 0..90%
  // Hoehe), nie auf die Auto-Grenzen geclampt.
  const skala = typeof skalaRoh === 'number' && isFinite(skalaRoh) ? Math.min(2, Math.max(0.05, skalaRoh)) : null;
  const versatzY = typeof versatzRoh === 'number' && isFinite(versatzRoh) ? Math.min(90, Math.max(0, versatzRoh)) : null;
  // v75: cacheId optional — Vorschau-Kalibrierung vor dem ersten Render
  // schreibt nur die Cap-Felder (gelten dann fuer jeden kuenftigen Render).
  if (!capId || !REC.test(capId) || skala == null || (cacheId != null && !REC.test(cacheId))) {
    return res.status(400).json({ error: 'capId und skala sind erforderlich (cacheId optional)' });
  }

  try {
    // 1) Kalibrierung am Cap speichern (gilt fuer alle kuenftigen Renders).
    const capRes = await fetchT(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${CAP_TABLE}/${capId}`, {
      method: 'PATCH', headers: HDR(), label: 'cap patch',
      body: JSON.stringify({ fields: { Montage_Skala: skala, ...(versatzY != null ? { Montage_Versatz_Y: versatzY } : {}) } }),
    });
    if (!capRes.ok) throw new Error(`Cap-Update: ${capRes.status} ${(await capRes.text()).slice(0, 300)}`);
    const capFields = ((await capRes.json()) as any)?.fields || {};
    const closureText = [
      typeof capFields['Closure_Type'] === 'string' ? capFields['Closure_Type'] : (capFields['Closure_Type']?.name || ''),
      String(capFields['Cap_Name'] || ''),
    ].join(' ');
    const kal: MontageKal = {
      skala,
      versatzY,
      crop: (() => {
        try {
          const c = capFields['Montage_Crop'] ? JSON.parse(String(capFields['Montage_Crop'])) : null;
          return (c && typeof c.w === 'number' && typeof c.h === 'number') ? { x: Number(c.x) || 0, y: Number(c.y) || 0, w: c.w, h: c.h } : null;
        } catch { return null; }
      })(),
    };

    // v75: Vorschau-Modus ohne cacheId — nur Felder, kein Re-Komposit.
    if (!cacheId) {
      return res.status(200).json({ ok: true, bildUrl: null, capScale: null, versatzUebernommen: true });
    }

    // 2) Aktuellen Cache-Record re-montieren (ohne fal).
    const erg = await reMontiereRecord(cacheId, kal, closureText);
    if (!erg.ok) return res.status(422).json({ error: erg.grund || 'Montage mit diesen Werten nicht moeglich — Werte wurden trotzdem gespeichert.' });

    // 3) v75: ALLE weiteren Done-Records derselben Kombi nachziehen — die
    // capId steht als "_<capId>_"-Segment im Cache_Key jedes Records.
    waitUntil(reMontiereGeschwister(capId, cacheId, kal, closureText));

    return res.status(200).json({
      ok: true,
      bildUrl: erg.neueUrl || `/api/bild?r=${cacheId}&v=${Date.now()}`,
      capScale: erg.capScale,
      // v74: ehrliches UI-Feedback — wurde Alens Position uebernommen?
      versatzUebernommen: !erg.versatzIgnoriert,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
    console.error('kalibrierung error:', message);
    return res.status(500).json({ error: message });
  }
}
