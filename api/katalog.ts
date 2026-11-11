/* ══════════════════════════════════════════════════════════════════════
   ulba · api/katalog.ts — Katalog-Import des neuen ulba (Supabase).
   Ersetzt Crawler v1 + die Airtable-Pipeline. Eine Quelle (Studio →
   «Katalog hinzufügen») läuft in vier Schritten, jeder ruft den nächsten
   selbst auf (Staffelübergabe wegen maxDuration):
     1. entdecken   Sitemap / Firecrawl / Jina → Produkt-URL-Muster (Haiku)
                    → Arbeitsliste import_seiten
     2. lesen       je Seite Jina + Haiku → Teil «in Prüfung» + Rohfoto im
                    Supabase-Speicher
     3. veredeln    je Teil: Freistellen (fal birefnet + sharp → Studiofoto)
                    und Taggen (Claude Vision: Typ, Material, Deko-
                    Fähigkeiten, Render-Zonen, Verschluss einfärbbar)
     4. verknuepfen Behälter ↔ Verschlüsse aus den Hersteller-Links
   Auslöser: Datenbank-Trigger auf quellen (pg_net) oder manuell.
   POST, Header x-katalog-secret: <KATALOG_SECRET>
   Body: { quelleId, schritt?: 'entdecken'|'lesen'|'veredeln'|'verknuepfen', laufId? }
   ══════════════════════════════════════════════════════════════════════ */
import { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { createHash } from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const ZEIT_MS = 120_000;   // danach kein neuer Block mehr → Staffelübergabe
const RPM = Math.max(1, Number(process.env.SCRAPE_RPM) || (process.env.JINA_API_KEY ? 60 : 18));
const PARALLEL = process.env.JINA_API_KEY ? 5 : 2;
const ABSTAND_MS = Math.ceil(60_000 / RPM);
const MAX_SEITEN = 600;

const pause = (ms: number) => new Promise(z => setTimeout(z, ms));
const jetzt = () => new Date().toISOString();
const heute = () => jetzt().slice(0, 10);
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const pfad = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const normUrl = (u: string) => { try { const x = new URL(u); x.hash = ''; return (x.origin + x.pathname).replace(/\/$/, '').toLowerCase() + x.search; } catch { return ''; } };
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const SPRACHE = /^\/(de|en|it|fr|es|pt|nl|pl|cs|ru|zh|ja|ko|tr)(-[a-z]{2})?(?=\/)/i;
const seitenKey = (u: string) => { try { return new URL(u).pathname.replace(SPRACHE, '').replace(/\/$/, '').toLowerCase(); } catch { return ''; } };
class RateLimit extends Error {}
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ulba-katalog/1.0; +https://ulba.ai)' };

function db(): SupabaseClient {
  return createClient(String(process.env.SUPABASE_URL), String(process.env.SUPABASE_SECRET_KEY), { auth: { persistSession: false, autoRefreshToken: false } });
}

function ohneSprachDubletten(urls: string[]): string[] {
  const g = new Map<string, string[]>();
  for (const u of urls) { const k = pfad(u).replace(SPRACHE, ''); (g.get(k) || g.set(k, []).get(k)!).push(u); }
  const rang = (u: string) => { const l = (pfad(u).match(SPRACHE)?.[1] || '').toLowerCase(); return l === 'de' ? 0 : l === 'en' ? 1 : l ? 3 : 2; };
  return [...g.values()].map(x => x.sort((a, b) => rang(a) - rang(b))[0]);
}

/* ── Lesen: Jina Reader, Fallback direktes HTML ─────────────────────── */
type Gelesen = { markdown: string; links: string[]; title: string; images: string[] };
async function direktLesen(url: string): Promise<Gelesen> {
  const r = await fetch(url, { headers: { ...UA, Accept: 'text/html,*/*' } });
  if (!r.ok) throw new Error(`Direkt ${r.status}`);
  const html = await r.text();
  const abs = (h: string) => { try { return new URL(h.replace(/&amp;/g, '&'), r.url || url).href; } catch { return ''; } };
  const links = [...html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)].map(m => abs(m[1])).filter(u => /^https?:/.test(u));
  const images = [...html.matchAll(/<img\s[^>]*src=["']([^"']+)["']/gi)].map(m => abs(m[1])).filter(u => /^https?:/.test(u));
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || '').trim();
  const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi, (_m, s1) => ` ![](${abs(s1)}) `)
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { markdown: text, links: [...new Set(links)], title, images: [...new Set(images)] };
}
async function jinaRoh(url: string): Promise<Gelesen> {
  const h: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-With-Links-Summary': 'true', 'X-With-Images-Summary': 'true', 'X-Timeout': '40',
    'X-Remove-Selector': '#CybotCookiebotDialog, #onetrust-consent-sdk, #usercentrics-root, .cc-window, [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], header nav, footer' };
  if (process.env.JINA_API_KEY) h.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  const r = await fetch('https://r.jina.ai/', { method: 'POST', headers: h, body: JSON.stringify({ url }) });
  if (r.status === 429) throw new RateLimit('Jina Rate-Limit');
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j?.data) throw new Error(`Jina ${r.status}`);
  const liste = (x: any): string[] => Array.isArray(x) ? x.map((e: any) => typeof e === 'string' ? e : e?.url || e?.href || e?.[1]).filter(Boolean)
    : x && typeof x === 'object' ? Object.values(x).map(String) : [];
  return { markdown: String(j.data.content || ''), links: liste(j.data.links), title: String(j.data.title || ''), images: liste(j.data.images) };
}
async function lesen(url: string): Promise<Gelesen> {
  try { return await jinaRoh(url); }
  catch (e) { if (e instanceof RateLimit) throw e; return direktLesen(url); }
}

async function sitemapUrls(origin: string): Promise<string[]> {
  const holen = async (u: string) => { try { const r = await fetch(u, { headers: UA }); return r.ok ? await r.text() : ''; } catch { return ''; } };
  const start = new Set([`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]);
  for (const m of (await holen(`${origin}/robots.txt`)).matchAll(/^\s*sitemap:\s*(\S+)/gim)) start.add(m[1]);
  const offen = [...start], gesehen = new Set<string>(), urls = new Set<string>();
  while (offen.length && gesehen.size < 40 && urls.size < 20000) {
    const sm = offen.shift()!; if (gesehen.has(sm)) continue; gesehen.add(sm);
    const xml = await holen(sm); if (!xml.includes('<loc')) continue;
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map(m => m[1].trim());
    if (/<sitemapindex/i.test(xml)) offen.push(...locs); else locs.forEach(u => urls.add(u));
  }
  return [...urls];
}

async function firecrawlMap(origin: string): Promise<string[]> {
  const r = await fetch('https://api.firecrawl.dev/v1/map', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
    body: JSON.stringify({ url: origin, limit: 5000, includeSubdomains: false }) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Firecrawl ${r.status}`);
  return (j.links || []).map((l: any) => typeof l === 'string' ? l : l?.url).filter(Boolean);
}

/* ── Claude ─────────────────────────────────────────────────────────── */
async function claude(model: string, system: string, content: any, max = 800): Promise<any> {
  for (let v = 0; v < 3; v++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': String(process.env.ANTHROPIC_API_KEY), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: max, temperature: 0, system, messages: [{ role: 'user', content }] }) });
    if (r.status === 429 || r.status === 529) { await pause(4000 * (v + 1)); continue; }
    const j: any = await r.json();
    if (!r.ok) throw new Error(`Claude ${r.status}: ${String(j?.error?.message || '').slice(0, 160)}`);
    const m = String(j.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Claude ohne JSON');
    return JSON.parse(m[0]);
  }
  throw new Error('Claude überlastet');
}
const haiku = (s: string, u: string, max?: number) => claude('claude-haiku-4-5', s, u, max);

/* ── Speicher ───────────────────────────────────────────────────────── */
async function bildSpeichern(sb: SupabaseClient, pfadImBucket: string, buf: Buffer, typ: string) {
  const { error } = await sb.storage.from('teile').upload(pfadImBucket, buf, { contentType: typ, upsert: true });
  if (error) throw new Error(`Speicher: ${error.message}`);
}

/* ── Status-Helfer ──────────────────────────────────────────────────── */
async function quelleLog(sb: SupabaseClient, id: string, felder: Record<string, any>, zeile?: string) {
  if (zeile) {
    const { data } = await sb.from('quellen').select('log').eq('id', id).single();
    felder.log = [`${jetzt().slice(0, 16)} ${zeile}`, ...String((data as any)?.log || '').split('\n')].slice(0, 30).join('\n');
  }
  await sb.from('quellen').update(felder).eq('id', id);
}
async function weiter(selbst: string, body: Record<string, any>) {
  await fetch(selbst, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-katalog-secret': String(process.env.KATALOG_SECRET) },
    body: JSON.stringify(body) }).catch(() => {});
}

/* ══ 1. ENTDECKEN ══════════════════════════════════════════════════════ */
async function entdecken(sb: SupabaseClient, q: any): Promise<number> {
  const katalog = String(q.katalog_url || '');
  const dom = host(katalog), origin = new URL(katalog).origin;
  let links = await sitemapUrls(origin), fund = 'Sitemap';
  if (links.filter(u => host(u) === dom).length < 20 && process.env.FIRECRAWL_API_KEY) {
    try { links = await firecrawlMap(origin); fund = 'Firecrawl'; } catch { /* weiter mit Jina */ }
  }
  if (links.filter(u => host(u) === dom).length < 20) {
    const gesammelt = new Set<string>(), besucht = new Set<string>();
    const asset = (u: string) => /\.(pdf|jpe?g|png|webp|gif|svg|zip|docx?|xlsx?|mp4|css|js)(\?|$)/i.test(u) || /javascript:|mailto:|tel:/i.test(u);
    const blaettern = (u: string) => /[?&](page|p|pg|seite|start|offset)=\d+|\/(page|seite)\/\d+/i.test(u);
    let ebene = [katalog];
    for (let t = 0; t < 3 && ebene.length && besucht.size < 35; t++) {
      const naechste: string[] = [];
      for (const u of ebene) {
        if (besucht.size >= 35) break;
        const k = normUrl(u); if (besucht.has(k)) continue; besucht.add(k);
        try { const l = (await lesen(u)).links.filter(x => host(x) === dom && !asset(x)); l.forEach(x => gesammelt.add(x));
          naechste.push(...l.filter(x => blaettern(x) || (t < 1 && pfad(x).length > 1))); }
        catch (e) { if (e instanceof RateLimit) await pause(30_000); }
        await pause(ABSTAND_MS);
      }
      ebene = [...new Set(naechste)].filter(x => !besucht.has(normUrl(x)));
    }
    links = [...gesammelt]; fund = `Website (${besucht.size} Seiten gelesen)`;
  }
  const kandidaten = [...new Set(links.filter(u => host(u) === dom)
    .filter(u => !/\.(pdf|jpe?g|png|webp|gif|svg|zip|docx?|xlsx?|mp4)(\?|$)/i.test(u))
    .filter(u => !/\/(blog|news|press|career|karriere|job|contact|kontakt|privacy|datenschutz|cookie|impressum|legal|imprint|login|cart|account|tag|author|feed|wp-json|wp-content|search)(\/|$|\?)/i.test(u))
    .map(normUrl).filter(Boolean))];
  if (!kandidaten.length) throw new Error(`Auf ${dom} wurden keine Seiten gefunden.`);

  let muster = String(q.url_muster || '').trim();
  if (!muster) {
    const o = await haiku('Du erkennst in URL-Listen von Verpackungsherstellern die Detailseiten EINZELNER Produkte (eine Flasche, ein Tiegel, eine Pumpe …), nicht Kategorie-, Kollektions-, Filter- oder Infoseiten. Antworte nur mit JSON.',
      `Katalog-Einstieg: ${pfad(katalog)}\nPfade:\n${kandidaten.slice(0, 300).map(pfad).join('\n')}\n\nJSON {"regex":"JavaScript-Regex ohne Slashes, der NUR auf Produkt-Detailpfade passt"}. Wenn keine erkennbar: {"regex":""}.`, 400);
    muster = String(o.regex || '');
  }
  let re: RegExp; try { re = new RegExp(muster, 'i'); } catch { throw new Error('Produkt-Muster ungültig'); }
  const produkte = muster ? ohneSprachDubletten(kandidaten.filter(u => re.test(pfad(u)))).slice(0, MAX_SEITEN) : [];
  if (!produkte.length) throw new Error(`Keine Produktseiten erkannt (${kandidaten.length} Seiten durchsucht).`);

  for (let i = 0; i < produkte.length; i += 200) {
    await sb.from('import_seiten').upsert(produkte.slice(i, i + 200).map(url => ({ quelle_id: q.id, firma_id: q.firma_id, url, status: 'zu_lesen' })),
      { onConflict: 'quelle_id,url', ignoreDuplicates: true });
  }
  // Bereits gelesene Seiten erneut prüfen (Delta-Lauf): auf zu_lesen zurücksetzen
  await sb.from('import_seiten').update({ status: 'zu_lesen' }).eq('quelle_id', q.id).in('status', ['gelesen', 'fehler']);
  await quelleLog(sb, q.id, { url_muster: muster }, `Gefunden über ${fund}: ${kandidaten.length} Seiten, davon ${produkte.length} Produktseiten.`);
  return produkte.length;
}

/* ══ 2. LESEN ══════════════════════════════════════════════════════════ */
const ROLLEN = ['behaelter', 'system', 'verschluss'];
function volumenMl(s: string): number | null {
  const m = String(s || '').replace(',', '.').match(/(\d+(?:\.\d+)?)\s*(ml|cl|l|g)\b/i);
  if (!m) return null;
  const n = Number(m[1]); const e = m[2].toLowerCase();
  return e === 'cl' ? n * 10 : e === 'l' ? n * 1000 : n;
}

async function seiteLesen(sb: SupabaseClient, q: any, seite: any, muster?: RegExp) {
  const url = String(seite.url);
  const s = await lesen(url);
  const eigen = seitenKey(url);
  const verlinkt = new Set<string>();
  for (const l of s.links) if (host(l) === host(url) && muster?.test(pfad(l)) && seitenKey(l) !== eigen) verlinkt.add(seitenKey(l));
  const bilder = [...new Set([...[...s.markdown.matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)\)/g)].map(m => m[1]), ...s.images])]
    .filter(b => /^https?:/.test(b) && !/logo|icon|sprite|flag|banner|badge|payment|1x1|pixel|placeholder|\.svg(\?|$)|\.gif(\?|$)/i.test(b)).slice(0, 30);
  const o = await haiku('Du extrahierst Produktdaten von Seiten kosmetischer Primärpackmittel-Hersteller. Nur Fakten, die auf der Seite stehen. Antworte nur mit JSON.',
    `URL: ${url}\nSeitentitel: ${s.title.slice(0, 160)}\nBilder:\n${bilder.join('\n') || '(keine)'}\n\nSeite:\n${s.markdown.slice(0, 12000)}\n\nJSON mit genau diesen Schlüsseln:
"ist_produkt": true wenn die Seite EIN konkretes Packmittel beschreibt (sonst false),
"rolle": "behaelter" (Flasche/Tiegel/Tube OHNE montierten Verschluss) | "system" (Behälter INKLUSIVE Verschluss als eine Einheit, z.B. Airless) | "verschluss" (Pumpe, Sprüher, Pipette, Kappe als eigenes Produkt),
"name": "Produktname wie beim Hersteller INKLUSIVE Volumen",
"artikelnummer": "Artikel-/Referenznummer oder leer",
"volumen": "Größe mit Einheit, z.B. 30 ml",
"material": "Materialien",
"hals": "Neck-Norm(en) exakt, z.B. 20/400, sonst leer",
"kollektion": "Kollektions-/Serienname, sonst leer",
"passt_zu": [bis zu 12 URLs verlinkter KOMPATIBLER Teile (passende Pumpen/Kappen/Flaschen), sonst leer],
"bild_url": "URL des Hauptproduktbilds aus der Bildliste, sonst leer"`, 1000);
  if (!o.ist_produkt) { await sb.from('import_seiten').update({ status: 'verworfen', log: 'Kein Einzelprodukt' }).eq('id', seite.id); return 'verworfen'; }

  const rolle = ROLLEN.includes(String(o.rolle)) ? String(o.rolle) : 'behaelter';
  const artnr = String(o.artikelnummer || '').trim().slice(0, 80);
  const schluessel = (artnr ? `ART:${artnr}` : `URL:${eigen}`).toUpperCase();
  const felder = { name: String(o.name || s.title || 'Teil').slice(0, 200), artikelnummer: artnr || null, rolle,
    material: String(o.material || '').slice(0, 120) || null, volumen_ml: volumenMl(o.volumen) ?? volumenMl(o.name),
    hals: String(o.hals || '').slice(0, 100) || null, kollektion: String(o.kollektion || '').slice(0, 120) || null,
    quelle_id: q.id, quelle_url: url, rohtext: s.markdown.slice(0, 15000), zuletzt_gesehen: heute() };

  const { data: alt } = await sb.from('teile').select('id, status').eq('firma_id', q.firma_id).eq('katalog_schluessel', schluessel).maybeSingle();
  let teilId: string, neu = false;
  if (alt) {
    teilId = (alt as any).id;
    // Vom Lieferanten geprüfte Teile nicht überschreiben — nur «noch im Katalog» vermerken
    await sb.from('teile').update({ zuletzt_gesehen: heute(), ...((alt as any).status === 'nicht_mehr_im_katalog' ? { status: 'aktiv' } : {}) }).eq('id', teilId);
  } else {
    const { data, error } = await sb.from('teile').insert({ ...felder, firma_id: q.firma_id, katalog_schluessel: schluessel, status: 'in_pruefung', pipeline: 'neu' }).select('id').single();
    if (error || !data) throw new Error(`Teil speichern: ${error?.message}`);
    teilId = (data as any).id; neu = true;
    const bild = String(o.bild_url || bilder[0] || '');
    if (/^https?:\/\//.test(bild)) {
      try {
        const r = await fetch(bild, { headers: { ...UA, Referer: url } });
        const typ = String(r.headers.get('content-type') || 'image/jpeg').split(';')[0];
        if (r.ok && /^image\//.test(typ)) {
          const p = `${q.firma_id}/${teilId}/roh.${typ.includes('png') ? 'png' : typ.includes('webp') ? 'webp' : 'jpg'}`;
          await bildSpeichern(sb, p, Buffer.from(await r.arrayBuffer()), typ);
          await sb.from('teile').update({ bild_roh_pfad: p }).eq('id', teilId);
        }
      } catch { /* ohne Bild weiter → veredeln meldet es */ }
    }
  }
  const passt = [...new Set([...(Array.isArray(o.passt_zu) ? o.passt_zu.map((u: any) => seitenKey(String(u?.url ?? u))) : []), ...verlinkt])].filter(Boolean).slice(0, 40);
  await sb.from('import_seiten').update({ status: 'gelesen', teil_id: teilId, passt_zu: passt,
    fingerprint: hash([felder.name, artnr, felder.volumen_ml, felder.material, rolle, felder.hals].join('|')), log: null }).eq('id', seite.id);
  return neu ? 'neu' : 'bekannt';
}

async function lesenSchleife(sb: SupabaseClient, q: any, lauf: any, start: number): Promise<boolean> {
  let muster: RegExp | undefined; try { if (q.url_muster) muster = new RegExp(q.url_muster, 'i'); } catch { /* egal */ }
  let neu = 0, bekannt = 0;
  while (Date.now() - start < ZEIT_MS) {
    const { data } = await sb.from('import_seiten').select('id, url').eq('quelle_id', q.id).eq('status', 'zu_lesen').limit(PARALLEL * 2);
    const offen = (data || []) as any[];
    if (!offen.length) break;
    for (let i = 0; i < offen.length; i += PARALLEL) {
      const t0 = Date.now();
      const res = await Promise.allSettled(offen.slice(i, i + PARALLEL).map(s => seiteLesen(sb, q, s, muster)));
      for (let k = 0; k < res.length; k++) {
        const r = res[k];
        if (r.status === 'fulfilled') { if (r.value === 'neu') neu++; else if (r.value === 'bekannt') bekannt++; }
        else if (r.reason instanceof RateLimit) { await pause(45_000); }
        else await sb.from('import_seiten').update({ status: 'fehler', log: String(r.reason?.message || r.reason).slice(0, 300) }).eq('id', offen[i + k].id);
      }
      const rest = ABSTAND_MS * PARALLEL - (Date.now() - t0);
      if (rest > 0) await pause(rest);
    }
  }
  await sb.from('import_laeufe').update({ teile_neu: (lauf.teile_neu || 0) + neu, teile_aktualisiert: (lauf.teile_aktualisiert || 0) + bekannt }).eq('id', lauf.id);
  const { count } = await sb.from('import_seiten').select('id', { count: 'exact', head: true }).eq('quelle_id', q.id).eq('status', 'zu_lesen');
  return (count || 0) > 0;
}

/* ══ 3. VEREDELN: Freistellen + Taggen ═════════════════════════════════ */
async function freistellen(sb: SupabaseClient, teil: any): Promise<Buffer<ArrayBufferLike>> {
  const { data: signiert } = await sb.storage.from('teile').createSignedUrl(teil.bild_roh_pfad, 600);
  if (!signiert?.signedUrl) throw new Error('Rohbild nicht lesbar');
  const r = await fetch('https://fal.run/fal-ai/birefnet', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${process.env.FAL_API_KEY}` },
    // sync_mode: Bild kommt direkt zurück, nichts bleibt bei fal gespeichert
    body: JSON.stringify({ image_url: signiert.signedUrl, model: 'General Use (Light)', sync_mode: true }) });
  if (!r.ok) throw new Error(`Freistellen ${r.status}`);
  const j: any = await r.json();
  const u = String(j?.image?.url || '');
  const cutout = u.startsWith('data:') ? Buffer.from(u.split(',')[1], 'base64') : Buffer.from(await (await fetch(u)).arrayBuffer());
  const sharp = (await import('sharp')).default;
  const BG = { r: 255, g: 255, b: 255, alpha: 1 };
  let basis: Buffer<ArrayBufferLike> = cutout; try { basis = await sharp(cutout).trim({ threshold: 12 }).toBuffer(); } catch { /* Original */ }
  const meta = await sharp(basis).metadata();
  const m = Math.max(2, Math.round(Math.max(meta.width || 0, meta.height || 0) * 0.06));
  const jpg = await sharp(basis).extend({ top: m, bottom: m, left: m, right: m, background: BG }).flatten({ background: BG })
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  const p = `${teil.firma_id}/${teil.id}/studio.jpg`;
  await bildSpeichern(sb, p, jpg, 'image/jpeg');
  await sb.from('teile').update({ bild_pfad: p, pipeline: 'freigestellt' }).eq('id', teil.id);
  return jpg;
}

const DEKO = ['einfaerbung_masse', 'direktdruck', 'etikett', 'sleeve', 'spruehlackierung', 'farbe_fix'];
const TYPEN = ['Flasche', 'Tiegel', 'Tube', 'Airless', 'Pump', 'Spray', 'Stick', 'Dose', 'Pipette', 'Kappe'];
const VERSCHLUSS = ['Schraubverschluss', 'Pump', 'Airless', 'Pipette', 'Flip-Top', 'Disc-Top', 'Snap-On', 'Spray', 'Dosierpumpe'];
const TAG_SYSTEM = `Du bist Verpackungsingenieur für kosmetische Primärpackmittel. Du bekommst das freigestellte Studiofoto EINES Teils und den Text der Herstellerseite. Du bestimmst nur, was Foto oder Text belegen. Antworte nur mit JSON.`;
function tagPrompt(teil: any) {
  return `Teil: ${teil.name}\nRolle laut Katalog: ${teil.rolle}\nMaterial laut Seite: ${teil.material || '-'}\nVolumen: ${teil.volumen_ml ?? '-'} ml · Hals: ${teil.hals || '-'}\n\nSeitentext (Auszug):\n${String(teil.rohtext || '').slice(0, 5000)}\n
JSON mit genau diesen Schlüsseln:
"typ": eines von ${JSON.stringify(TYPEN)},
"material": kurz, z.B. "Glas", "Braunglas", "PET", "rPET", "PP", "HDPE", "Aluminium", "Glas + PP",
"volumen_ml": Zahl oder null,
"hals": Neck-Norm oder null,
"deko_faehigkeiten": Auswahl aus ${JSON.stringify(DEKO)} — welche Dekorationsverfahren für DIESES Teil realistisch bestellbar sind. Regeln: Klarglas → direktdruck, etikett, spruehlackierung (sleeve nur bei zylindrischer Flasche). Eingefärbtes Glas (Braun/Grün/Blau/Violett) → farbe_fix + etikett + direktdruck (Glasfarbe bleibt!). Kunststoff (PET, PP, HDPE, PETG) → einfaerbung_masse + direktdruck + etikett (+ sleeve bei Flaschen/Tuben). Aluminium/Metall → spruehlackierung + direktdruck. Verschlüsse aus Kunststoff → einfaerbung_masse. Belegt die Seite weitere/andere Verfahren, folge der Seite.
"render_zonen": {"zones":[{"id": eines von ["outer_wall","inner_cartridge","liquid","cap","base","sleeve"], "material": kurz, "transparent": true|false, "colorable": "full"|"tint"|"none", "notes": kurz}], "primary_canvas": id der Zone, die den Look trägt, "redirect_canvas": id der Ausweichzone oder null}. Zonen aus dem FOTO lesen: z.B. Airless mit Klarglas-Hülle und Innenkartusche → outer_wall transparent tint, inner_cartridge full. Braunglas → outer_wall colorable "none", primary_canvas = Etikett-Fläche über "sleeve". Ein sichtbarer Verschluss ist Zone "cap".
"einfaerbbar": nur bei Verschlüssen/Systemen: true wenn der Verschluss Kunststoff ist und in Masse eingefärbt werden kann, false bei Metall/Chrom/Alu, sonst null,
"verschluss_art": bei Verschlüssen oder Systemen eines von ${JSON.stringify(VERSCHLUSS)}, sonst null,
"kurzbeschreibung": 1 sachlicher Satz auf Deutsch, was das Teil ist (Form, Material, Besonderheit).`;
}

async function taggen(sb: SupabaseClient, teil: any, jpg: Buffer<ArrayBufferLike>) {
  const o = await claude('claude-sonnet-4-5', TAG_SYSTEM, [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpg.toString('base64') } },
    { type: 'text', text: tagPrompt(teil) },
  ], 1400);
  const zonen = o.render_zonen && Array.isArray(o.render_zonen.zones) && o.render_zonen.zones.length ? o.render_zonen : {};
  await sb.from('teile').update({
    typ: TYPEN.includes(o.typ) ? o.typ : null,
    material: teil.material || (o.material ? String(o.material).slice(0, 120) : null),
    volumen_ml: teil.volumen_ml ?? (Number(o.volumen_ml) || null),
    hals: teil.hals || (o.hals ? String(o.hals).slice(0, 100) : null),
    deko_faehigkeiten: (Array.isArray(o.deko_faehigkeiten) ? o.deko_faehigkeiten : []).filter((d: string) => DEKO.includes(d)),
    render_zonen: zonen,
    einfaerbbar: typeof o.einfaerbbar === 'boolean' ? o.einfaerbbar : null,
    verschluss_art: VERSCHLUSS.includes(o.verschluss_art) ? o.verschluss_art : null,
    kurzbeschreibung: o.kurzbeschreibung ? String(o.kurzbeschreibung).slice(0, 400) : null,
    pipeline: 'fertig', pipeline_log: null,
  }).eq('id', teil.id);
}

async function veredelnSchleife(sb: SupabaseClient, q: any, start: number): Promise<boolean> {
  while (Date.now() - start < ZEIT_MS) {
    const { data } = await sb.from('teile').select('id, firma_id, name, rolle, material, volumen_ml, hals, rohtext, bild_roh_pfad, bild_pfad, pipeline')
      .eq('quelle_id', q.id).in('pipeline', ['neu', 'freigestellt']).limit(3);
    const offen = (data || []) as any[];
    if (!offen.length) break;
    await Promise.allSettled(offen.map(async (t) => {
      try {
        if (!t.bild_roh_pfad) throw new Error('Kein Produktfoto auf der Herstellerseite gefunden.');
        let jpg: Buffer<ArrayBufferLike>;
        if (t.pipeline === 'freigestellt' && t.bild_pfad) {
          const { data: b } = await sb.storage.from('teile').download(t.bild_pfad);
          jpg = Buffer.from(await b!.arrayBuffer());
        } else jpg = await freistellen(sb, t);
        await taggen(sb, t, jpg);
      } catch (e: any) {
        await sb.from('teile').update({ pipeline: 'fehler', pipeline_log: String(e?.message || e).slice(0, 400) }).eq('id', t.id);
      }
    }));
  }
  const { count } = await sb.from('teile').select('id', { count: 'exact', head: true }).eq('quelle_id', q.id).in('pipeline', ['neu', 'freigestellt']);
  return (count || 0) > 0;
}

/* ══ 4. VERKNÜPFEN: Behälter ↔ Verschluss aus Hersteller-Links ═════════ */
async function verknuepfen(sb: SupabaseClient, q: any): Promise<number> {
  const { data } = await sb.from('import_seiten').select('url, teil_id, passt_zu').eq('quelle_id', q.id).eq('status', 'gelesen').not('teil_id', 'is', null);
  const seiten = (data || []) as any[];
  const ids = [...new Set(seiten.map(s => s.teil_id))];
  const rolle = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: t } = await sb.from('teile').select('id, rolle').in('id', ids.slice(i, i + 200));
    (t || []).forEach((x: any) => rolle.set(x.id, x.rolle));
  }
  const perKey = new Map(seiten.map(s => [seitenKey(s.url), s.teil_id as string]));
  const paare = new Map<string, { teil_id: string; verschluss_id: string }>();
  for (const s of seiten) for (const k of (s.passt_zu || []) as string[]) {
    const andere = perKey.get(k); if (!andere || andere === s.teil_id) continue;
    const a = rolle.get(s.teil_id), b = rolle.get(andere);
    if (a !== 'verschluss' && b === 'verschluss') paare.set(`${s.teil_id}|${andere}`, { teil_id: s.teil_id, verschluss_id: andere });
    if (a === 'verschluss' && b !== 'verschluss') paare.set(`${andere}|${s.teil_id}`, { teil_id: andere, verschluss_id: s.teil_id });
  }
  const liste = [...paare.values()];
  for (let i = 0; i < liste.length; i += 200)
    await sb.from('teil_verschluesse').upsert(liste.slice(i, i + 200), { onConflict: 'teil_id,verschluss_id', ignoreDuplicates: true });
  return liste.length;
}

/* ══ Ablauf ═══════════════════════════════════════════════════════════ */
async function ablauf(quelleId: string, schritt: string, laufId: string | undefined, selbst: string, start: number) {
  const sb = db();
  const { data: q } = await sb.from('quellen').select('*').eq('id', quelleId).single();
  if (!q) return;
  let lauf: any;
  try {
    if (schritt === 'entdecken') {
      const { data } = await sb.from('import_laeufe').insert({ quelle_id: quelleId }).select('*').single();
      lauf = data;
      await quelleLog(sb, quelleId, { status: 'laeuft', letzter_lauf_am: jetzt() }, 'Einlesen gestartet.');
      if (q.art === 'pdf') {
        await quelleLog(sb, quelleId, { status: 'neu' }, 'PDF-Kataloge richten wir derzeit von Hand ein.');
        await sb.from('import_laeufe').update({ status: 'fertig', beendet_am: jetzt(), log: 'PDF: manuell' }).eq('id', lauf.id);
        return;
      }
      const n = await entdecken(sb, q);
      await sb.from('import_laeufe').update({ seiten_gefunden: n }).eq('id', lauf.id);
      return weiter(selbst, { quelleId, schritt: 'lesen', laufId: lauf.id });
    }
    lauf = (await sb.from('import_laeufe').select('*').eq('id', laufId).single()).data;
    if (!lauf) throw new Error('Import-Lauf fehlt');
    if (schritt === 'lesen') {
      const mehr = await lesenSchleife(sb, q, lauf, start);
      return weiter(selbst, { quelleId, schritt: mehr ? 'lesen' : 'veredeln', laufId });
    }
    if (schritt === 'veredeln') {
      const mehr = await veredelnSchleife(sb, q, start);
      return weiter(selbst, { quelleId, schritt: mehr ? 'veredeln' : 'verknuepfen', laufId });
    }
    if (schritt === 'verknuepfen') {
      const paare = await verknuepfen(sb, q);
      const { count: pruef } = await sb.from('teile').select('id', { count: 'exact', head: true }).eq('quelle_id', quelleId).eq('status', 'in_pruefung');
      const { count: fehl } = await sb.from('teile').select('id', { count: 'exact', head: true }).eq('quelle_id', quelleId).eq('pipeline', 'fehler');
      const satz = `Fertig: ${lauf.teile_neu} neue Teile, ${lauf.teile_aktualisiert} bekannte, ${paare} Verschluss-Zuordnungen. ${pruef || 0} warten auf Prüfung${fehl ? `, ${fehl} ohne verwertbares Foto` : ''}.`;
      await sb.from('import_laeufe').update({ status: 'fertig', beendet_am: jetzt(), log: satz }).eq('id', laufId);
      await quelleLog(sb, quelleId, { status: 'fertig' }, satz);
    }
  } catch (e: any) {
    if (lauf?.id) await sb.from('import_laeufe').update({ status: 'fehler', beendet_am: jetzt(), log: String(e?.message || e) }).eq('id', lauf.id);
    await quelleLog(sb, quelleId, { status: 'fehler' }, String(e?.message || e)).catch(() => {});
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  if (req.method !== 'POST') return res.status(405).json({ error: 'nur POST' });
  if (!process.env.KATALOG_SECRET || req.headers['x-katalog-secret'] !== process.env.KATALOG_SECRET) return res.status(401).json({ error: 'nicht autorisiert' });
  for (const k of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ANTHROPIC_API_KEY', 'FAL_API_KEY'])
    if (!process.env[k]) return res.status(500).json({ error: `${k} fehlt` });
  const { quelleId, schritt = 'entdecken', laufId } = (req.body || {}) as { quelleId?: string; schritt?: string; laufId?: string };
  if (!quelleId) return res.status(400).json({ error: 'quelleId nötig' });
  if (!['entdecken', 'lesen', 'veredeln', 'verknuepfen'].includes(schritt)) return res.status(400).json({ error: 'schritt unbekannt' });
  waitUntil(ablauf(quelleId, schritt, laufId, `https://${req.headers.host}/api/katalog`, start));
  return res.status(202).json({ ok: true, quelleId, schritt });
}
