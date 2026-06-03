import type { VercelRequest, VercelResponse } from '@vercel/node';

const BASE_ID = 'app0QFyInfhvk66MC';
const SYSTEM_TABLE = 'tblB1kWay9TvX3rGv';
const WELTEN_TABLE = 'tblArmvDVVBbCeuhM';

const SLUG_TO_FIELD: Record<string, string> = {
  'welt_01_pink_genz':        'Vis_1_Pink_GenZ',
  'welt_02_forest_natural':   'Vis_2_Forest_Natural',
  'welt_03_white_minimal':    'Vis_3_White_Minimal',
  'welt_04_black_tech':       'Vis_4_Black_Tech',
  'welt_05_amber_apothecary': 'Vis_5_Amber_Apothecary',
};

type Result = { welt: string; status: 'success'|'error'|'skipped'; error?: string; durationMs?: number; };

async function renderOneWelt(
  systemId: string, bildRohUrl: string, slug: string, prompt: string,
  openrouterKey: string, airtablePat: string
): Promise<Result> {
  const fieldName = SLUG_TO_FIELD[slug];
  if (!fieldName) return { welt: slug, status: 'skipped', error: 'no field mapping' };
  const start = Date.now();
  try {
    const orResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ulba.ai',
        'X-Title': 'ulba.ai Vision Rendering',
      },
      body: JSON.stringify({
        model: 'bytedance-seed/seedream-4.5',
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: bildRohUrl } },
        ]}],
        modalities: ['image'],
      }),
    });
    if (!orResp.ok) throw new Error(`OpenRouter ${orResp.status}: ${(await orResp.text()).substring(0,300)}`);
    const orData: any = await orResp.json();
    const dataUrl = orData?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!dataUrl || typeof dataUrl !== 'string') throw new Error('No image in OpenRouter response');
    const base64 = dataUrl.split(';base64,')[1];
    if (!base64) throw new Error('Could not extract base64');

    const upResp = await fetch(
      `https://content.airtable.com/v0/${BASE_ID}/${systemId}/${fieldName}/uploadAttachment`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${airtablePat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: 'image/png', file: base64, filename: `${slug}.png` }),
      }
    );
    if (!upResp.ok) throw new Error(`Airtable upload ${upResp.status}: ${(await upResp.text()).substring(0,300)}`);
    return { welt: slug, status: 'success', durationMs: Date.now() - start };
  } catch (e: any) {
    return { welt: slug, status: 'error', error: e.message, durationMs: Date.now() - start };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const expectedSecret = process.env.RENDER_SECRET;
  if (expectedSecret && req.headers.authorization !== `Bearer ${expectedSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { systemId } = (req.body || {}) as { systemId?: string };
  if (!systemId || !systemId.startsWith('rec')) return res.status(400).json({ error: 'systemId (rec...) required' });

  const { OPENROUTER_API_KEY, AIRTABLE_PAT } = process.env;
  if (!OPENROUTER_API_KEY || !AIRTABLE_PAT) return res.status(500).json({ error: 'Missing env vars' });

  const airHeaders = { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' };

  try {
    const sysResp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${SYSTEM_TABLE}/${systemId}`, { headers: airHeaders });
    if (!sysResp.ok) throw new Error(`System fetch ${sysResp.status}`);
    const system: any = await sysResp.json();
    const bildRoh = system.fields?.['Bild_Roh'];
    const bildRohUrl = Array.isArray(bildRoh) && bildRoh[0]?.url ? bildRoh[0].url : null;
    if (!bildRohUrl) throw new Error('System has no Bild_Roh');

    await fetch(`https://api.airtable.com/v0/${BASE_ID}/${SYSTEM_TABLE}/${systemId}`, {
      method: 'PATCH', headers: airHeaders,
      body: JSON.stringify({ fields: { Vis_Status: 'generating' }, typecast: true }),
    });

    const wResp = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${WELTEN_TABLE}?filterByFormula=${encodeURIComponent('{Active}=TRUE()')}`,
      { headers: airHeaders }
    );
    if (!wResp.ok) throw new Error(`Welten fetch ${wResp.status}`);
    const wData: any = await wResp.json();

    const results = await Promise.all(wData.records.map((w: any) => {
      const slug = w.fields?.['Welt_Slug'];
      const prompt = w.fields?.['Welt_Rendering_Prompt_Seedream'];
      if (!slug || !prompt) return Promise.resolve<Result>({ welt: slug || '?', status: 'skipped', error: 'missing slug or prompt' });
      return renderOneWelt(systemId, bildRohUrl, slug, prompt, OPENROUTER_API_KEY, AIRTABLE_PAT);
    }));

    const allOk = results.every(r => r.status !== 'error');
    await fetch(`https://api.airtable.com/v0/${BASE_ID}/${SYSTEM_TABLE}/${systemId}`, {
      method: 'PATCH', headers: airHeaders,
      body: JSON.stringify({ fields: { Vis_Status: allOk ? 'done' : 'error' }, typecast: true }),
    });

    return res.status(200).json({ systemId, success: allOk, results });
  } catch (e: any) {
    fetch(`https://api.airtable.com/v0/${BASE_ID}/${SYSTEM_TABLE}/${systemId}`, {
      method: 'PATCH', headers: airHeaders,
      body: JSON.stringify({ fields: { Vis_Status: 'error' }, typecast: true }),
    }).catch(() => {});
    return res.status(500).json({ error: e.message, systemId });
  }
}
