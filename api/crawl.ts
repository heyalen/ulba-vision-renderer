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
const T = { quellen: 'tblT3NLNufj18imll', bulk: 'tblrKu0BHOH5V7YsX', system: 'tblB1kWay9TvX3rGv', lieferant: 'tblsy3CHZbAo6GraB', cap: 'tblQvnXPhiKGMoqDp' };
const Q = { name: 'fldAT1OOMAeZzfTsM', lieferant: 'fldrxmJzWBvo8WG3E', url: 'fldyyvHOcYmzxGgeU', status: 'fldUDgKPvGgDYkzCX',
  typ: 'fldDtXdEor8CGZNM0', muster: 'fld5fYoRNqhSotV7i', letzter: 'flddg1aWUXyFp8ILf', fp: 'fldwXu6n56igNpOlf',
  gefunden: 'fldCQzwU4YnlYaFZN', neu: 'fldnTqWb65gzUjdrG', geaendert: 'fld6cAltBPQCo721r', log: 'fldb85ckiSIspmk1x' };
const B = { lieferant: 'fldFnMy19K5DbOGpT', name: 'fldAbxKw2I4bBjAe5', url: 'fldV5FqTcWj8EVgwI', roh: 'fldekjxtBQuOwSdZz',
  bild: 'fldGeadiTTVSYh1lq', status: 'fld9Ges6UCFGHSCH7', artnr: 'fldNS2qarbg4JLtD8',
  bildCap: 'fldim1tbt4US5oRdB', rolle: 'fldWQA9lIjuV23SSe', hals: 'fldp5NCCuFytlwOjG',
  passt: 'fldGVYHFlw3MwVkdD', kollektion: 'fld6F3y7xEABUHlJZ', quelle: 'fld5DzraxsCpLmV0N' };
const Q_SEITEN = 'fldmSqxOtiWoXpLDn';
const SYSF = { unternehmen: 'fld79UdSUcLrXivkZ', neck: 'fldc0LLLi5v8VMPNU' };
const CAPF = { name: 'fldDrmgRkLGvuG8qS', artnr: 'fldmfINUZkLF1XT83', bild: 'fldrdBvP5VIQ61ZVB',
  status: 'fldw2YYSzaiCZL0g9', system: 'fldtnI9y9eReS2M8N', clip: 'fldNHSNelaBqE3WNC', quelle: 'fldaaJpFn0QTpcJuQ' };
const SYS_CAPS = 'fldVXTFz3pgErhYWj';
const L = { name: 'fldq27U7UQU6NZU7P', website: 'fldDfEAJQjKB3ei0G' };
const SYS_LINK = 'fldUQza6Xa9Eqksaw';
const HAPPEN = 9;           // Seiten pro Häppchen
// Seiten lesen über Jina Reader: ohne Key 20/min, mit Key 500/min (wir nutzen konservativ 60).
const RPM = Math.max(1, Number(process.env.SCRAPE_RPM) || (process.env.JINA_API_KEY ? 60 : 18));
const PARALLEL = process.env.JINA_API_KEY ? 5 : 2;
const ABSTAND_MS = Math.ceil(60_000 / RPM);
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
class RateLimit extends Error {}
/** Vergleichsschlüssel einer Produkt-URL: Pfad ohne Sprachpräfix, klein, ohne Slash am Ende. */
const seitenKey = (u: string) => { try { return new URL(u).pathname.replace(/^\/(de|en|it|fr|es|pt|nl|pl|cs|ru|zh|ja|ko|tr)(-[a-z]{2})?(?=\/)/i, '').replace(/\/$/, '').toLowerCase(); } catch { return ''; } };
/* Sprach-Dubletten: /en/x, /it/x, /fr/x → eine URL (Vorzug de > en > erste) */
const SPRACHE = /^\/(de|en|it|fr|es|pt|nl|pl|cs|ru|zh|ja|ko|tr)(-[a-z]{2})?(?=\/)/i;
function ohneSprachDubletten(urls: string[]): string[] {
  const gruppen = new Map<string, string[]>();
  for (const u of urls) { const k = pfad(u).replace(SPRACHE, ''); (gruppen.get(k) || gruppen.set(k, []).get(k)!).push(u); }
  const rang = (u: string) => { const m = pfad(u).match(SPRACHE); const l = (m?.[1] || '').toLowerCase(); return l === 'de' ? 0 : l === 'en' ? 1 : l ? 3 : 2; };
  return [...gruppen.values()].map(g => g.sort((a, b) => rang(a) - rang(b))[0]);
}

/* ── Firecrawl ─────────────────────────────────────────────────────── */
async function fc(endpoint: 'map' | 'scrape', body: any) {
  const r = await fetch(`https://api.firecrawl.dev/v1/${endpoint}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
    body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 429) throw new RateLimit('Firecrawl Rate-Limit');
  if (!r.ok || j.success === false) throw new Error(`Firecrawl ${endpoint} ${r.status}: ${String(j.error || '').slice(0, 160)}`);
  return j;
}

/* ── Jina Reader: Seite → Markdown + Links + Titel ─────────────────── */
type Gelesen = { markdown: string; links: string[]; title: string; images: string[] };

// Fallback für alte Websites, die Jina ablehnt (z.B. falscher Content-Type): HTML direkt holen und grob aufbereiten
async function direktLesen(url: string): Promise<Gelesen> {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ulba-crawler/1.0)', Accept: 'text/html,*/*' } });
  if (!r.ok) throw new Error(`Direkt ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  let html = new TextDecoder('utf-8').decode(buf);
  const cs = /charset=["']?([\w-]+)/i.exec(String(r.headers.get('content-type')) + html.slice(0, 2000))?.[1]?.toLowerCase();
  if (cs && cs !== 'utf-8') { try { html = new TextDecoder(cs).decode(buf); } catch { /* utf-8 behalten */ } }
  const abs = (h: string) => { try { return new URL(h.replace(/&amp;/g, '&'), r.url || url).href; } catch { return ''; } };
  const links = [...html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)].map(m => abs(m[1])).filter(u => /^https?:/.test(u));
  const images = [...html.matchAll(/<img\s[^>]*src=["']([^"']+)["']/gi)].map(m => abs(m[1])).filter(u => /^https?:/.test(u));
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || '').trim();
  const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi, (_m, s1) => ` ![](${abs(s1)}) `)
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { markdown: text, links: [...new Set(links)], title, images: [...new Set(images)] };
}

async function jina(url: string): Promise<Gelesen> {
  try { return await jinaRoh(url); }
  catch (e: any) { if (e instanceof RateLimit) throw e; try { return await direktLesen(url); } catch { throw e; } }
}

async function jinaRoh(url: string): Promise<Gelesen> {
  const h: Record<string, string> = { Accept: 'application/json', 'X-With-Links-Summary': 'true', 'X-With-Images-Summary': 'true', 'X-Timeout': '40',
    // Cookie-/Consent-Banner und Navigation entfernen, sonst verdrängen sie den Produktinhalt
    'X-Remove-Selector': '#CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay, #onetrust-consent-sdk, #usercentrics-root, .cc-window, .cookie, .cookies, [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [aria-label*="cookie" i], header nav, footer' };
  if (process.env.JINA_API_KEY) h.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  // POST mit JSON: URLs mit ?-Parametern (z.B. Product.asp?…) bleiben vollständig
  const r = await fetch('https://r.jina.ai/', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  if (r.status === 429) throw new RateLimit('Jina Rate-Limit');
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j?.data) throw new Error(`Jina ${r.status}: ${String(j?.message || j?.readableMessage || '').slice(0, 160)}`);
  const d = j.data;
  const alsListe = (x: any): string[] => Array.isArray(x) ? x.map((e: any) => typeof e === 'string' ? e : e?.url || e?.href || e?.[1]).filter(Boolean)
    : x && typeof x === 'object' ? Object.values(x).map(String) : [];
  return { markdown: String(d.content || ''), links: alsListe(d.links), title: String(d.title || ''), images: alsListe(d.images) };
}

/* ── Sitemap: kostenloser Katalog-Fund (sitemap.xml + robots.txt, inkl. Index-Dateien) ── */
async function sitemapUrls(origin: string): Promise<string[]> {
  const H = { 'User-Agent': 'Mozilla/5.0 (compatible; ulba-crawler/1.0)' };
  const holen = async (u: string) => { try { const r = await fetch(u, { headers: H }); return r.ok ? await r.text() : ''; } catch { return ''; } };
  const start = new Set<string>([`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]);
  const robots = await holen(`${origin}/robots.txt`);
  for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) start.add(m[1]);
  const offen = [...start], gesehen = new Set<string>(), urls = new Set<string>();
  while (offen.length && gesehen.size < 40 && urls.size < 20000) {
    const sm = offen.shift()!; if (gesehen.has(sm)) continue; gesehen.add(sm);
    const xml = await holen(sm); if (!xml.includes('<loc')) continue;
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map(m => m[1].trim());
    if (/<sitemapindex/i.test(xml)) offen.push(...locs); else locs.forEach(u => urls.add(u));
  }
  return [...urls];
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
  const origin = new URL(katalog).origin;
  let links: string[] = await sitemapUrls(origin), quelleFund = 'sitemap';
  if (links.filter(u => host(u) === dom).length < 20 && process.env.FIRECRAWL_API_KEY) {
    try { const map = await fc('map', { url: origin, limit: 5000, includeSubdomains: false });
      links = (map.links || []).map((l: any) => typeof l === 'string' ? l : l?.url).filter(Boolean); quelleFund = 'firecrawl'; } catch { /* weiter mit Jina */ }
  }
  if (links.filter(u => host(u) === dom).length < 20) {
    // Jina: Katalogseite + verlinkte Kategorieseiten (1 Ebene) lesen und Links sammeln
    // Breitensuche (max. 2 Ebenen, 35 Seiten): Kategorien UND Blätterseiten (page=2, ?p=, /seite/2 …) folgen
    const alle2 = new Set<string>(), besucht = new Set<string>();
    const istAsset = (u: string) => /\.(pdf|jpe?g|png|webp|gif|svg|zip|docx?|xlsx?|mp4|css|js)(\?|$)/i.test(u) || /javascript:|mailto:|tel:/i.test(u);
    const blaettern = (u: string) => /[?&](page|p|pg|seite|pagenum|PageNo|start|offset)=\d+|\/(page|seite)\/\d+/i.test(u);
    let ebene = [katalog];
    for (let tiefe = 0; tiefe < 3 && ebene.length && besucht.size < 35; tiefe++) {
      const naechste: string[] = [];
      for (const u of ebene) {
        if (besucht.size >= 35) break;
        const k = normUrl(u); if (besucht.has(k)) continue; besucht.add(k);
        try {
          const l = (await jina(u)).links.filter(x => host(x) === dom && !istAsset(x));
          l.forEach(x => alle2.add(x));
          // Blätterseiten immer, Kategorie-/Listenseiten nur bis Ebene 2
          naechste.push(...l.filter(x => blaettern(x) || (tiefe < 1 && pfad(x).length > 1)));
        } catch (e) { if (e instanceof RateLimit) await pause(30_000); }
        await pause(ABSTAND_MS);
      }
      ebene = [...new Set(naechste)].filter(x => !besucht.has(normUrl(x))).sort((a, b) => Number(blaettern(b)) - Number(blaettern(a)));
    }
    links = [...alle2]; quelleFund = `jina (${besucht.size} Seiten gelesen)`;
  }
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
  const produkte = ohneSprachDubletten(muster ? kandidaten.filter(u => re.test(pfad(u))) : []);
  if (!produkte.length) throw new Error(`Kein Produkt-URL-Muster gefunden (${kandidaten.length} URLs). URL_Muster von Hand setzen.`);

  // Sortiment/Quelltyp automatisch (nur wenn leer → manuelle Korrektur bleibt erhalten)
  const auto: Record<string, string> = {};
  if (!q.fields[Q_QUELLTYP]) auto[Q_QUELLTYP] = 'Web';
  if (!q.fields[Q_SORTIMENT]) {
    const o = await haiku(
      'Du ordnest Hersteller kosmetischer Primärpackmittel anhand ihrer Produkt-URLs einem Sortiment zu. Antworte nur mit JSON.',
      `Lieferant: ${lname}\nProdukt-Pfade (Auszug):\n${produkte.slice(0, 200).map(pfad).join('\n')}\n\nJSON {"sortiment": eines von ${JSON.stringify(SORTIMENTE)}}. "Komplett-Systeme" = Behälter UND passende Verschlüsse; "gemischt" = breites Sortiment ohne klaren Schwerpunkt; Spezialisten nur wählen, wenn klar >80 % der Produkte in diese Gruppe fallen.`, 100).catch(() => ({}));
    if (SORTIMENTE.includes(o.sortiment)) auto[Q_SORTIMENT] = o.sortiment;
  }

  // Wiederholbare Fehler (Rate-Limit) dieses Lieferanten löschen → werden neu angelegt
  const alteFehler = await alle(T.bulk, [B.url], `AND({${B.status}} = "Error", {${B.lieferant}} = "${lname.replace(/"/g, '')}", OR(FIND("429", {${B.roh}}), FIND("Rate", {${B.roh}})))`);
  for (let i = 0; i < alteFehler.length; i += 10) {
    await at(`${T.bulk}?${alteFehler.slice(i, i + 10).map((r: any) => `records[]=${r.id}`).join('&')}`, { method: 'DELETE' });
    await pause(220);
  }
  // Dubletten-Check: schon in Bulk_Source oder System?
  const bekannt = new Set<string>();
  (await alle(T.bulk, [B.url], `{${B.url}} != ""`)).forEach(r => bekannt.add(normUrl(r.fields[B.url] || '')));
  (await alle(T.system, [SYS_LINK], `FIND("${dom}", {${SYS_LINK}})`)).forEach(r => bekannt.add(normUrl(r.fields[SYS_LINK] || '')));
  const neu = produkte.filter(u => !bekannt.has(u)).slice(0, max);
  await schreiben(T.bulk, 'POST', neu.map(u => ({ fields: { [B.url]: u, [B.lieferant]: lname, [B.status]: 'zu crawlen', [B.quelle]: [q.id] } })));
  // Altbestand dieses Lieferanten ohne Quellen-Verknüpfung nachziehen (fürs Dashboard)
  const ohne = await alle(T.bulk, [B.url], `AND({${B.lieferant}} = "${lname.replace(/"/g, '')}", {${B.quelle}} = "")`);
  if (ohne.length) await schreiben(T.bulk, 'PATCH', ohne.map((r: any) => ({ id: r.id, fields: { [B.quelle]: [q.id] } })));

  await quelleSetzen(q.id, { ...auto, [Q.muster]: muster, [Q.typ]: 'html-liste', [Q_SEITEN]: kandidaten.length, [Q.gefunden]: produkte.length, [Q.neu]: neu.length,
    [Q.status]: 'läuft', [Q.log]: `${new Date().toISOString().slice(0, 16)} Entdeckt (${quelleFund}): ${kandidaten.length} URLs, ${produkte.length} Produktseiten, ${neu.length} neu → «zu crawlen»${produkte.length - neu.length > max ? ` (Limit ${max})` : ''}.` });
  return { lieferant: lname, urls: kandidaten.length, produkte: produkte.length, neu: neu.length };
}

/* ── 2. EXTRAHIEREN ────────────────────────────────────────────────── */
async function seiteExtrahieren(rec: any, muster?: RegExp, sortiment = ''): Promise<{ id: string; fields: Record<string, any>; fp?: [string, string] }> {
  const url = String(rec.fields[B.url]);
  try {
    const s = await jina(url);
    // Hersteller-Kompatible: alle Seitenlinks auf Produkt-Detailseiten derselben Domain (Quellen.URL_Muster), ohne die Seite selbst
    const eigen = seitenKey(url);
    const linkKandidaten = new Map<string, string>();
    for (const l of s.links) {
      if (host(l) !== host(url) || !muster || !muster.test(pfad(l))) continue;
      const k = seitenKey(l);
      if (k && k !== eigen && !linkKandidaten.has(k)) linkKandidaten.set(k, l.split('#')[0]);
    }
    const md = s.markdown;
    const og = s.images[0] || '';
    const bilder = [...new Set([...[...(md.matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)\)/g))].map(m => m[1]), ...s.images])]
      .filter(b => /^https?:/.test(b) && !/logo|icon|sprite|flag|banner|badge|payment|1x1|pixel|placeholder|\.svg(\?|$)|\.gif(\?|$)/i.test(b)).slice(0, 30);
    const o = await haiku(
      'Du extrahierst Produktdaten von Seiten kosmetischer Primärpackmittel-Hersteller. Nur Fakten, die auf der Seite stehen. Antworte nur mit JSON.',
      `${SORTIMENT_HINWEIS[sortiment] ? `Hinweis zum Lieferanten: ${SORTIMENT_HINWEIS[sortiment]}\n` : ''}URL: ${url}\nSeitentitel: ${s.title.slice(0, 160)}\nBilder:\n${bilder.join('\n') || '(keine)'}\nog:image: ${og || '-'}\n\nSeite:\n${md.slice(0, 12000)}\n\nJSON mit genau diesen Schlüsseln:
"ist_produkt": true wenn die Seite EIN konkretes Packmittel beschreibt (sonst false, z.B. Kollektion/News/Übersicht),
"rolle": "behaelter" (Flasche/Tiegel/Tube/Dose OHNE montierten Verschluss als Produkt) | "system" (Behälter INKLUSIVE Verschluss als eine verkaufte Einheit, z.B. Airless-System, Roll-on komplett) | "verschluss" (Pumpe, Sprüher, Dropper/Pipette, Kappe, Disc-Top, Actuator als eigenes Produkt) | "unklar",
"name": "Produktname wie beim Hersteller INKLUSIVE Volumen, wie im Seitentitel (z.B. FUJI 30ml, ROUND 200ml)",
"artikelnummer": "Artikel-/Referenznummer oder leer",
"volumen": "alle Größen mit Einheit, z.B. 30 ml, 50 ml",
"material": "Materialien",
"typ": "z.B. Flasche, Tiegel, Airless, Tube, Roll-on, Stick, Pumpe, Spray, Dropper, Verschluss",
"hals": "Neck-Norm(en) exakt wie angegeben, kommagetrennt (z.B. 20/400, 24/410), sonst leer",
"kollektion": "Kollektions-/Serienname (z.B. FUJI COLLECTION), sonst leer",
"passt_zu": [bis zu 12 auf der Seite verlinkte KOMPATIBLE Teile (Accessoires, 'complete your product', passende Pumpen/Dropper/Flaschen) als {"name":"...","url":"..."} — nur echte Produkt-Detail-Links, sonst leeres Array],
"bild_url": "URL des Hauptproduktbilds aus der Bildliste (sonst og:image, sonst leer)",
"weitere_bilder": [bis zu 5 weitere URLs aus der Bildliste, die DIESES Produkt zeigen (andere Ansichten, Farben, Details, Varianten) — keine Bilder anderer/verlinkter Produkte, keine Logos/Deko, keine Duplikate in anderer Größe]`, 1100);
    if (!o.ist_produkt) return { id: rec.id, fields: { [B.status]: 'verworfen', [B.roh]: `Kein Einzelprodukt erkannt.\n\n${md.slice(0, 2000)}` } };
    const bild = String(o.bild_url || og || '');
    const ROLLE: Record<string, string> = { behaelter: 'Behälter', system: 'System komplett', verschluss: 'Verschluss' };
    const rolle = ROLLE[String(o.rolle || '').trim()] || 'Unklar';
    const passtMap = new Map<string, string>();
    for (const x of (Array.isArray(o.passt_zu) ? o.passt_zu : [])) {
      const u = String(x?.url || ''); const k = seitenKey(u);
      if (/^https?:\/\//.test(u) && k && k !== eigen) passtMap.set(k, `${String(x?.name || '?').slice(0, 60)} -> ${u}`);
    }
    for (const [k, u] of linkKandidaten) if (!passtMap.has(k)) passtMap.set(k, `${k.split('/').filter(Boolean).slice(-2, -1)[0] || '?'} -> ${u}`);
    const passt = [...passtMap.values()].slice(0, 40);
    const kopf = [`Rolle: ${rolle}`, `Typ: ${o.typ || '-'}`, `Volumen: ${o.volumen || '-'}`, `Material: ${o.material || '-'}`, `Hals: ${o.hals || '-'}`, `Quelle: ${url}`].join('\n');
    const fields: Record<string, any> = { [B.status]: 'zu prüfen', [B.name]: String(o.name || '').slice(0, 200),
      [B.artnr]: String(o.artikelnummer || '').slice(0, 80), [B.rolle]: rolle,
      [B.hals]: String(o.hals || '').slice(0, 100), [B.kollektion]: String(o.kollektion || '').slice(0, 120),
      [B.passt]: passt.join('\n').slice(0, 8000), [B.roh]: `${kopf}\n\n${md.slice(0, 15000)}` };
    // Alle Produktbilder (Hauptbild zuerst, max. 6); Größen-Duplikate über Dateinamen ohne Maße aussortieren
    const ohneMass = (u: string) => u.split('?')[0].replace(/[-_]\d{2,4}x\d{2,4}(?=\.\w+$)/, '').toLowerCase();
    const gesehen = new Set<string>();
    const alleBilder = [bild, ...(Array.isArray(o.weitere_bilder) ? o.weitere_bilder.map(String) : [])]
      .filter(u => /^https?:\/\//.test(u) && (u === bild || bilder.includes(u)))
      .filter(u => { const k = ohneMass(u); if (gesehen.has(k)) return false; gesehen.add(k); return true; }).slice(0, 6);
    if (alleBilder.length) fields[rolle === 'Verschluss' ? B.bildCap : B.bild] = alleBilder.map(url => ({ url }));
    // Datenqualität 0–100: reicht das für ulba? (<30 → automatisch verworfen)
    const da = (x: any) => String(x || '').trim().length > 0 && !/^[-–]$/.test(String(x).trim());
    const vol = da(o.volumen) || /\d\s?(ml|g|cl|l|oz)\b/i.test(String(o.name || ''));
    const qual = (/^https?:\/\//.test(bild) ? 25 : 0) + (da(o.name) ? 10 : 0) + (rolle !== 'Unklar' ? 10 : 0) + (da(o.material) ? 15 : 0)
      + (da(o.artikelnummer) ? 5 : 0) + (da(o.typ) ? 5 : 0)
      + (rolle === 'Verschluss' ? (da(o.hals) ? 30 : 0) : (vol ? 20 : 0) + (da(o.hals) ? 10 : 0));
    fields[B_QUAL] = qual;
    if (qual < 30) { fields[B.status] = 'verworfen'; fields[B.roh] = `Datenqualität zu gering (${qual}/100) – zu wenig Angaben auf der Seite.\n\n${fields[B.roh]}`; }
    return { id: rec.id, fields, fp: [pfad(url), hash([o.name, o.artikelnummer, o.volumen, o.material, o.rolle, o.hals, bild].join('|'))] };
  } catch (e: any) {
    if (e instanceof RateLimit) throw e;
    return { id: rec.id, fields: { [B.status]: 'Error', [B.roh]: `Crawler-Fehler: ${e.message}` } };
  }
}

// Sortiment der Quelle → Hinweis an die KI (Spezialisten: alles ist Verschluss, Hals besonders wichtig)
const Q_SORTIMENT = 'fldVFhexIWki5G9qX';
const Q_QUELLTYP = 'flddggs2HXaT3tZp6';
const B_QUAL = 'fldjb9aSABC2tCNHB', Q_QOK = 'fldpsHxxTHwmzZIcR';
const PROBE = 6, PROBE_MIN = 45; // Probelauf: 6 Seiten, Schnitt < 45 → Quelle stoppt zur Prüfung
const SORTIMENTE = ['Komplett-Systeme', 'nur Behälter', 'Pumpen & Sprüher', 'Aerosol (Dose/Ventil)', 'Verschlüsse', 'gemischt'];
const SORTIMENT_HINWEIS: Record<string, string> = {
  'Pumpen & Sprüher': 'Spezialist für Dosiersysteme. Produkte sind fast immer rolle "verschluss" (Pumpe, Sprüher, Lotionpumpe, Actuator). Hals-Norm (z.B. 20/410, 24/410, FEA15) unbedingt exakt erfassen.',
  'Aerosol (Dose/Ventil)': 'Aerosol-Spezialist. Dose = "behaelter"; Ventil, Sprühkopf, Actuator, Kappe = "verschluss". Ventilteller-Norm (z.B. 1 Zoll / 25,4 mm) als hals erfassen.',
  'Verschlüsse': 'Verschluss-Spezialist. Produkte sind fast immer rolle "verschluss". Hals-Norm exakt erfassen.',
  'nur Behälter': 'Lieferant verkauft nur Behälter ohne Verschluss: rolle meist "behaelter". Hals-Norm exakt erfassen.',
};

// Stopp-Schalter: Quelle auf «pausiert» setzen → Kette bricht nach der aktuellen Gruppe ab.
async function gestoppt(id: string): Promise<boolean> {
  try { const r = await atJson(`${T.quellen}/${id}?returnFieldsByFieldId=true&fields[]=${Q.status}`); return String(r.fields?.[Q.status] || '') === 'pausiert'; }
  catch { return false; }
}

async function extrahierenSchleife(q: any, lname: string, selbst: string, start: number, probe = false) {
  let musterRe: RegExp | undefined;
  try { const m = String(q.fields[Q.muster] || ''); if (m) musterRe = new RegExp(m, 'i'); } catch { /* ungültig → nur KI-Links */ }
  const fp: Record<string, string> = (() => { try { return JSON.parse(q.fields[Q.fp] || '{}'); } catch { return {}; } })();
  const formel = `AND({${B.status}} = "zu crawlen", {${B.lieferant}} = "${lname.replace(/"/g, '')}")`;
  let fertig = 0, gebremst = false;
  let stopp = false;
  // Probelauf (nur direkt nach dem Entdecken, ohne manuelle Freigabe): erst wenige Seiten lesen, Qualität bewerten
  if (probe && !q.fields[Q_QOK]) {
    const p0 = new URLSearchParams({ pageSize: String(PROBE), returnFieldsByFieldId: 'true', filterByFormula: formel });
    p0.append('fields[]', B.url);
    const stich = (await atJson(`${T.bulk}?${p0}`)).records || [];
    const erg: any[] = [];
    for (let i = 0; i < stich.length; i += PARALLEL) {
      const res = await Promise.allSettled(stich.slice(i, i + PARALLEL).map((rec: any) => seiteExtrahieren(rec, musterRe, String(q.fields[Q_SORTIMENT] || ''))));
      res.forEach(r => { if (r.status === 'fulfilled') erg.push(r.value); });
      await pause(ABSTAND_MS * PARALLEL);
    }
    erg.forEach(e => { if (e.fp) fp[e.fp[0]] = e.fp[1]; });
    if (erg.length) await schreiben(T.bulk, 'PATCH', erg.map(e => ({ id: e.id, fields: e.fields })));
    const werte = erg.map(e => Number(e.fields[B_QUAL] ?? 0)); // keine Produktseite = 0
    const schnitt = werte.length ? Math.round(werte.reduce((a, b) => a + b, 0) / werte.length) : 0;
    if (werte.length >= 3 && schnitt < PROBE_MIN) {
      await quelleSetzen(q.id, { [Q.fp]: JSON.stringify(fp), [Q.status]: 'Qualität prüfen', [Q.letzter]: new Date().toISOString(),
        [Q.log]: `${String(q.fields[Q.log] || '').split('\n')[0]}\n${new Date().toISOString().slice(0, 16)} ⚠ Probelauf: Datenqualität ${schnitt}/100 bei ${werte.length} Seiten (Minimum ${PROBE_MIN}). Crawl gestoppt. Trotzdem crawlen: Qualitaet_ok anhaken + Status «crawlen».` });
      return;
    }
  }
  while (Date.now() - start < ZEIT_MS && !gebremst) {
    if (await gestoppt(q.id)) { stopp = true; break; }
    const p = new URLSearchParams({ pageSize: String(HAPPEN), returnFieldsByFieldId: 'true', filterByFormula: formel });
    p.append('fields[]', B.url);
    const offen = (await atJson(`${T.bulk}?${p}`)).records || [];
    if (!offen.length) break;
    const ergebnisse: any[] = [];
    for (let i = 0; i < offen.length; i += PARALLEL) {
      if (Date.now() - start > ZEIT_MS) break;
      const t0 = Date.now();
      const gruppe = offen.slice(i, i + PARALLEL);
      const res = await Promise.allSettled(gruppe.map((rec: any) => seiteExtrahieren(rec, musterRe, String(q.fields[Q_SORTIMENT] || ''))));
      for (const r of res) {
        if (r.status === 'fulfilled') ergebnisse.push(r.value);
        else if (r.reason instanceof RateLimit) gebremst = true;
        else throw r.reason;
      }
      if (gebremst) break;
      const rest = ABSTAND_MS * gruppe.length - (Date.now() - t0);
      if (rest > 0) await pause(rest);
    }
    ergebnisse.forEach(e => { if (e.fp) fp[e.fp[0]] = e.fp[1]; });
    if (ergebnisse.length) await schreiben(T.bulk, 'PATCH', ergebnisse.map(e => ({ id: e.id, fields: e.fields })));
    fertig += ergebnisse.length;
  }
  if (gebremst && !stopp) await pause(45_000); // Rate-Limit: kurz abwarten, dann Staffelübergabe
  if (!stopp) stopp = await gestoppt(q.id);
  const rest = (await alle(T.bulk, [B.url], formel)).length;
  await quelleSetzen(q.id, { [Q.fp]: JSON.stringify(fp), [Q.letzter]: new Date().toISOString(),
    ...(stopp ? {} : { [Q.status]: rest ? 'läuft' : 'aktiv' }), [Q.log]: `${String(q.fields[Q.log] || '').split('\n')[0]}\n${new Date().toISOString().slice(0, 16)} Extrahiert: ${fertig} Seiten in diesem Lauf${gebremst ? ' (Rate-Limit, warte)' : ''}, noch offen: ${rest}.${stopp ? ' ⏸ gestoppt.' : ''}` });
  if (rest && !stopp) await fetch(selbst, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ulba-dev': String(process.env.CRAWL_SECRET || process.env.ULBA_DEV_SECRET) },
    body: JSON.stringify({ quelleId: q.id, schritt: 'extrahieren' }) }).catch(() => {});
}

/* ── Cap-Ingest (Freigabe einer Verschluss-Zeile): Bulk_Source → Cap-Record ──
   Verknüpft den Cap NUR mit Systemen, die der Hersteller selbst zuordnet:
   Verschluss-Seite verlinkt den Behälter oder Behälter-Seite verlinkt den Verschluss. Dublette (gleiche
   Artikelnummer bzw. gleicher Name) → nur System-Links ergänzen, Status Processed. */
async function capIngest(bulkId: string, origin: string) {
  const r = await atJson(`${T.bulk}/${bulkId}?returnFieldsByFieldId=true`);
  const f = r.fields || {};
  const esc = (x: string) => x.replace(/"/g, '');
  const name = String(f[B.name] || '').trim() || 'Cap';
  const lief = String(f[B.lieferant] || '').trim();
  const artnr = String(f[B.artnr] || '').trim();
  const clip = String(f[B.roh] || '');
  const capUrl = String(f[B.url] || '');
  const capKey = seitenKey(capUrl);
  // Keys der Teile, die der Hersteller auf der Verschluss-Seite als passend verlinkt
  const passtKeys = new Set(String(f[B.passt] || '').split('\n').map(z => seitenKey(z.split(' -> ').pop() || '')).filter(Boolean));
  const bild = (f[B.bildCap] || [])[0] || (f[B.bild] || [])[0];
  if (!bild?.url) throw new Error('Kein Cap-Bild am Record (Bild_Cap leer)');

  // NUR Hersteller-Zuordnung (Entscheid Alen 10.11.; Hals-/Neck-Kombis kommen später):
  //  A) Verschluss-Seite verlinkt den Behälter  ODER  B) Behälter-Seite verlinkt diesen Verschluss
  if (capKey) {
    const rueck = await alle(T.bulk, [B.url, B.passt], `AND({${B.lieferant}} = "${esc(lief)}", FIND("${esc(capKey)}", LOWER({${B.passt}})))`);
    rueck.forEach((x: any) => { const k = seitenKey(String(x.fields[B.url] || '')); if (k) passtKeys.add(k); });
  }
  const ids = new Set<string>();
  if (lief && passtKeys.size) {
    const sys = await alle(T.system, [SYS_LINK], `{${SYSF.unternehmen}} = "${esc(lief)}"`);
    for (const x of sys) if (passtKeys.has(seitenKey(String(x.fields[SYS_LINK] || '')))) ids.add(x.id);
  }

  // Dublette?
  const formel = artnr ? `AND({${CAPF.artnr}} = "${esc(artnr)}", {${CAPF.name}} = "${esc(name)}")` : `{${CAPF.name}} = "${esc(name)}"`;
  const vorhanden = await alle(T.cap, [CAPF.system], formel);
  let capId: string, bulkStatus = 'Done';
  if (vorhanden.length) {
    capId = vorhanden[0].id; bulkStatus = 'Processed';
    const alt: string[] = (vorhanden[0].fields[CAPF.system] || []).map((x: any) => x?.id ?? x);
    const merged = [...new Set([...alt, ...ids])];
    const patch: Record<string, any> = {};
    if (merged.length > alt.length) patch[CAPF.system] = merged.map(id => ({ id }));
    if (capUrl) patch[CAPF.quelle] = capUrl;
    await atJson(`${T.cap}/${capId}`, { method: 'PATCH', body: JSON.stringify({ fields: patch }) });
  } else {
    const cf: Record<string, any> = { [CAPF.name]: name, [CAPF.bild]: [{ url: bild.url }], [CAPF.status]: { name: 'Pending' } };
    if (artnr) cf[CAPF.artnr] = artnr;
    if (capUrl) cf[CAPF.quelle] = capUrl;
    if (clip) cf[CAPF.clip] = clip.slice(0, 15000);
    if (ids.size) cf[CAPF.system] = [...ids].map(id => ({ id }));
    const j = await atJson(T.cap, { method: 'POST', body: JSON.stringify({ records: [{ fields: cf }], typecast: true }) });
    capId = j.records[0].id;
  }
  // Cap-Bild trimmen (sharp-only, idempotent) über das erste verlinkte System
  const erst = [...ids][0];
  if (erst && process.env.RENDER_SECRET)
    await fetch(`${origin}/api/harmonize`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-render-secret': String(process.env.RENDER_SECRET) },
      body: JSON.stringify({ recordId: erst, bildTyp: 'cap_only' }) }).catch(() => {});
  await atJson(`${T.bulk}/${bulkId}`, { method: 'PATCH', body: JSON.stringify({ fields: { [B.status]: { name: bulkStatus } } }) });
  return { capId, systeme: ids.size, bulkStatus, hinweis: ids.size ? undefined : 'Noch kein zugeordneter Behälter im System — Cap angelegt; Verknüpfung erfolgt automatisch, sobald der Behälter freigegeben wird.' };
}

/* ── Nachverknüpfen (neues System aus Crawl): hängt bereits angelegte Caps an,
   die der Hersteller diesem Behälter zuordnet. Macht die Freigabe-Reihenfolge egal. */
async function systemVerknuepfen(systemId: string, origin: string) {
  const sys = await atJson(`${T.system}/${systemId}?returnFieldsByFieldId=true`);
  const link = String(sys.fields?.[SYS_LINK] || '');
  const lief = String(sys.fields?.[SYSF.unternehmen] || '').trim();
  const sysKey = seitenKey(link);
  if (!sysKey || !lief) return { verknuepft: 0, grund: 'kein Link/Lieferant' };
  const esc = (x: string) => x.replace(/"/g, '');
  const keys = new Set<string>();
  // A) Behälter-Seite listet Verschlüsse (Passt_zu der eigenen Bulk-Zeile)
  const eigen = await alle(T.bulk, [B.url, B.passt], `AND({${B.lieferant}} = "${esc(lief)}", FIND("${esc(sysKey)}", LOWER({${B.url}})))`);
  for (const r of eigen) if (seitenKey(String(r.fields[B.url] || '')) === sysKey)
    String(r.fields[B.passt] || '').split('\n').forEach(z => { const k = seitenKey(z.split(' -> ').pop() || ''); if (k) keys.add(k); });
  // B) Verschluss-Seiten, die diesen Behälter verlinken
  const rueck = await alle(T.bulk, [B.url], `AND({${B.lieferant}} = "${esc(lief)}", {${B.rolle}} = "Verschluss", FIND("${esc(sysKey)}", LOWER({${B.passt}})))`);
  rueck.forEach((r: any) => { const k = seitenKey(String(r.fields[B.url] || '')); if (k) keys.add(k); });
  if (!keys.size) return { verknuepft: 0 };
  const caps = await alle(T.cap, [CAPF.quelle], `{${CAPF.quelle}} != ""`);
  const treffer = caps.filter((c: any) => keys.has(seitenKey(String(c.fields[CAPF.quelle] || '')))).map((c: any) => c.id);
  if (!treffer.length) return { verknuepft: 0 };
  const alt: string[] = (sys.fields?.[SYS_CAPS] || []).map((x: any) => x?.id ?? x);
  const merged = [...new Set([...alt, ...treffer])];
  if (merged.length > alt.length) {
    await atJson(`${T.system}/${systemId}`, { method: 'PATCH', body: JSON.stringify({ fields: { [SYS_CAPS]: merged.map(id => ({ id })) } }) });
    if (process.env.RENDER_SECRET)
      await fetch(`${origin}/api/harmonize`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-render-secret': String(process.env.RENDER_SECRET) },
        body: JSON.stringify({ recordId: systemId, bildTyp: 'cap_only' }) }).catch(() => {});
  }
  return { verknuepft: merged.length - alt.length };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  if (req.method !== 'POST') return res.status(405).json({ error: 'nur POST' });
  const erlaubt = [process.env.CRAWL_SECRET, process.env.ULBA_DEV_SECRET].filter(Boolean);
  if (!erlaubt.length || !erlaubt.includes(String(req.headers['x-ulba-dev'] || '')))
    return res.status(401).json({ error: 'nicht autorisiert' });
  for (const k of ['AIRTABLE_PAT', 'ANTHROPIC_API_KEY'])
    if (!process.env[k]) return res.status(500).json({ error: `${k} fehlt` });
  const { quelleId, schritt = 'entdecken', max = 600, bulkId } = (req.body || {}) as { quelleId?: string; schritt?: string; max?: number; bulkId?: string };
  if (schritt === 'verknuepfen') {
    const { systemId } = (req.body || {}) as { systemId?: string };
    if (!systemId) return res.status(400).json({ error: 'systemId nötig' });
    try { return res.status(200).json({ ok: true, ...(await systemVerknuepfen(String(systemId), `https://${req.headers.host}`)) }); }
    catch (e: any) { return res.status(500).json({ error: e.message }); }
  }
  if (schritt === 'cap') {
    if (!bulkId) return res.status(400).json({ error: 'bulkId nötig' });
    try { return res.status(200).json({ ok: true, ...(await capIngest(String(bulkId), `https://${req.headers.host}`)) }); }
    catch (e: any) {
      await atJson(`${T.bulk}/${bulkId}`, { method: 'PATCH', body: JSON.stringify({ fields: { [B.status]: { name: 'Error' } } }) }).catch(() => {});
      return res.status(500).json({ error: e.message });
    }
  }
  if (!quelleId) return res.status(400).json({ error: 'quelleId nötig' });
  const selbst = `https://${req.headers.host}/api/crawl`;
  // Sofort antworten (Airtable-Automation wartet nicht lange), Arbeit im Hintergrund.
  waitUntil((async () => {
    try {
      let q = await atJson(`${T.quellen}/${quelleId}?returnFieldsByFieldId=true`);
      let lname: string;
      if (schritt === 'entdecken') {
        await quelleSetzen(quelleId, { [Q.status]: 'läuft', [Q.letzter]: new Date().toISOString(), [Q.log]: `${new Date().toISOString().slice(0, 16)} Crawl gestartet …` });
        lname = (await entdecken(q, Math.min(Number(max) || 600, 2000))).lieferant;
        q = await atJson(`${T.quellen}/${quelleId}?returnFieldsByFieldId=true`);
      } else lname = await lieferantName(q);
      await extrahierenSchleife(q, lname, selbst, start, schritt === 'entdecken');
    } catch (e: any) {
      await quelleSetzen(quelleId, { [Q.status]: 'Fehler', [Q.log]: `${new Date().toISOString().slice(0, 16)} ${e.message}` }).catch(() => {});
    }
  })());
  return res.status(202).json({ ok: true, schritt, quelleId });
}
