// Pfad: ulba-vision-renderer/app/api/harmonize/route.ts
// Vercel Serverless — Node.js Runtime (nicht Edge!)
export const runtime = 'nodejs';

import type { NextRequest } from 'next/server';

const FAL_API_KEY = process.env.FAL_API_KEY!;
const RENDER_SECRET = process.env.RENDER_SECRET!;
const AIRTABLE_PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = 'app0QFyInfhvk66MC';
const TABLE_ID = 'tblB1kWay9TvX3rGv';

const BG = { r: 168, g: 188, b: 197, alpha: 1 }; // #A8BCC5
const CANVAS = 800;
const PRODUCT_SCALE = 0.72;

// fal.ai birefnet — Hintergrund entfernen → PNG mit Transparenz
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

// Produkt auf Canvas platzieren (zentriert, skaliert)
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

// Pfad A + C: 1 Produkt zentriert auf Canvas
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

// Pfad B: Base links + Cap rechts auf einem Canvas
async function buildBaseCap(basePng: Buffer, capPng: Buffer, sharp: any): Promise<Buffer> {
  const half = CANVAS / 2; // 400px pro Seite
  const maxH = Math.round(CANVAS * PRODUCT_SCALE);

  // Base: linke Hälfte, max 65% der halben Breite
  const base = await toCanvas(basePng, sharp, half, CANVAS, Math.round(half * 0.65), maxH, 0);
  // Cap: rechte Hälfte, max 50% der halben Breite (Caps sind kleiner)
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

// Airtable: Bild hochladen via content.airtable.com
async function uploadAirtable(
  recordId: string,
  field: string,
  jpg: Buffer,
  filename: string
): Promise<void> {
  const res = await fetch(
    `https://content.airtable.com/v0/${BASE_ID}/${recordId}/${field}/uploadAttachment`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contentType: 'image/jpeg',
        filename,
        file: jpg.toString('base64'),
      }),
    }
  );
  if (!res.ok) throw new Error(`Airtable upload: ${res.status} ${await res.text()}`);
}

// Airtable: Vis_Status → done
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

export async function POST(req: NextRequest) {
  if (req.headers.get('x-render-secret') !== RENDER_SECRET)
    return new Response('Unauthorized', { status: 401 });

  const { recordId, bildTyp, urlSystem, urlBase, urlCap } = await req.json() as {
    recordId: string;
    bildTyp: 'system' | 'base+cap_separat' | 'base_only';
    urlSystem?: string;
    urlBase?: string;
    urlCap?: string;
  };

  if (!recordId || !bildTyp)
    return new Response('Missing recordId or bildTyp', { status: 400 });

  // sharp dynamisch importieren (Vercel Serverless)
  const sharp = (await import('sharp')).default;

  try {
    if (bildTyp === 'system' && urlSystem) {
      const png = await birefnet(urlSystem.trim());
      const jpg = await buildSingle(png, sharp);
      await uploadAirtable(recordId, 'Bild_Harmonisiert', jpg, `harm_${recordId}.jpg`);

    } else if (bildTyp === 'base+cap_separat' && urlBase && urlCap) {
      // Beide Bilder parallel freistellen → spart ~50% Zeit
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
      return new Response('Missing required URL fields for bildTyp', { status: 400 });
    }

    await setDone(recordId);
    return new Response(JSON.stringify({ ok: true, recordId }), { status: 200 });

  } catch (err) {
    console.error('[harmonize]', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}
