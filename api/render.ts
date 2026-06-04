import { VercelRequest, VercelResponse } from '@vercel/node';

const AIRTABLE_BASE = 'app0QFyInfhvk66MC';
const CACHE_TABLE = 'tblsOp1WKPGIquBKQ';

export default async function handler(req: VercelRequest, res: VercelResponse) {
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 if (req.method === 'OPTIONS') return res.status(200).end();
 if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

 const { systemId, query, imageUrl } = req.body as { systemId: string; query: string; imageUrl: string };
 if (!systemId || !query || !imageUrl) {
   return res.status(400).json({ error: 'systemId, query und imageUrl sind erforderlich' });
 }

 try {
   // 1. Query → Rendering-Prompt via Claude Haiku
   const promptRes = await fetch('https://api.anthropic.com/v1/messages', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'x-api-key': process.env.ANTHROPIC_API_KEY || '',
       'anthropic-version': '2023-06-01',
     },
     body: JSON.stringify({
       model: 'claude-haiku-4-5',
       max_tokens: 200,
       system: `You are a beauty packaging design specialist.
Translate a brand brief into a precise image-editing prompt for FLUX.1 Kontext.
The prompt describes ONLY color and finish — NEVER the shape or form.
Reply ONLY with the prompt text, nothing else before or after.
Max 60 words. Language: English.
Always start with: "Keep exact shape and form unchanged. Change only color and finish:"`,
       messages: [{ role: 'user', content: query }],
     }),
   });
   const promptData = await promptRes.json() as { content: Array<{ text: string }> };
   const renderingPrompt = promptData.content[0].text.trim();

   // 2. FLUX.1 Kontext Pro via fal.ai
   const falRes = await fetch('https://fal.run/fal-ai/flux-pro/kontext', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'Authorization': `Key ${process.env.FAL_API_KEY}`,
     },
     body: JSON.stringify({
       image_url: imageUrl,
       prompt: renderingPrompt,
       guidance_scale: 3.5,
       num_inference_steps: 28,
       output_format: 'jpeg',
     }),
   });

   if (!falRes.ok) {
     const err = await falRes.text();
     throw new Error(`fal.ai Fehler: ${err}`);
   }

   const falData = await falRes.json() as { images: Array<{ url: string }> };
   const renderingUrl = falData.images?.[0]?.url;
   if (!renderingUrl) throw new Error('Kein Bild von fal.ai zurückgekommen');

   // 3. In Airtable Rendering_Cache speichern
   const cacheRes = await fetch(
     `https://api.airtable.com/v0/${AIRTABLE_BASE}/${CACHE_TABLE}`,
     {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'Authorization': `Bearer ${process.env.AIRTABLE_PAT}`,
       },
       body: JSON.stringify({
         fields: {
           System: [{ id: systemId }],
           Query_Input: query,
           Rendering_Prompt: renderingPrompt,
           Bild: [{ url: renderingUrl }],
           Created_At: new Date().toISOString(),
         },
       }),
     }
   );

   const cacheData = await cacheRes.json() as { id: string };

   return res.status(200).json({
     renderingUrl,
     renderingPrompt,
     cacheId: cacheData.id,
   });

 } catch (err) {
   const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
   console.error('Render error:', message);
   return res.status(500).json({ error: message });
 }
}