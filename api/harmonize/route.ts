import type { VercelRequest, VercelResponse } from '@vercel/node';

const FAL_API_KEY = process.env.FAL_API_KEY!;
const RENDER_SECRET = process.env.RENDER_SECRET!;
const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = 'app0QFyInfhvk66MC';
const TABLE_ID = 'tblB1kWay9TvX3rGv';       // System
const CAP_TABLE_ID = 'tblQvnXPhiKGMoqDp';   // Cap

const BG = { r: 255, g: 255, b: 255, alpha: 1 }; // Weiss
const MARGIN_PCT = 0.06;   // 6 % Luft rundum, damit das Objekt nicht am Rand klebt
const TRIM_THRESHOLD = 12; // Toleranz gegen leichtes Off-White im Rand

const AT_JSON = { Authorization: `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' };

async function birefnet(imageUrl: string): Promise<Buffer> {
  const res = await fetch('https://fal.run/fal-ai/birefnet', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Key ${FAL_API_KEY}`,
    },
    body: JSON.stringify({ image_url: imageUrl, model: 'General Use (Light)' }),
  });
  if (!res.ok) throw new Error(`birefnet: ${res.status} ${await res.text()}`);
  const { image } = await res.json() as { image: { url: string } };
  return Buffer.from(await (await fetch(image.url)).arrayBuffer());
}

// Weissen/transparenten Rand wegschneiden + kleine gleichmaessige weisse Luft rundum.
// Funktioniert fuer birefnet-Cutouts (transparent) UND Roh-Caps (auf Weiss).
async function tightJpg(input: Buffer, sharp: any): Promise<Buffer> {
  let base = input;
  try {
    base = await sharp(input).trim({ threshold: TRIM_THRESHOLD }).toBuffer();
  } catch { /* trim kann bei uniformen Bildern werfen -> Original nutzen */ }
  const meta = await sharp(base).metadata();
  const m = Math.max(2, Math.round(Math.max(meta.width || 0, meta.height || 0) * MARGIN_PCT));
  return sharp(base)
    .extend({ top: m, bottom: m, left: m, right: m, background: BG })
    .flatten({ background: BG })
    .jpeg({ quality: 92 })
    .toBuffer();
}

// Bild in ein (leeres) Attachment-Feld hochladen.
async function uploadAttachment(
  tableId: string, recordId: string, field: string, jpg: Buffer, filename: string
): Promise<void> {
  const res = await fetch(
    `https://content.airtable.com/v0/${BASE_ID}/${recordId}/${field}/uploadAttachment`,
    { method: 'POST', headers: AT_JSON,
      body: JSON.stringify({ contentType: 'image/jpeg', filename, file: jpg.toString('base64') }) }
  );
  if (!res.ok) throw new Error(`upload ${field}: ${res.status} ${await res.text()}`);
}

async function setDone(recordId: string): Promise<void> {
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}/${recordId}`, {
    method: 'PATCH', headers: AT_JSON,
    body: JSON.stringify({ fields: { Vis_Status: 'done' } }),
  });
  if (!res.ok) throw new Error(`Airtable setDone: ${res.status}`);
}

// Alle Caps eines Systems trimmen: Roh aus Cap_Bild -> getrimmt nach Cap_Bild_Harmonisiert.
// sharp only, kein birefnet (Caps liegen auf Weiss) -> quasi kostenlos.
// Non-fatal: ein Cap-Fehler bricht die Base-Harmonisierung nicht ab.
// Idempotent: Caps mit bereits gefuelltem Cap_Bild_Harmonisiert werden uebersprungen.
async function processCaps(systemId: string, sharp: any): Promise<{ ok: number; skip: number; fail: number }> {
  const stats = { ok: 0, skip: 0, fail: 0 };
  const sys = await (await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}/${systemId}`, { headers: AT_JSON })).json();
  const capIds: string[] = sys.fields?.Caps || [];

  for (const capId of capIds) {
    try {
      const cap = await (await fetch(`https://api.airtable.com/v0/${BASE_ID}/${CAP_TABLE_ID}/${capId}`, { headers: AT_JSON })).json();

      // Schon harmonisiert -> ueberspringen.
      if ((cap.fields?.Cap_Bild_Harmonisiert || []).length > 0) { stats.skip++; continue; }

      // Rohbild aus Cap_Bild.
      const att = (cap.fields?.Cap_Bild || [])[0] as { url?: string; filename?: string } | undefined;
      if (!att || !att.url) { stats.skip++; continue; }

      const stem = (att.filename || 'cap').replace(/\.[^.]+$/, '');
      const raw = Buffer.from(await (await fetch(att.url)).arrayBuffer());
      const jpg = await tightJpg(raw, sharp);
      await uploadAttachment(CAP_TABLE_ID, capId, 'Cap_Bild_Harmonisiert', jpg, `${stem}_trim.jpg`);
      stats.ok++;
    } catch (e) {
      stats.fail++;
      console.error('[harmonize cap]', capId, e);
    }
  }
  return stats;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.headers['x-render-secret'] !== RENDER_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { recordId, bildTyp, urlSystem, urlBase } = req.body as {
    recordId: string;
    bildTyp: 'system' | 'base+cap_separat' | 'base_only';
    urlSystem?: string;
    urlBase?: string;
  };

  if (!recordId || !bildTyp) return res.status(400).json({ error: 'Missing recordId or bildTyp' });

  const sharp = (await import('sharp')).default;

  try {
    // Base harmonisieren: birefnet (Hintergrund weg) -> eng trimmen (statt 72%-Canvas).
    const sourceUrl =
      bildTyp === 'system' ? urlSystem :
      bildTyp === 'base+cap_separat' ? urlBase :
      bildTyp === 'base_only' ? urlBase : undefined;

    if (!sourceUrl) return res.status(400).json({ error: 'Missing source URL' });

    const cutout = await birefnet(sourceUrl.trim());
    const jpg = await tightJpg(cutout, sharp);
    await uploadAttachment(TABLE_ID, recordId, 'Bild_Harmonisiert', jpg, `harm_${recordId}_trim.jpg`);
    await setDone(recordId);

    // Caps desselben Systems mit-trimmen (nur bei base+cap_separat, sharp only).
    let caps = { ok: 0, skip: 0, fail: 0 };
    if (bildTyp === 'base+cap_separat') {
      caps = await processCaps(recordId, sharp);
    }

    return res.status(200).json({ ok: true, recordId, caps });

  } catch (err) {
    console.error('[harmonize]', err);
    return res.status(500).json({ error: String(err) });
  }
}
