// 3. Bild downloaden
   const imgRes = await fetch(renderingUrl);
   const imgBuffer = await imgRes.arrayBuffer();
   const base64 = Buffer.from(imgBuffer).toString('base64');

   // 4. Airtable Record erstellen (ohne Bild zuerst)
   const createRes = await fetch(
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
           Created_At: new Date().toISOString(),
         },
       }),
     }
   );
   const createData = await createRes.json() as { id: string };
   const recordId = createData.id;

   // 5. Bild als base64 in den Record uploaden
   const fieldId = 'fldFd5qi64yELhKna'; // Bild-Feld ID
   await fetch(
     `https://content.airtable.com/v0/${AIRTABLE_BASE}/${recordId}/${fieldId}/uploadAttachment`,
     {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'Authorization': `Bearer ${process.env.AIRTABLE_PAT}`,
       },
       body: JSON.stringify({
         contentType: 'image/jpeg',
         file: base64,
         filename: `rendering_${systemId}_${Date.now()}.jpg`,
       }),
     }
   );

   return res.status(200).json({
     renderingUrl,
     renderingPrompt,
     cacheId: recordId,
   });
