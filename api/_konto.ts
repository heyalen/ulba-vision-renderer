/* ulba · api/_konto.ts — Konten und Kontingente (v78)
   ──────────────────────────────────────────────────────────────────────
   Drei Aufgaben, eine Datei:
   1. Clerk-Token pruefen (wer ist angemeldet?) — ohne Zusatz-Paket,
      Signatur-Pruefung direkt gegen Clerks oeffentliche Schluessel (JWKS).
   2. Freie Kontingente fuer anonyme Besucher — signiertes Cookie
      (3 Suchen, 2 Renders), HMAC mit KONTO_SECRET/RENDER_SECRET.
   3. Monats-Zaehler fuer angemeldete Nutzer — Tabelle `Nutzer` in
      Airtable (eine Zeile pro Nutzer und Monat, 5 Renders frei).

   Sicherheits-Schalter: Ohne CLERK_PUBLISHABLE_KEY in der Umgebung ist
   KONTO_AKTIV false und NICHTS hier greift — die API verhaelt sich exakt
   wie vor v78. So bricht ein Deploy nie das alte Frontend. Zaehler sind
   fail-open: faellt Airtable oder das Cookie aus, wird NIE geblockt. */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

export const FREI_SUCHEN = 3;        // anonyme Suchen, danach Anmelde-Wand
// ⚠️ TESTPHASE (28.10.2026, Alen): alle Render-Limits auf 500.
// VOR GO-LIVE ZURUECK auf: FREI_RENDERS 2 · RENDERS_PRO_MONAT 5 · IP_RENDERS_PRO_TAG 6
// (und lib/konto.tsx im Frontend: FREI_RENDERS + RENDERS_PRO_MONAT).
export const FREI_RENDERS = 500;     // anonyme frische Renders (Cache zaehlt nie) — live: 2
export const RENDERS_PRO_MONAT = 500; // kostenloses Konto — live: 5

export const KONTO_AKTIV = !!process.env.CLERK_PUBLISHABLE_KEY;

const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const NUTZER_TABLE = 'tblK9RiWUXOHlrd1d'; // Nutzer

export type Konto = { userId: string; email: string | null };

/* ── 1. Clerk-Token pruefen ─────────────────────────────────────────── */

// Der Publishable Key traegt die Frontend-API-Domain (base64, mit $ am Ende):
// pk_test_Zm9vLWJhci0xMi5jbGVyay5hY2NvdW50cy5kZXYk → foo-bar-12.clerk.accounts.dev
function clerkDomain(): string | null {
  const m = String(process.env.CLERK_PUBLISHABLE_KEY || '').match(/^pk_(test|live)_(.+)$/);
  if (!m) return null;
  try {
    const dom = Buffer.from(m[2], 'base64').toString('utf8').replace(/\$$/, '').trim();
    return /^[a-z0-9.-]+$/i.test(dom) ? dom : null;
  } catch { return null; }
}

let jwksCache: { keys: any[]; bis: number } | null = null;
async function jwks(): Promise<any[]> {
  if (jwksCache && Date.now() < jwksCache.bis) return jwksCache.keys;
  const dom = clerkDomain();
  if (!dom) return [];
  try {
    const r = await fetch(`https://${dom}/.well-known/jwks.json`);
    if (!r.ok) return jwksCache?.keys || [];
    const d: any = await r.json();
    jwksCache = { keys: Array.isArray(d?.keys) ? d.keys : [], bis: Date.now() + 3600_000 };
    return jwksCache.keys;
  } catch { return jwksCache?.keys || []; }
}

/* Liest `Authorization: Bearer <JWT>` und prueft Signatur + Ablauf.
   Ungueltig oder fehlend → null (= anonym). Wirft nie. */
export async function kontoAusRequest(req: VercelRequest): Promise<Konto | null> {
  if (!KONTO_AKTIV) return null;
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return null;
  const teile = auth.slice(7).trim().split('.');
  if (teile.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(teile[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(teile[1], 'base64url').toString('utf8'));
    if (header.alg !== 'RS256') return null;
    const keys = await jwks();
    const jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) return null;
    const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' } as any);
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${teile[0]}.${teile[1]}`),
      pub,
      Buffer.from(teile[2], 'base64url'),
    );
    if (!ok) return null;
    const jetzt = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < jetzt - 30) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > jetzt + 30) return null;
    const userId = String(payload.sub || '');
    if (!userId) return null;
    // email kommt nur mit, wenn im Clerk-Dashboard als Custom Claim gesetzt — optional.
    return { userId, email: typeof payload.email === 'string' ? payload.email : null };
  } catch { return null; }
}

/* ── 2. Freie Kontingente (anonym, signiertes Cookie) ───────────────── */

export type Frei = { s: number; r: number }; // Suchen, Renders

const COOKIE = 'ulba_frei';
const geheim = () => process.env.KONTO_SECRET || process.env.RENDER_SECRET || '';
const sig = (d: string) => crypto.createHmac('sha256', geheim()).update(d).digest('base64url');

export function liesFrei(req: VercelRequest): Frei {
  if (!geheim()) return { s: 0, r: 0 };
  const roh = String(req.headers.cookie || '')
    .split(/;\s*/)
    .find(c => c.startsWith(COOKIE + '='))
    ?.slice(COOKIE.length + 1) || '';
  const [d, s] = roh.split('.');
  if (!d || !s || sig(d) !== s) return { s: 0, r: 0 };
  try {
    const v = JSON.parse(Buffer.from(d, 'base64url').toString('utf8'));
    return { s: Math.max(0, Number(v.s) | 0), r: Math.max(0, Number(v.r) | 0) };
  } catch { return { s: 0, r: 0 }; }
}

export function schreibeFrei(res: VercelResponse, frei: Frei): void {
  if (!geheim()) return;
  const d = Buffer.from(JSON.stringify(frei)).toString('base64url');
  // SameSite=None: das Cookie gehoert zur Renderer-Domain, die Seite laeuft
  // auf der ulba-Domain — das Frontend sendet mit credentials:'include'.
  res.setHeader('Set-Cookie', `${COOKIE}=${d}.${sig(d)}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=None`);
}

/* ── 3. Monats-Zaehler (angemeldet, Airtable `Nutzer`) ──────────────── */

/* Zaehlt einen frischen Render gegen ein Kontingent in `Nutzer`
   (eine Zeile pro Schluessel und Periode) und zaehlt gleich hoch.
   Fail-open: jeder Airtable-Fehler laesst den Render durch. */
async function zaehle(id: string, periode: string, limit: number, email: string | null): Promise<{ ok: boolean; genutzt: number; limit: number }> {
  const pat = process.env.AIRTABLE_PAT || '';
  if (!pat) return { ok: true, genutzt: 0, limit };
  try {
    const sauber = id.replace(/['\\]/g, '');
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${NUTZER_TABLE}`;
    const formel = encodeURIComponent(`AND({Clerk_ID}='${sauber}',{Monat}='${periode}')`);
    const kopf = { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' };
    const r = await fetch(`${url}?filterByFormula=${formel}&maxRecords=1`, { headers: kopf });
    if (!r.ok) return { ok: true, genutzt: 0, limit };
    const d: any = await r.json();
    const rec = d?.records?.[0];
    const genutzt = rec ? Math.max(0, Number(rec.fields?.Renders) || 0) : 0;
    if (genutzt >= limit) return { ok: false, genutzt, limit };
    if (rec) {
      await fetch(`${url}/${rec.id}`, {
        method: 'PATCH', headers: kopf,
        body: JSON.stringify({ fields: { Renders: genutzt + 1, ...(email ? { Email: email } : {}) } }),
      });
    } else {
      await fetch(url, {
        method: 'POST', headers: kopf,
        body: JSON.stringify({ fields: {
          Clerk_ID: sauber, Monat: periode, Renders: 1,
          Erstellt: new Date().toISOString(),
          ...(email ? { Email: email } : {}),
        } }),
      });
    }
    return { ok: true, genutzt: genutzt + 1, limit };
  } catch { return { ok: true, genutzt: 0, limit }; }
}

/* Monats-Kontingent fuer angemeldete Nutzer. */
export function renderKontingent(konto: Konto) {
  return zaehle(konto.userId, new Date().toISOString().slice(0, 7), RENDERS_PRO_MONAT, konto.email);
}

/* v80: Server-Riegel fuer anonyme Renders, unabhaengig vom Cookie.
   Safari/iOS blockt das Frei-Cookie (Drittanbieter) — ohne diesen Zaehler
   reichte localStorage-Loeschen fuer unbegrenzte Gratis-Renders. Pro IP
   und Tag; die IP wird gehasht gespeichert (kein Klartext in Airtable).
   Grosszuegiger als FREI_RENDERS, weil Buero-/Mobilfunk-IPs geteilt sind. */
export const IP_RENDERS_PRO_TAG = 500; // TESTPHASE — live: 6
export function ipRenderKontingent(req: VercelRequest) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unbekannt';
  const hash = crypto.createHash('sha256').update(ip + '|' + geheim()).digest('hex').slice(0, 24);
  return zaehle('ip:' + hash, new Date().toISOString().slice(0, 10), IP_RENDERS_PRO_TAG, null);
}
