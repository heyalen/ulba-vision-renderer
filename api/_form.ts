import sharp from 'sharp';

/**
 * api/_form.ts — die eine Wahrheit fuer Silhouetten.
 * Vom Batch-/Debug-Endpunkt (silhouette.ts) UND von der Suche (search.ts)
 * importiert. Der fuehrende Unterstrich haelt Vercel davon ab, die Datei als
 * eigene Route zu bauen. Regel: wer die Profilrechnung aendert, muss die
 * gespeicherten Systemprofile neu rechnen — beide Seiten, eine Regel.
 */

export const BAENDER = 24;

/** v57 — Version der Profilrechnung. Gespeicherte Profile mit kleinerer
 *  Version rechnet search.ts beim naechsten Bildsuchlauf selbst neu. */
export const FORM_VERSION = 3;

export interface Profil {
  seitenverhaeltnis: number;  // Breite / Hoehe der Bounding Box
  fuellgrad: number;          // Flaeche / Bounding Box — rund vs. eckig
  schwerpunkt: number;        // 0 = Masse oben, 1 = Masse unten
  breiten: number[];          // BAENDER Werte, 0..1, relativ zur groessten Breite
  // v57 — Schulterwinkel in Grad: ~90 = flache, kantige Schulter (Zylinder
  // mit Absatz), ~40 = runde, auslaufende Schulter. null = keine Schulter
  // sichtbar (Tiegel mit breitem Deckel) -> zaehlt im Vergleich nicht.
  schulter?: number | null;
  // v57b — Breite, bei der die Schulter endet (0..1). Ueber 0,80 endet sie
  // nicht an einem Hals, sondern an einem breiten Deckel/Gewinde: Tiegel.
  // Gespeichert statt im Profil entschieden, damit eine spaetere Regel-
  // aenderung kein Neurechnen braucht.
  schulterEnde?: number | null;
  v?: number;
}

/**
 * Die Schulter liegt genau in der Zone, die der Kappenschnitt entfernt —
 * deshalb wird sie VOR dem Schnitt am vollen Umriss gemessen. Von der
 * Oberkante des vollen Koerpers (erste Zeile >= 95 % Breite) nach oben, bis
 * die Breite 80 % unterschreitet oder ein Plateau (Hals, Kragen) beginnt.
 * Gemessen wird nur, was beide Seiten zeigen: der Abschnitt 95 -> 80 %
 * liegt bei Flasche mit und ohne Verschluss frei.
 */
function schulterWinkel(
  spannen: Array<[number, number] | null>, minY: number, suchEnde: number, maxB: number, hoehe: number,
): { winkel: number; ende: number } | null {
  const w = (y: number) => { const sp = spannen[y]; return sp ? (sp[1] - sp[0] + 1) / maxB : 0; };
  let yK = -1;
  for (let y = minY; y <= suchEnde; y++) if (w(y) >= 0.95) { yK = y; break; }
  if (yK <= minY) return null;
  const plateau = Math.max(3, Math.round(hoehe * 0.04));
  const wK = w(yK);
  let yE = yK, wE = wK;
  for (let y = yK - 1; y >= minY; y--) {
    const wy = w(y);
    if (wy > wE + 0.03) break;                 // wird wieder breiter: Kragen
    yE = y; wE = Math.min(wE, wy);
    if (wy <= 0.80) break;
    let flach = true;
    for (let k = 1; k <= plateau; k++) {
      if (y - k < minY || Math.abs(w(y - k) - wy) > 0.02) { flach = false; break; }
    }
    if (flach) break;                           // Plateau: Hals erreicht
  }
  const abfall = wK - wE;
  if (abfall < 0.08) return null;               // keine erkennbare Schulter
  const dy = Math.max(0.5, yK - yE) / maxB;     // in Koerperbreiten
  return { winkel: Math.atan2(abfall / 2, dy) * 180 / Math.PI, ende: wE };
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
  const schulter = schulterWinkel(spannen, minY, suchEnde, maxZeilenBreite, hoeheGesamt);

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
    schulter: schulter === null ? null : Math.round(schulter.winkel * 10) / 10,
    schulterEnde: schulter === null ? null : Math.round(schulter.ende * 100) / 100,
    v: FORM_VERSION,
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
  // Nichtlinear: innerhalb einer Familie tolerant (Grossenvarianten,
  // Ausschnitt, Perspektive — bis etwa Faktor 1,7 kostet es wenig), darueber
  // steil, denn dann ist es ein anderer Koerper (LUXEA 1:3,5 gegen NUXE 1:1).
  const svNaehe = sv <= 0.55
    ? 1 - 0.25 * sv / 0.55
    : Math.max(0, 0.75 * (1 - (sv - 0.55) / 0.55));

  const fg = Math.abs(a.fuellgrad - b.fuellgrad);
  const fgNaehe = Math.max(0, 1 - fg / 0.35);

  const sp = Math.abs(a.schwerpunkt - b.schwerpunkt);
  const spNaehe = Math.max(0, 1 - sp / 0.25);

  const basis = profilNaehe * 0.56 + fgNaehe * 0.18 + svNaehe * 0.18 + spNaehe * 0.08;

  // v57 — Schulter: das Breitenprofil sieht sie nicht (Kappenschnitt), also
  // eigener Term. Nur wenn BEIDE Seiten eine messbare Schulter haben —
  // sonst neutral, damit Tiegel und alte Profile nicht bestraft werden.
  // Eine Schulter gibt es nur mit Hals: endet sie ueber 80 % Breite (Tiegel,
  // breiter Deckel), ist sie keine Schulter und zaehlt nicht.
  const echt = (p: Profil) => typeof p.schulter === 'number' && (p.schulterEnde ?? 0) <= 0.80;
  const sa = a.schulter, sb = b.schulter;
  if (echt(a) && echt(b) && typeof sa === 'number' && typeof sb === 'number') {
    // Totzone 20°: Klarglas-Produktfotos und dekorierte Referenzfotos messen
    // dieselbe Schulter systematisch verschieden (Brechung an dicken Waenden,
    // weiche Maskenkanten; NUXE gegen Alexandra). Erst darueber zaehlt es —
    // flach (~80°) gegen rund (~37°) bleibt klar getrennt.
    const schulterNaehe = Math.max(0, 1 - Math.max(0, Math.abs(sa - sb) - 20) / 25);
    return Math.round(100 * (basis * 0.8 + schulterNaehe * 0.2));
  }
  return Math.round(100 * basis);
}

