/* ══════════════════════════════════════════════════════════════════════
   ulba · api/vorschlag.ts — Vorschläge des neuen ulba (Supabase).
   Zwei Aufgaben:
     marke    Website der Marke lesen → Produktlinien als Looks im
              Renderer-Format (wie Design-Welten) → marken + marken_looks
     rendern  alle Teile × Looks eines Vorschlags rendern, mit der
              bestehenden Prompt-Engine (assemblePrompt) und Seedream;
              Renders dauerhaft im Supabase-Speicher (Bucket renders)
   POST, Header x-katalog-secret: <KATALOG_SECRET>
   Body: { aufgabe: 'marke'|'rendern', vorschlagId }
   ══════════════════════════════════════════════════════════════════════ */
import { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { assemblePrompt, falEdit, montiereKomposit, aufWeiss, fetchT, FAL_RATIOS } from './render';

const ZEIT_MS = 200_000;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ulba/1.0; +https://ulba.ai)' };
const db = (): SupabaseClient => createClient(String(process.env.SUPABASE_URL), String(process.env.SUPABASE_SECRET_KEY), { auth: { persistSession: false, autoRefreshToken: false } });
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/* ── Claude ─────────────────────────────────────────────────────────── */
async function claude(model: string, system: string, content: any, max = 3000): Promise<any> {
  for (let v = 0; v < 3; v++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': String(process.env.ANTHROPIC_API_KEY), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: max, temperature: 0, system, messages: [{ role: 'user', content }] }) });
    if (r.status === 429 || r.status === 529) { await new Promise(z => setTimeout(z, 4000 * (v + 1))); continue; }
    const j: any = await r.json();
    if (!r.ok) throw new Error(`Claude ${r.status}: ${String(j?.error?.message || '').slice(0, 200)}`);
    const m = String(j.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Claude ohne JSON');
    return JSON.parse(m[0]);
  }
  throw new Error('Claude überlastet');
}

/* ── Seiten lesen (Jina, Fallback HTML) ─────────────────────────────── */
type Seite = { text: string; links: string[]; bilder: string[]; titel: string };
async function lesen(url: string): Promise<Seite> {
  try {
    const h: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-With-Links-Summary': 'true', 'X-With-Images-Summary': 'true', 'X-Timeout': '30' };
    if (process.env.JINA_API_KEY) h.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
    const r = await fetch('https://r.jina.ai/', { method: 'POST', headers: h, body: JSON.stringify({ url }) });
    const j: any = await r.json();
    if (!r.ok || !j?.data) throw new Error('jina');
    const liste = (x: any): string[] => Array.isArray(x) ? x.map((e: any) => typeof e === 'string' ? e : e?.url || e?.[1]).filter(Boolean) : x && typeof x === 'object' ? Object.values(x).map(String) : [];
    return { text: String(j.data.content || ''), links: liste(j.data.links), bilder: liste(j.data.images), titel: String(j.data.title || '') };
  } catch {
    const r = await fetch(url, { headers: UA });
    const html = await r.text();
    const abs = (x: string) => { try { return new URL(x, r.url || url).href; } catch { return ''; } };
    return {
      text: html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 20000),
      links: [...html.matchAll(/href=["']([^"'#]+)["']/gi)].map(m => abs(m[1])).filter(Boolean),
      bilder: [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => abs(m[1])).filter(Boolean),
      titel: (/<title[^>]*>([^<]*)</i.exec(html)?.[1] || '').trim(),
    };
  }
}

/* ══ MARKE: Website → Looks ═══════════════════════════════════════════ */
const LOOK_SYSTEM = `Du bist Packaging-Designer. Du analysierst die Produktverpackungen EINER Kosmetikmarke anhand von Fotos aus ihrem Shop und beschreibst ihre Designsprache so, dass ein Renderer sie auf ANDERE Packmittel übertragen kann. Nur was die Fotos zeigen. Antworte nur mit JSON.`;
function lookPrompt(marke: string, url: string, text: string) {
  return `Marke: ${marke} (${url})\nText der Website (Auszug):\n${text.slice(0, 3000)}\n
Fasse die Verpackungen in 1 bis 3 klar unterscheidbare Produktlinien (Looks) zusammen. Eine Linie = gemeinsame Farben, Materialien, Finish, Etikett-Stil. Wenn alles gleich aussieht: genau 1 Linie.
JSON: {"marke": "Markenname", "linien": [ {
 "name": "kurzer Linienname auf Deutsch, z.B. «Körperöle» oder «Gesichtspflege weiss»",
 "beschreibung": "1 Satz auf Deutsch: Farben, Material, Verschluss, Etikett",
 "felder": {
  "Body_Behandlung": "klar" | "frosted" | "getoent" | "opak_recolor" | "klar_liquid_farbe",
  "Farbort": "koerper" | "liquid",
  "Body_Hex": "#RRGGBB Hauptfarbe des Behälters (bei Klarglas mit farbigem Inhalt: Farbe des Inhalts)",
  "Cap_Hex": "#RRGGBB Verschlussfarbe",
  "Cap_Finish": "matt" | "glossy" | "brushed" | "metallic",
  "Finish_Body": "matt" | "glossy" | "soft_touch" | "frosted",
  "Akzent_Cue": "kein" | "gold_ring" | "metallic_band" | "praegung",
  "Akzent_Hex": "#RRGGBB oder null",
  "Typo_Haltung": "minimal_klein" | "ingredient_block" | "bold_wordmark" | "ohne",
  "Wirkung_Beschreibung": "2 Sätze Deutsch: Wirkung der Gestaltung",
  "Design_Komponenten": {
   "behaelter": {"farbe": "#RRGGBB oder null", "verlauf": null oder {"von":"#..","nach":"#..","richtung":"vertikal_unten_nach_oben","gewichtung":"..."}, "transparenz": "opak"|"transparent"|"getoent", "produkt_sichtbar": true|false, "finish": "matt"|"glossy"|"metallic", "material_anmutung": "z.B. thick glossy glass, matte plastic"},
   "grafik": {"vorhanden": false, "stil": null, "stil_detail": null, "groesse_prozent": null, "position": null, "beschreibung": "none", "abdeckung": "keine", "traeger": null, "komposition": null, "farbigkeit": null},
   "label": {"vorhanden": true|false, "typ": "uni", "farbe": "#RRGGBB oder null", "abdeckung": "front_panel"|null, "groesse_prozent": Zahl|null, "breite_prozent": Zahl|null, "stil": "z.B. minimal", "form": "z.B. rechteckig scharfkantig", "raender": "randlos", "material_anmutung": "z.B. matte paper"},
   "verschluss": {"farbe": "#RRGGBB", "finish": "matt"|"glossy"|"metallic", "material_anmutung": "z.B. matte plastic"},
   "akzente": [],
   "stimmung": "2-3 englische Wörter",
   "design_dna": "4-5 englische Sätze: Behälterfarbe/Material/Finish, Verschluss, Etikett (Abdeckung in %), Grafik, Gesamtwirkung"
  }
 } } ] }`;
}

async function markeLesen(sb: SupabaseClient, vorschlagId: string) {
  const { data: v } = await sb.from('vorschlaege').select('id, firma_id, marken_url, marke_id').eq('id', vorschlagId).single();
  if (!v?.marken_url) throw new Error('Keine Marken-Adresse');
  const start = (v.marken_url as string).startsWith('http') ? v.marken_url as string : `https://${v.marken_url}`;
  const dom = host(start);
  const { data: vorhanden } = await sb.from('marken').select('id, name').eq('domain', dom).maybeSingle();
  if (vorhanden) {
    const { count } = await sb.from('marken_looks').select('id', { count: 'exact', head: true }).eq('marke_id', vorhanden.id).is('firma_id', null);
    if ((count || 0) > 0) { await sb.from('vorschlaege').update({ marke_id: vorhanden.id }).eq('id', vorschlagId); return; }
  }
  // Startseite + bis zu 2 Shop-/Produktseiten lesen und Produktfotos sammeln
  const s0 = await lesen(start);
  const shop = [...new Set(s0.links.filter(l => host(l) === dom && /\/(products?|produkte?|shop|collections?|kollektion|sortiment|categor|kategorie)/i.test(l)))].slice(0, 2);
  const seiten = [s0, ...(await Promise.all(shop.map(u => lesen(u).catch(() => null)))).filter(Boolean) as Seite[]];
  const bilder = [...new Set(seiten.flatMap(s => s.bilder))]
    .filter(b => /^https?:\/\//.test(b) && /\.(jpe?g|png|webp)(\?|$)/i.test(b) && !/logo|icon|sprite|flag|payment|badge|banner|avatar|1x1|pixel/i.test(b))
    .slice(0, 10);
  if (bilder.length < 2) throw new Error('Auf der Website wurden zu wenige Produktfotos gefunden.');
  const markeName = (s0.titel.split(/[|–\-—:]/)[0] || dom).trim().slice(0, 80);
  const inhalt: any[] = bilder.map(url => ({ type: 'image', source: { type: 'url', url } }));
  inhalt.push({ type: 'text', text: lookPrompt(markeName, start, seiten.map(s => s.text).join('\n\n')) });
  let o: any;
  try { o = await claude('claude-sonnet-4-5', LOOK_SYSTEM, inhalt, 4000); }
  catch { o = await claude('claude-sonnet-4-5', LOOK_SYSTEM, [...inhalt.slice(0, 4), inhalt[inhalt.length - 1]], 4000); } // einzelne Bilder unlesbar → weniger senden
  const linien = (Array.isArray(o.linien) ? o.linien : []).slice(0, 3);
  if (!linien.length) throw new Error('Keine Produktlinien erkannt.');

  let markeId = vorhanden?.id as string | undefined;
  if (!markeId) {
    const { data: m, error } = await sb.from('marken').insert({ name: String(o.marke || markeName).slice(0, 80), domain: dom, status: 'auto' }).select('id').single();
    if (error || !m) throw new Error(`Marke speichern: ${error?.message}`);
    markeId = m.id;
  }
  await sb.from('marken_looks').insert(linien.map((l: any) => ({
    marke_id: markeId, firma_id: null, linie_name: String(l.name || 'Linie').slice(0, 80), quelle: 'gelesen',
    design_komponenten: { ...l.felder, beschreibung: String(l.beschreibung || '').slice(0, 300) },
  })));
  await sb.from('vorschlaege').update({ marke_id: markeId }).eq('id', vorschlagId);
}

/* ══ RENDERN ══════════════════════════════════════════════════════════ */
function seitenverhaeltnis(w: number, h: number): string {
  if (!w || !h) return 'auto';
  let best = 'auto', bestD = Infinity;
  for (const [name, v] of FAL_RATIOS) { const d = Math.abs(Math.log((w / h) / v)); if (d < bestD) { bestD = d; best = name; } }
  return best;
}
const liste = (x: any): string[] => Array.isArray(x) ? x.map(String) : x ? [String(x)] : [];

async function einRender(sb: SupabaseClient, vorschlag: any, pos: any, richtung: any) {
  const sharp = (await import('sharp')).default;
  const { data: teil } = await sb.from('teile').select('*').eq('id', pos.teil_id).single();
  const cap = pos.cap_id ? (await sb.from('teile').select('*').eq('id', pos.cap_id).single()).data : null;
  const { data: look } = await sb.from('marken_looks').select('*').eq('id', richtung.marken_look_id).single();
  if (!teil?.bild_pfad) throw new Error(`${teil?.name || 'Teil'} hat kein Studiofoto`);
  const felder = { ...(look!.design_komponenten as any) };
  if (felder.Design_Komponenten && typeof felder.Design_Komponenten !== 'string') felder.Design_Komponenten = JSON.stringify(felder.Design_Komponenten);
  const code = { id: `look_${look!.id}`, fields: { ...felder, Name: felder.Name || look!.linie_name, Status: 'Aktiv' } };

  const sysFields: Record<string, any> = {
    'Page Titel': teil.name, Material: liste(teil.material), Type: teil.typ || '', Closure: teil.verschluss_art || '',
    Deko_Faehigkeiten: teil.deko_faehigkeiten || [], Neck_Norm: liste(teil.hals), Form: [], Attribute: [],
    ...(teil.render_zonen && Object.keys(teil.render_zonen).length ? { Render_Zonen: JSON.stringify(teil.render_zonen) } : {}),
  };
  const capFields = cap ? { Cap_Name: cap.name, Closure_Type: cap.verschluss_art || '', Material: liste(cap.material), Einfaerbbar: cap.einfaerbbar === true } : null;
  const split = !!cap?.bild_pfad;
  const fall = split ? 'C' : 'A';
  const brief = [look!.linie_name, vorschlag.briefing_text].filter(Boolean).join(' — ');
  const { fullPrompt, basePrompt, capPrompt } = await assemblePrompt(brief, fall, split, sysFields, capFields, code.id, cap?.id ?? null, code);

  const signiert = async (p: string) => (await sb.storage.from('teile').createSignedUrl(p, 900)).data?.signedUrl || '';
  const masse = async (p: string) => { const { data } = await sb.storage.from('teile').download(p); const b = Buffer.from(await data!.arrayBuffer()); const m = await sharp(b).metadata(); return seitenverhaeltnis(m.width || 0, m.height || 0); };
  const [bodyUrl, bodyRatio] = await Promise.all([signiert(teil.bild_pfad), masse(teil.bild_pfad)]);

  let fertig: Buffer, capFertig: Buffer | null = null;
  if (split) {
    const [capUrl, capRatio] = await Promise.all([signiert(cap!.bild_pfad), masse(cap!.bild_pfad)]);
    const [bUrl, cUrl] = await Promise.all([falEdit([bodyUrl], basePrompt, bodyRatio), falEdit([capUrl], capPrompt!, capRatio).catch(() => capUrl)]);
    const [bBuf, cBuf] = await Promise.all([bUrl, cUrl].map(async u => Buffer.from(await (await fetchT(u, { timeoutMs: 45000, label: 'render laden' })).arrayBuffer())));
    capFertig = (await aufWeiss(cBuf)) || cBuf;
    const mont = await montiereKomposit(bBuf, cBuf, `${cap!.verschluss_art || ''} ${cap!.name}`, { skala: null, versatzY: null, crop: null, cropBasiert: false }).catch(() => null);
    fertig = mont?.jpeg || (await aufWeiss(bBuf)) || bBuf;
  } else {
    const u = await falEdit([bodyUrl], fullPrompt, bodyRatio);
    fertig = Buffer.from(await (await fetchT(u, { timeoutMs: 45000, label: 'render laden' })).arrayBuffer());
  }
  const basis = `${vorschlag.firma_id}/${vorschlag.id}/${pos.id}_${richtung.id}`;
  const up = async (p: string, b: Buffer) => { const { error } = await sb.storage.from('renders').upload(p, b, { contentType: 'image/jpeg', upsert: true }); if (error) throw new Error(`Speicher: ${error.message}`); };
  await up(`${basis}.jpg`, fertig);
  if (capFertig) await up(`${basis}_cap.jpg`, capFertig);
  return { bild_pfad: `${basis}.jpg`, cap_pfad: capFertig ? `${basis}_cap.jpg` : null };
}

async function rendern(sb: SupabaseClient, vorschlagId: string, selbst: string, start: number) {
  const { data: v } = await sb.from('vorschlaege').select('*').eq('id', vorschlagId).single();
  if (!v) return;
  const [{ data: pos }, { data: ri }, { data: vorh }] = await Promise.all([
    sb.from('vorschlag_positionen').select('*').eq('vorschlag_id', vorschlagId).order('reihenfolge'),
    sb.from('vorschlag_richtungen').select('*').eq('vorschlag_id', vorschlagId).order('reihenfolge'),
    sb.from('renders').select('position_id, richtung_id, status').eq('vorschlag_id', vorschlagId),
  ]);
  const erledigt = new Set((vorh || []).filter((r: any) => r.status === 'fertig').map((r: any) => `${r.position_id}|${r.richtung_id}`));
  const offen: [any, any][] = [];
  for (const r of ri || []) for (const p of pos || []) if (!erledigt.has(`${p.id}|${r.id}`)) offen.push([p, r]);
  if (!offen.length) return;
  // alle offenen sofort als «läuft» markieren → das Studio zeigt Platzhalter
  await sb.from('renders').upsert(offen.map(([p, r]) => ({ vorschlag_id: vorschlagId, position_id: p.id, richtung_id: r.id, status: 'laeuft', log: null })), { onConflict: 'position_id,richtung_id' });
  let i = 0;
  while (i < offen.length && Date.now() - start < ZEIT_MS) {
    const block = offen.slice(i, i + 3); i += block.length;
    await Promise.all(block.map(async ([p, r]) => {
      try {
        const erg = await einRender(sb, v, p, r);
        await sb.from('renders').update({ ...erg, status: 'fertig', render_version: 'neu-v1', log: null }).eq('position_id', p.id).eq('richtung_id', r.id);
      } catch (e: any) {
        await sb.from('renders').update({ status: 'fehler', log: String(e?.message || e).slice(0, 400) }).eq('position_id', p.id).eq('richtung_id', r.id);
      }
    }));
  }
  if (i < offen.length) await fetch(selbst, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-katalog-secret': String(process.env.KATALOG_SECRET) },
    body: JSON.stringify({ aufgabe: 'rendern', vorschlagId }) }).catch(() => {});
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  if (req.method !== 'POST') return res.status(405).json({ error: 'nur POST' });
  if (!process.env.KATALOG_SECRET || req.headers['x-katalog-secret'] !== process.env.KATALOG_SECRET) return res.status(401).json({ error: 'nicht autorisiert' });
  const { aufgabe, vorschlagId } = (req.body || {}) as { aufgabe?: string; vorschlagId?: string };
  if (!vorschlagId) return res.status(400).json({ error: 'vorschlagId nötig' });
  const sb = db();
  if (aufgabe === 'marke') {
    // Marke lesen dauert 20–60 s: synchron, damit das Studio direkt die Looks zeigen kann
    try { await markeLesen(sb, vorschlagId); return res.status(200).json({ ok: true }); }
    catch (e: any) { return res.status(422).json({ error: String(e?.message || e) }); }
  }
  if (aufgabe === 'rendern') {
    waitUntil(rendern(sb, vorschlagId, `https://${req.headers.host}/api/vorschlag`, start));
    return res.status(202).json({ ok: true });
  }
  return res.status(400).json({ error: 'aufgabe unbekannt' });
}
