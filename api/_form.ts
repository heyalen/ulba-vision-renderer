import sharp from 'sharp';

/**
 * api/_form.ts — die eine Wahrheit fuer Silhouetten.
 * Vom Batch-/Debug-Endpunkt (silhouette.ts) UND von der Suche (search.ts)
 * importiert. Der fuehrende Unterstrich haelt Vercel davon ab, die Datei als
 * eigene Route zu bauen. Regel: wer die Profilrechnung aendert, muss die
 * gespeicherten Systemprofile neu rechnen — beide Seiten, eine Regel.
 */

export const BAENDER = 24;

export interface Profil {
  seitenverhaeltnis: number;  // Breite / Hoehe der Bounding Box
  fuellgrad: number;          // Flaeche / Bounding Box — rund vs. eckig
  schwerpunkt: number;        // 0 = Masse oben, 1 = Masse unten
  breiten: number[];          // BAENDER Werte, 0..1, relativ zur groessten Breite
}

export let letzterFalFehler = '';
export async function falFreistellen(bildUrl: string): Promise<string | null> {
  const r = await fetch('https://fal.run/fal-ai/birefnet/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${process.env.FAL_API_KEY}` },
    body: JSON.stringify({ image_url: bildUrl, model: 'General Use (Light)', refine_foreground: true }),
  });
  if (!r.ok) { letzterFalFehler = `${r.status} ${(await r.text()).slice(0, 160)}`; return null; }
  const j = await r.json();
  return j?.image?.url || null;
}

/** Alphakanal -> Bounding Box -> normalisiertes Breitenprofil. */
export async function profilVonPng(pngUrl: string): Promise<Profil | null> {
  const res = await fetch(pngUrl);
  if (!res.ok) return null;
  const roh = Buffer.from(await res.arrayBuffer());

  // Auf feste Arbeitsbreite bringen, damit die Rechnung unabhaengig von der
  // Aufloesung des Ausgangsbildes ist.
  const { data, info } = await sharp(roh)
    .ensureAlpha()
    .extractChannel('alpha')
    .resize(256, 256, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const B = info.width, H = info.height;

  // Klarglas ist der Normalfall, nicht der Randfall: BiRefNet gibt bei
  // transparentem Material eine halbdurchsichtige Maske zurueck — kraeftige
  // Kanten, schwache Flaeche dazwischen. Mit einer hohen Schwelle zaehlte nur
  // der Rand als Teil, und der Fuellgrad eines Glasflakons fiel auf 0,27.
  // Deshalb: niedrige Schwelle fuer die Raender, und pro Zeile zwischen
  // linkem und rechtem Rand auffuellen. Packmittel-Silhouetten sind konvex —
  // was zwischen den Kanten liegt, gehoert zum Teil, ob man hindurchsieht
  // oder nicht.
  const SCHWELLE = 16;
  const MIN_BREITE = Math.max(2, Math.round(B * 0.015)); // gegen Rauschpixel

  // Pro Zeile die Spanne bestimmen
  const spannen: Array<[number, number] | null> = [];
  for (let y = 0; y < H; y++) {
    let links = -1, rechts = -1;
    for (let x = 0; x < B; x++) {
      if (data[y * B + x] > SCHWELLE) { if (links < 0) links = x; rechts = x; }
    }
    spannen.push(links >= 0 && rechts - links + 1 >= MIN_BREITE ? [links, rechts] : null);
  }

  let minX = B, maxX = -1, minY = H, maxY = -1, flaeche = 0, summeY = 0;
  for (let y = 0; y < H; y++) {
    const sp = spannen[y];
    if (!sp) continue;
    const [links, rechts] = sp;
    if (links < minX) minX = links;
    if (rechts > maxX) maxX = rechts;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const w = rechts - links + 1;
    flaeche += w;
    summeY += w * y;
  }
  if (maxX < 0 || flaeche < 50) return null; // nichts erkannt

  // ── Kappe abtrennen ─────────────────────────────────────────────────
  // Die Kappe ist bei ulba ein EIGENES Teil mit eigener Tabelle. Ein
  // Referenzfoto mit hohem Pumpkopf soll den Koerper finden — welcher
  // Verschluss draufkommt, ist eine zweite, getrennte Frage. Ohne diesen
  // Schnitt belegte ein Pumpkopf elf von 24 Baendern und die Silhouette
  // matchte den Aufsatz statt des Koerpers.
  //
  // Regel: von oben faellt weg, was schmaler als 80 % der breitesten Stelle
  // ist — gesucht nur in der oberen Haelfte, damit konisch zulaufende
  // Koerper nicht versehentlich gekappt werden. Gleiche Regel auf beiden
  // Seiten des Vergleichs, sonst ist er wertlos.
  let maxZeilenBreite = 0;
  for (let y = minY; y <= maxY; y++) {
    const sp = spannen[y];
    if (sp) maxZeilenBreite = Math.max(maxZeilenBreite, sp[1] - sp[0] + 1);
  }
  const hoeheGesamt = maxY - minY + 1;
  let koerperStart = minY;
  const suchEnde = minY + Math.floor(hoeheGesamt * 0.55);
  for (let y = minY; y <= suchEnde; y++) {
    const sp = spannen[y];
    if (sp && sp[1] - sp[0] + 1 >= maxZeilenBreite * 0.8) { koerperStart = y; break; }
    koerperStart = y + 1;
  }
  if (koerperStart >= suchEnde) koerperStart = minY; // keine klare Grenze -> nichts kappen

  // ── Fussartefakte abtrennen ─────────────────────────────────────────
  // Spiegelbild des Kappenschnitts, unten. Klare, dicke Glasboeden (Brigitte)
  // verschluckt BiRefNet auf weissem Grund fast ganz — uebrig bleibt ein
  // schmaler Lichtreflex, der das Profil in einen Stummel (0,16) enden liess
  // und die Hoehe um ein Viertel aufblaehte. Dasselbe gilt fuer Spiegelungen
  // und Schlagschatten unter dem Teil. Was am Fuss schmaler als ein Drittel
  // der breitesten Stelle ist, ist kein Koerper. Gesucht nur im unteren
  // Drittel, damit spitz zulaufende Formen (DROP) nicht beschnitten werden.
  const fussGrenze = maxY - Math.floor(hoeheGesamt * 0.33);
  while (maxY > fussGrenze) {
    const sp = spannen[maxY];
    if (sp && sp[1] - sp[0] + 1 >= maxZeilenBreite * 0.34) break;
    maxY--;
  }

  // Kennzahlen ab hier NUR ueber den Koerper
  minX = B; maxX = -1; flaeche = 0; summeY = 0;
  for (let y = koerperStart; y <= maxY; y++) {
    const sp = spannen[y];
    if (!sp) continue;
    if (sp[0] < minX) minX = sp[0];
    if (sp[1] > maxX) maxX = sp[1];
    const w = sp[1] - sp[0] + 1;
    flaeche += w;
    summeY += w * y;
  }
  if (maxX < 0 || flaeche < 50) return null;
  minY = koerperStart;

  const bw = maxX - minX + 1, bh = maxY - minY + 1;

  // Breitenprofil ueber die Hoehe — das Herzstueck. Eine bauchige Flasche
  // waechst zur Mitte hin, ein Zylinder bleibt flach, ein Tiegel ist kurz
  // und durchgehend breit, eine Schulterflasche springt oben zurueck.
  const breiten: number[] = [];
  let maxBreite = 1;
  for (let i = 0; i < BAENDER; i++) {
    const y0 = minY + Math.floor((i * bh) / BAENDER);
    const y1 = minY + Math.max(y0 - minY + 1, Math.floor(((i + 1) * bh) / BAENDER));
    let breiteste = 0;
    for (let y = y0; y < Math.min(y1, minY + bh); y++) {
      const sp = spannen[y];
      if (sp) breiteste = Math.max(breiteste, sp[1] - sp[0] + 1);
    }
    breiten.push(breiteste);
    if (breiteste > maxBreite) maxBreite = breiteste;
  }

  return {
    seitenverhaeltnis: bw / bh,
    fuellgrad: flaeche / (bw * bh),
    schwerpunkt: (summeY / flaeche - minY) / bh,
    breiten: breiten.map(b => b / maxBreite),
  };
}

/**
 * Aehnlichkeit zweier Silhouetten, 0..100.
 * Das Breitenprofil traegt das meiste — es beschreibt die Formsprache
 * (Schulter, Bauch, Taille, Verjuengung). Seitenverhaeltnis und Fuellgrad
 * trennen zusaetzlich gedrungen von schlank und rund von eckig.
 */
export function aehnlichkeit(a: Profil, b: Profil): number {
  let abstand = 0;
  for (let i = 0; i < BAENDER; i++) abstand += Math.abs(a.breiten[i] - b.breiten[i]);
  const profilNaehe = Math.max(0, 1 - abstand / BAENDER / 0.45);

  const sv = Math.abs(Math.log(Math.max(0.05, a.seitenverhaeltnis) / Math.max(0.05, b.seitenverhaeltnis)));
  // Proportion ist die UNZUVERLAESSIGSTE Groesse: sie haengt an der
  // Groessenvariante (Alexandra 30 ml ist hoeher proportioniert als eine
  // 100-ml-Flasche derselben Linie), am Bildausschnitt und an der
  // Perspektive. Die Familie erkennt man an der Formsprache — Profil und
  // Fuellgrad. Deshalb tolerant und schwach gewichtet.
  const svNaehe = Math.max(0, 1 - sv / 1.4);

  const fg = Math.abs(a.fuellgrad - b.fuellgrad);
  const fgNaehe = Math.max(0, 1 - fg / 0.35);

  const sp = Math.abs(a.schwerpunkt - b.schwerpunkt);
  const spNaehe = Math.max(0, 1 - sp / 0.25);

  return Math.round(100 * (profilNaehe * 0.62 + fgNaehe * 0.2 + svNaehe * 0.1 + spNaehe * 0.08));
}

