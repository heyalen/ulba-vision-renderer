/* ══════════════════════════════════════════════════════════════════════
   ulba · api/sync.ts — Katalog-Diff pro Lieferant
   Die Ingest-Engine schickt nach jedem Crawl die KOMPLETTE Teile-Liste
   eines Lieferanten. sync.ts vergleicht gegen Airtable (System-Tabelle):
     bekannt + gleicher Hash  → Zuletzt_Gesehen = heute, Status aktiv
     bekannt + anderer Hash   → Status "geändert", neuer Hash
     fehlt in der Liste       → Status "nicht mehr im Katalog" (NIE löschen)
     neu in der Liste         → zurückgegeben unter `neu` → Engine legt an
   POST, Header x-ulba-dev: <ULBA_DEV_SECRET>
   Body: { lieferant: "LUMSON", items: [{ artikelnummer, url?, hash? }] }
   ══════════════════════════════════════════════════════════════════════ */
import { VercelRequest, VercelResponse } from '@vercel/node';

const BASE = 'app0QFyInfhvk66MC';
const SYSTEM = 'tblB1kWay9TvX3rGv';
const F = {
  schluessel: 'fldUULlV93v1iacfx', // Katalog_Schluessel
  gesehen: 'fldlehKi9nPHVAKIO',    // Zuletzt_Gesehen
  status: 'fldVtDEyUSRo9lsuH',     // Sync_Status
  hash: 'fld0CpY5W9fWVDSn4',       // Katalog_Hash
};

export function schluessel(lieferant: string, item: { artikelnummer?: string; url?: string }): string {
  const id = String(item.artikelnummer || item.url || '').trim().toUpperCase();
  return `${lieferant.trim().toUpperCase()}|${id}`;
}

const at = (path: string, init?: RequestInit) =>
  fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}`, ...(init?.headers || {}) },
  });

async function bestand(prefix: string) {
  const out: { id: string; key: string; hash: string; status: string }[] = [];
  let offset = '';
  do {
    const p = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true',
      filterByFormula: `LEFT({${F.schluessel}}, ${prefix.length}) = "${prefix.replace(/"/g, '')}"` });
    [F.schluessel, F.hash, F.status].forEach(f => p.append('fields[]', f));
    if (offset) p.set('offset', offset);
    const r = await at(`${SYSTEM}?${p}`);
    if (!r.ok) throw new Error(`Airtable ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    for (const rec of j.records || []) {
      const s = rec.fields[F.status];
      out.push({ id: rec.id, key: String(rec.fields[F.schluessel] || ''), hash: String(rec.fields[F.hash] || ''),
        status: typeof s === 'string' ? s : s?.name || '' });
    }
    offset = j.offset || '';
  } while (offset);
  return out;
}

/* Airtable: max 10 Records pro PATCH, max 5 Requests/s → kleine Pause. */
async function patchAlle(updates: { id: string; fields: Record<string, any> }[]) {
  for (let i = 0; i < updates.length; i += 10) {
    const r = await at(SYSTEM, { method: 'PATCH', body: JSON.stringify({ records: updates.slice(i, i + 10), typecast: true }) });
    if (!r.ok) throw new Error(`PATCH ${r.status}: ${(await r.text()).slice(0, 160)}`);
    await new Promise(z => setTimeout(z, 220));
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'nur POST' });
  if (!process.env.ULBA_DEV_SECRET || req.headers['x-ulba-dev'] !== process.env.ULBA_DEV_SECRET)
    return res.status(401).json({ error: 'nicht autorisiert' });
  if (!process.env.AIRTABLE_PAT) return res.status(500).json({ error: 'AIRTABLE_PAT fehlt' });

  const { lieferant, items, trocken } = (req.body || {}) as
    { lieferant?: string; items?: { artikelnummer?: string; url?: string; hash?: string }[]; trocken?: boolean };
  if (!lieferant || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'lieferant und items[] nötig' });

  try {
    const heute = new Date().toISOString().slice(0, 10);
    const crawl = new Map<string, { hash: string; item: any }>();
    for (const it of items) {
      const k = schluessel(lieferant, it);
      if (!k.endsWith('|')) crawl.set(k, { hash: String(it.hash || ''), item: it });
    }
    const alt = await bestand(`${lieferant.trim().toUpperCase()}|`);
    const altKeys = new Set(alt.map(a => a.key));

    const updates: { id: string; fields: Record<string, any> }[] = [];
    const geaendert: string[] = [], verschwunden: string[] = [], zurueck: string[] = [];
    for (const a of alt) {
      const c = crawl.get(a.key);
      if (!c) {
        if (a.status !== 'nicht mehr im Katalog') {
          verschwunden.push(a.key);
          updates.push({ id: a.id, fields: { [F.status]: 'nicht mehr im Katalog' } });
        }
        continue;
      }
      const f: Record<string, any> = { [F.gesehen]: heute };
      if (c.hash && a.hash && c.hash !== a.hash) { f[F.status] = 'geändert'; geaendert.push(a.key); }
      else if (a.status === 'nicht mehr im Katalog') { f[F.status] = 'aktiv'; zurueck.push(a.key); }
      if (c.hash) f[F.hash] = c.hash;
      updates.push({ id: a.id, fields: f });
    }
    const neu = Array.from(crawl.entries()).filter(([k]) => !altKeys.has(k))
      .map(([k, v]) => ({ schluessel: k, ...v.item }));

    if (!trocken) await patchAlle(updates);

    return res.status(200).json({
      lieferant, trocken: !!trocken,
      zusammenfassung: { im_crawl: crawl.size, bekannt: alt.length, neu: neu.length,
        geaendert: geaendert.length, verschwunden: verschwunden.length, wieder_da: zurueck.length },
      neu, geaendert, verschwunden, wieder_da: zurueck,
      hinweis: 'Neue Teile mit Katalog_Schluessel, Zuletzt_Gesehen=heute, Sync_Status=neu anlegen.',
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
