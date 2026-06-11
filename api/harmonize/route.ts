import type { VercelRequest, VercelResponse } from '@vercel/node';

const FAL_API_KEY = process.env.FAL_API_KEY!;
const RENDER_SECRET = process.env.RENDER_SECRET!;
const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = 'app0QFyInfhvk66MC';
const TABLE_ID = 'tblB1kWay9TvX3rGv';

const BG = { r: 168, g: 188, b: 197, alpha: 1 }; // #A8BCC5
const CANVAS = 800;
const PRODUCT_SCALE = 0.72;

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

async function toCanvas(
  png: Buffer,
  sharp: any,
  cW: number,
  cH: number,
  maxW: number,
  maxH: number,
  offsetX = 0
): Promise<{ buf: Buffer; left: number; top: number }> {
  const { width: oW, height: oH } = await sharp(png).metadata();
  const scale = Math.min(maxW / oW, maxH / oH);
  const w = Math.round(oW * scale);
  const h = Math.round(oH * scale);
  const buf = await sharp(png).resize(w, h).toBuffer();
  const left = offsetX + Math.round((cW - w) / 2);
  const top = Math.round((cH - h) / 2);
  return { buf, left, top };
}

async function buildSingle(png: Buffer, sharp: any): Promise<Buffer> {
  const maxH = Math.round(CANVAS * PRODUCT_SCALE);
  const maxW = Math.round(CANVAS * 0.70);
  const { buf, left, top } = await toCanvas(png, sharp, CANVAS, CANVAS, maxW, maxH);
  return sharp({
    create: { width: CANVAS, height: CANVAS, channels: 4, background: BG },
  })
    .composite([{ input: buf, left, top }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function buildBaseCap(basePng: Buffer, capPng: Buffer, sharp: any): Promise<Buffer> {
  const half = CANVAS / 2;
  const maxH = Math.round(CANVAS * PRODUCT_SCALE);
  const base = await toCanvas(basePng, sharp, half, CANVAS, Math.round(half * 0.65), maxH, 0);
  const cap = await toCanvas(capPng, sharp, half, CANVAS, Math.round(half * 0.50), Math.round(maxH * 0.65), half);
  return sharp({
    create: { width: CANVAS, height: CANVAS, channels: 4, background: BG },
  })
    .composite([
      { input: base.buf, left: base.left, top: base.top },
      { input: cap.buf, left: cap.left, top: cap.top },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function uploadAirtable(recordId: string, field: string, jpg: Buffer, filename: string): Promise<void> {
  const res = await fetch(
    `https://content.airtable.com/v0/${BASE_ID}/${recordId}/${field}/uploadAttachment`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contentType: 'image/jpeg', filename, file: jpg.toString('base64') }),
    }
  );
  if (!res.ok) throw new Error(`Airtable upload: ${res.status} ${await res.text()}`);
}

async function setDone(recordId: string): Promise<void> {
  const res = await fetch(
    `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}/${recordId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: { Vis_Status: 'done' } }),
    }
  );
  if (!res.ok) throw new Error(`Airtable setDone: ${res.status}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.headers['x-render-secret'] !== RENDER_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { recordId, bildTyp, urlSystem, urlBase, urlCap } = req.body as {
    recordId: string;
    bildTyp: 'system' | 'base+cap_separat' | 'base_only';
    urlSystem?: string;
    urlBase?: string;
    urlCap?: string;
  };

  if (!recordId || !bildTyp) return res.status(400).json({ error: 'Missing recordId or bildTyp' });

  const sharp = (await import('sharp')).default;

  try {
    if (bildTyp === 'system' && urlSystem) {
      const png = await birefnet(urlSystem.trim());
      const jpg = await buildSingle(png, sharp);
      await uploadAirtable(recordId, 'Bild_Harmonisiert', jpg, `harm_${recordId}.jpg`);

    } else if (bildTyp === 'base+cap_separat' && urlBase && urlCap) {
      const [basePng, capPng] = await Promise.all([
        birefnet(urlBase.trim()),
        birefnet(urlCap.trim()),
      ]);
      const jpg = await buildBaseCap(basePng, capPng, sharp);
      await uploadAirtable(recordId, 'Bild_Harmonisiert', jpg, `harm_${recordId}.jpg`);

    } else if (bildTyp === 'base_only' && urlBase) {
      const png = await birefnet(urlBase.trim());
      const jpg = await buildSingle(png, sharp);
      await uploadAirtable(recordId, 'Bild_Harmonisiert', jpg, `harm_${recordId}.jpg`);

    } else {
      return res.status(400).json({ error: 'Missing required URL fields for bildTyp' });
    }

    await setDone(recordId);
    return res.status(200).json({ ok: true, recordId });

  } catch (err) {
    console.error('[harmonize]', err);
    return res.status(500).json({ error: String(err) });
  }
}
