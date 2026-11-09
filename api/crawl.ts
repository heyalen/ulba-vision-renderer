/* ══════════════════════════════════════════════════════════════════════
   ulba · api/crawl.ts — Crawler v1 (Endspurt #8/#9)
   Ablauf pro Quelle (Tabelle Quellen):
     1. ENTDECKEN  Firecrawl /map → alle URLs der Domain → Produkt-URL-Muster
                   (Quellen.URL_Muster oder Haiku schlägt Regex vor) → neue
                   URLs als Bulk_Source-Zeilen «zu crawlen» (Dubletten-Check
                   gegen Bulk_Source.Source_URL + System.Link).
     2. EXTRAHIEREN Firecrawl /scrape je Seite → Haiku zieht Name, Artikel-
                   nummer, Volumen, Material, Hauptbild → «zu prüfen»
                   (kein Produkt → «verworfen»). Läuft in Häppchen und ruft
                   sich selbst wieder auf, bis nichts mehr «zu crawlen» ist.
     GATE (#9):    Nichts geht weiter, bis Alen «zu prüfen» → «Pending» setzt
                   (dann übernimmt die bestehende Bulk_Source-Automation v6).
   Fingerabdrücke {pfad: hash} landen in Quellen.URL_Fingerprints → Basis
   für den Delta-Crawl (#14).
   POST, Header x-ulba-dev: <CRAWL_SECRET> (oder ULBA_DEV_SECRET)
   Body: { quelleId: "rec…", schritt?: "entdecken"|"extrahieren", max?: 400 }
   ══════════════════════════════════════════════════════════════════════ */
import { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { createHash } from 'crypto';

const BASE = 'app0QFyInfhvk66MC';
const T = { quellen: 'tblT3NLNufj18imll', bulk: 'tblrKu0BHOH5V7YsX', system: 'tblB1kWay9TvX3rGv', lieferant: 'tblsy3CHZbAo6GraB' };
const Q = { name: 'fldAT1OOMAeZzfTsM', lieferant: 'fldrxmJzWBvo8WG3E', url: 'fldyyvHOcYmzxGgeU', status: 'fldUDgKPvGgDYkzCX',
  typ: 'fldDtXdEor8CGZNM0', muster: 'fld5fYoRNqhSotV7i', letzter: 'flddg1aWUXyFp8ILf', fp: 'fldwXu6n56igNpOlf',
  gefunden: 'fldCQzwU4YnlYaFZN', neu: 'fldnTqWb65gzUjdrG', geaendert: 'fld6cAltBPQCo721r', log: 'fldb85ckiSIspmk1x' };
const B = { lieferant: 'fldFnMy19K5DbOGpT', name: 'fldAbxKw2I4bBjAe5', url: 'fldV5FqTcWj8EVgwI', roh: 'fldekjxtBQuOwSdZz',
  bild: 'fldGeadiTTVSYh1lq', status: 'fld9Ges6UCFGHSCH7', artnr: 'fldNS2qarbg4JLtD8' };
const L = { name: 'fldq27U7UQU6NZU7P', website: 'fldDfEAJQjKB3ei0G' };
const SYS_LINK = 'fldUQza6Xa9Eqksaw';
const HAPPEN = 9;           // Seiten pro Häppchen (Firecrawl-Hobby: 5 parallel)
const PARALLEL = 3;
const ZEIT_MS = 110_000;    // kein neues Häppchen mehr danach → Staffelübergabe (maxDuration 300)

const pause = (ms: number) => new Promise(z => setTimeout(z, ms));
const at = async (path: string, init?: RequestInit) => {
  for (let v = 0; v < 4; v++) {
    const r = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, { ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AIRTABLE_PAT}` } });
    if (r.status !== 429) return r;
    await pause(1500);
  }
  throw new Error('Airtable 429');
};
const atJson = async (path: string, init?: RequestInit) => {
  const r = await at(path, init);
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};
async function alle(table: string, fields: string[], formula?: string) {
  const out: any[] = []; let offset = '';
  do {
    const p = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' });
    fields.forEach(f => p.append('fields[]', f));
    if (formula) p.set('filterByFormula', formula);
    if (offset) p.set('offset', offset);
    const j = await atJson(`${table}?${p}`);
    out.push(...(j.records || [])); offset = j.offset || '';
  } while (offset);
  return out;
}
async function schreiben(table: string, method: 'POST' | 'PATCH', records: any[]) {
  const ids: string[] = [];
  for (let i = 0; i < records.length; i += 10) {
    const j = await atJson(table, { method, body: JSON.stringify({ records: records.slice(i, i + 10), typecast: true }) });
    ids.push(...(j.records || []).map((r: any) => r.id));
    await pause(220);
  }
  return ids;
}
const quelleSetzen = (id: string, fields: Record<string, any>) =>
  schreiben(T.quellen, 'PATCH', [{ id, fields }]);

const normUrl = (u: string) => { try { const x = new URL(u); x.hash = ''; return (x.origin + x.pathname).replace(/\/$/, '').toLowerCase() + x.search; } catch { return ''; } };
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const pfad = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10);

/* ── Firecrawl ─────────────────────────────────────────────────────── */
async function fc(endpoint: 'map' | 'scrape', body: any) {
  const r = await fetch(`https://api.firecrawl.dev/v1/${endpoint}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
    body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`Firecrawl ${endpoint} ${r.status}: ${String(j.error || '').slice(0, 160)}`);
  return j;
}

/* ── Haiku ─────────────────────────────────────────────────────────── */
async function haiku(system: string, user: string, max = 600): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': String(process.env.ANTHROPIC_API_KEY), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: max, temperature: 0, system, messages: [{ role: 'user', content: user }] }) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Haiku ${r.status}: ${String(j?.error?.message || '').slice(0, 160)}`);
  const t = String(j.content?.[0]?.text || '');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Haiku ohne JSON');
  return JSON.parse(m[0]);
}

/* ── Lieferant sicherstellen (v6 bricht ohne Lieferant ab) ──────────── */
async function lieferantName(q: any): Promise<string> {
  const link: string[] = q.fields[Q.lieferant] || [];
  if (link.length) {
    const l = await atJson(`${T.lieferant}/${link[0]}?returnFieldsByFieldId=true`);
    return String(l.fields[L.name] || '').trim();
  }
  const roh = String(q.fields[Q.name] || '').replace(/\(.*?\)/g, '').trim();
  const name = roh.replace(/\b(gmbh|spa|s\.p\.a\.|srl|s\.r\.l\.|sas|sarl|ltd\.?|co\.,?|b\.v\.|ag|kg|sp\. z o\.o\.)\b/gi, '').replace(/[,.&]+$/,'').replace(/\s+/g, ' ').trim().toUpperCase();
  const vorhanden = await alle(T.lieferant, [L.name], `UPPER({${L.name}}) = "${name.replace(/"/g, '')}"`);
  const id = vorhanden[0]?.id || (await schreiben(T.lieferant, 'POST', [{ fields: { [L.name]: name,
    [L.website]: (() => { try { return new URL(q.fields[Q.url]).origin; } catch { return undefined; } })() } }]))[0];
  await quelleSetzen(q.id, { [Q.lieferant]: [id] });
  return name;
}

/* ── 1. ENTDECKEN ──────────────────────────────────────────────────── */
async function entdecken(q: any, max: number) {
  const katalog = String(q.fields[Q.url] || '');
  if (!katalog) throw new Error('Katalog_URL fehlt');
  const lname = await lieferantName(q);
  const dom = host(katalog);
  const map = await fc('map', { url: new URL(katalog).origin, limit: 5000, includeSubdomains: false });
  const links: string[] = (map.links || []).map((l: any) => typeof l === 'string' ? l : l?.url).filter(Boolean);
  const kandidaten = [...new Set(links.filter(u => host(u) === dom)
    .filter(u => !/\.(pdf|jpe?g|png|webp|gif|svg|zip|docx?|xlsx?|mp4)(\?|$)/i.test(u))
    .filter(u => !/\/(blog|news|actualit|press|career|karriere|job|contact|kontakt|privacy|datenschutz|cookie|impressum|legal|imprint|login|cart|warenkorb|account|tag|author|feed|wp-json|wp-content|search)(\/|$|\?)/i.test(u))
    .map(normUrl).filter(Boolean))];
  if (!kandidaten.length) throw new Error(`Firecrawl fand keine URLs auf ${dom}`);

  let muster = String(q.fields[Q.muster] || '').trim();
  if (!muster) {
    const probe = kandidaten.slice(0, 300).map(pfad).join('\n');
    const o = await haiku(
      'Du erkennst in URL-Listen von Verpackungsherstellern die Detailseiten EINZELNER Produkte (eine Flasche, ein Tiegel, eine Pumpe …), nicht Kategorie-, Kollektions-, Filter- oder Infoseiten. Antworte nur mit JSON.',
      `Katalog-Einstieg: ${pfad(katalog)}\nPfade:\n${probe}\n\nGib ein JSON {"regex":"JavaScript-Regex (ohne Slashes), der NUR auf Produkt-Detailpfade passt","beispiel":["2-3 passende Pfade"]}. Wenn keine Produkt-Detailseiten erkennbar sind: {"regex":""}.`, 400);
    muster = String(o.regex || '');
  }
  let re: RegExp;
  try { re = new RegExp(muster, 'i'); } catch { throw new Error(`Ungültiges URL_Muster: ${muster}`); }
  const produkte = muster ? kandidaten.filter(u => re.test(pfad(u))) : [];
  if (!produkte.length) throw new Error(`Kein Produkt-URL-Muster gefunden (${kandidaten.length} URLs). URL_Muster von Hand setzen.`);

  // Dubletten-Check: schon in Bulk_Source oder System?
  const bekannt = new Set<string>();
  (await alle(T.bulk, [B.url], `{${B.url}} != ""`)).forEach(r => bekannt.add(normUrl(r.fields[B.url] || '')));
  (await alle(T.system, [SYS_LINK], `FIND("${dom}", {${SYS_LINK}})`)).forEach(r => bekannt.add(normUrl(r.fields[SYS_LINK] || '')));
  const neu = produkte.filter(u => !bekannt.has(u)).slice(0, max);
  await schreiben(T.bulk, 'POST', neu.map(u => ({ fields: { [B.url]: u, [B.lieferant]: lname, [B.status]: 'zu crawlen' } })));

  await quelleSetzen(q.id, { [Q.muster]: muster, [Q.typ]: 'html-liste', [Q.gefunden]: produkte.length, [Q.neu]: neu.length,
    [Q.status]: 'läuft', [Q.log]: `${new Date().toISOString().slice(0, 16)} Entdeckt: ${kandidaten.length} URLs, ${produkte.length} Produktseiten, ${neu.length} neu → «zu crawlen»${produkte.length - neu.length > max ? ` (Limit ${max})` : ''}.` });
  return { lieferant: lname, urls: kandidaten.length, produkte: produkte.length, neu: neu.length };
}

/* ── 2. EXTRAHIEREN ────────────────────────────────────────────────── */
async function seiteExtrahieren(rec: any): Promise<{ id: string; fields: Record<string, any>; fp?: [string, string] }> {
  const url = String(rec.fields[B.url]);
  try {
    const s = await fc('scrape', { url, formats: ['markdown'], onlyMainContent: true, timeout: 45000 });
    const md = String(s.data?.markdown || '');
    const og = s.data?.metadata?.ogImage || s.data?.metadata?.['og:image'] || '';
    const bilder = [...new Set([...(md.matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)\)/g))].map(m => m[1]))]
      .filter(b => !/logo|icon|sprite|flag|banner|badge|payment/i.test(b)).slice(0, 15);
    const o = await haiku(
      'Du extrahierst Produktdaten von Seiten kosmetischer Primärpackmittel-Hersteller. Nur Fakten, die auf der Seite stehen. Antworte nur mit JSON.',
      `URL: ${url}\nBilder:\n${bilder.join('\n') || '(keine)'}\nog:image: ${og || '-'}\n\nSeite:\n${md.slice(0, 12000)}\n\nJSON: {"ist_produkt": true wenn die Seite EIN konkretes Packmittel/Packmittelsystem beschreibt (sonst false), "name": "Produktname wie beim Hersteller", "artikelnummer": "Artikel-/Referenznummer oder leer", "volumen": "alle Größen mit Einheit, z.B. 30 ml, 50 ml", "material": "Materialien", "typ": "z.B. Flasche, Tiegel, Airless, Tube, Roll-on, Stick, Pumpe, Spray, Verschluss", "bild_url": "URL des Hauptproduktbilds aus der Bildliste (sonst og:image, sonst leer)"}`, 500);
    if (!o.ist_produkt) return { id: rec.id, fields: { [B.status]: 'verworfen', [B.roh]: `Kein Einzelprodukt erkannt.\n\n${md.slice(0, 2000)}` } };
    const bild = String(o.bild_url || og || '');
    const kopf = [`Typ: ${o.typ || '-'}`, `Volumen: ${o.volumen || '-'}`, `Material: ${o.material || '-'}`, `Quelle: ${url}`].join('\n');
    const fields: Record<string, any> = { [B.status]: 'zu prüfen', [B.name]: String(o.name || '').slice(0, 200),
      [B.artnr]: String(o.artikelnummer || '').slice(0, 80), [B.roh]: `${kopf}\n\n${md.slice(0, 15000)}` };
    if (/^https?:\/\//.test(bild)) fields[B.bild] = [{ url: bild }];
    return { id: rec.id, fields, fp: [pfad(url), hash([o.name, o.artikelnummer, o.volumen, o.material, bild].join('|'))] };
  } catch (e: any) {
    return { id: rec.id, fields: { [B.status]: 'Error', [B.roh]: `Crawler-Fehler: ${e.message}` } };
  }
}

async function extrahierenSchleife(q: any, lname: string, selbst: string, start: number) {
  const fp: Record<string, string> = (() => { try { return JSON.parse(q.fields[Q.fp] || '{}'); } catch { return {}; } })();
  const formel = `AND({${B.status}} = "zu crawlen", {${B.lieferant}} = "${lname.replace(/"/g, '')}")`;
  let fertig = 0;
  while (Date.now() - start < ZEIT_MS) {
    const p = new URLSearchParams({ pageSize: String(HAPPEN), returnFieldsByFieldId: 'true', filterByFormula: formel });
    p.append('fields[]', B.url);
    const offen = (await atJson(`${T.bulk}?${p}`)).records || [];
    if (!offen.length) break;
    const ergebnisse: any[] = [];
    for (let i = 0; i < offen.length; i += PARALLEL) ergebnisse.push(...await Promise.all(offen.slice(i, i + PARALLEL).map(seiteExtrahieren)));
    ergebnisse.forEach(e => { if (e.fp) fp[e.fp[0]] = e.fp[1]; });
    await schreiben(T.bulk, 'PATCH', ergebnisse.map(e => ({ id: e.id, fields: e.fields })));
    fertig += ergebnisse.length;
  }
  const rest = (await alle(T.bulk, [B.url], formel)).length;
  await quelleSetzen(q.id, { [Q.fp]: JSON.stringify(fp), [Q.letzter]: new Date().toISOString(),
    [Q.status]: rest ? 'läuft' : 'aktiv', [Q.log]: `${String(q.fields[Q.log] || '').split('\n')[0]}\n${new Date().toISOString().slice(0, 16)} Extrahiert: ${fertig} Seiten in diesem Lauf, noch offen: ${rest}.` });
  if (rest) await fetch(selbst, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ulba-dev': String(process.env.CRAWL_SECRET || process.env.ULBA_DEV_SECRET) },
    body: JSON.stringify({ quelleId: q.id, schritt: 'extrahieren' }) }).catch(() => {});
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  if (req.method !== 'POST') return res.status(405).json({ error: 'nur POST' });
  const erlaubt = [process.env.CRAWL_SECRET, process.env.ULBA_DEV_SECRET].filter(Boolean);
  if (!erlaubt.length || !erlaubt.includes(String(req.headers['x-ulba-dev'] || '')))
    return res.status(401).json({ error: 'nicht autorisiert' });
  for (const k of ['AIRTABLE_PAT', 'FIRECRAWL_API_KEY', 'ANTHROPIC_API_KEY'])
    if (!process.env[k]) return res.status(500).json({ error: `${k} fehlt` });
  const { quelleId, schritt = 'entdecken', max = 400 } = (req.body || {}) as { quelleId?: string; schritt?: string; max?: number };
  if (!quelleId) return res.status(400).json({ error: 'quelleId nötig' });
  const selbst = `https://${req.headers.host}/api/crawl`;
  // Sofort antworten (Airtable-Automation wartet nicht lange), Arbeit im Hintergrund.
  waitUntil((async () => {
    try {
      let q = await atJson(`${T.quellen}/${quelleId}?returnFieldsByFieldId=true`);
      let lname: string;
      if (schritt === 'entdecken') {
        await quelleSetzen(quelleId, { [Q.status]: 'läuft', [Q.log]: `${new Date().toISOString().slice(0, 16)} Crawl gestartet …` });
        lname = (await entdecken(q, Math.min(Number(max) || 400, 2000))).lieferant;
        q = await atJson(`${T.quellen}/${quelleId}?returnFieldsByFieldId=true`);
      } else lname = await lieferantName(q);
      await extrahierenSchleife(q, lname, selbst, start);
    } catch (e: any) {
      await quelleSetzen(quelleId, { [Q.status]: 'Fehler', [Q.log]: `${new Date().toISOString().slice(0, 16)} ${e.message}` }).catch(() => {});
    }
  })());
  return res.status(202).json({ ok: true, schritt, quelleId });
}
