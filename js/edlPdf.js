// Génération du PDF multi-pages d'un état des lieux rédigé (pièces, éléments,
// photos, compteurs, signatures). Contrairement à PdfBuilder (documents tenant
// sur une page), ce module pagine son contenu au fil de l'eau via ensureSpace(),
// dans l'esprit de RichTextPdf.render(), et récupère les photos depuis FilesDb.
const EdlPdf = (function () {
  const PAGE_W = 595.28; // A4 en pt
  const PAGE_H = 841.89;
  const MARGIN = 56;
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const FOOTER_Y = PAGE_H - 30;

  const VETUSTE_LABELS = {
    neuf: 'Neuf',
    bon: 'Bon état',
    usage: "État d'usage",
    mauvais: 'Mauvais état',
    'hors-service': 'Hors service',
    ns: 'NS (non significatif)',
  };

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function imageDims(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
      img.onerror = () => reject(new Error('image invalide'));
      img.src = dataUrl;
    });
  }

  function fitContain(w, h, maxW, maxH) {
    const scale = Math.min(maxW / w, maxH / h, 1);
    return { w: w * scale, h: h * scale };
  }

  async function loadPhotos(fileEntries) {
    const out = [];
    for (const f of (fileEntries || [])) {
      try {
        const blob = await FilesDb.getFile(f.fileId);
        if (!blob) continue;
        const dataUrl = await blobToDataURL(blob);
        const dims = await imageDims(dataUrl);
        const format = /^data:image\/png/i.test(dataUrl) ? 'PNG' : 'JPEG';
        out.push({ dataUrl, format, width: dims.w, height: dims.h });
      } catch (e) {
        console.error('Photo ignorée dans le PDF (illisible)', e);
      }
    }
    return out;
  }

  function drawLetterhead(doc, ctx) {
    let y = 40;
    doc.setFont('times', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(20);
    doc.text(ctx.sciNom || '', PAGE_W / 2, y, { align: 'center' });
    y += 13;
    doc.setFont('times', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(110);
    const adresseLine = (ctx.sciAdresse || '').replace(/\n/g, ' — ').trim();
    if (adresseLine) {
      doc.text(adresseLine, PAGE_W / 2, y, { align: 'center' });
      y += 11;
    }
    if (ctx.sciSiret) {
      doc.text(`SIRET : ${ctx.sciSiret}`, PAGE_W / 2, y, { align: 'center' });
      y += 11;
    }
    doc.setTextColor(20);
    y += 6;
    doc.setDrawColor(180);
    doc.setLineWidth(0.75);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    return y + 24;
  }

  function ensureSpace(doc, state, needed, ctx) {
    if (state.y + needed > PAGE_H - MARGIN) {
      doc.addPage();
      state.y = drawLetterhead(doc, ctx);
    }
  }

  function writeWrapped(doc, state, text, x, maxWidth, lineHeight, ctx) {
    const lines = doc.splitTextToSize(text, maxWidth);
    lines.forEach((line) => {
      ensureSpace(doc, state, lineHeight, ctx);
      doc.text(line, x, state.y);
      state.y += lineHeight;
    });
  }

  function drawPhotoGrid(doc, state, photos, ctx) {
    if (!photos.length) return;
    const cols = 3;
    const gap = 10;
    const boxW = (CONTENT_W - gap * (cols - 1)) / cols;
    const boxH = 90;
    photos.forEach((p, i) => {
      const col = i % cols;
      if (col === 0) ensureSpace(doc, state, boxH + 8, ctx);
      const x = MARGIN + col * (boxW + gap);
      const y = state.y;
      doc.setDrawColor(210);
      doc.rect(x, y, boxW, boxH);
      try {
        const dims = fitContain(p.width, p.height, boxW - 6, boxH - 6);
        const ix = x + (boxW - dims.w) / 2;
        const iy = y + (boxH - dims.h) / 2;
        doc.addImage(p.dataUrl, p.format, ix, iy, dims.w, dims.h, undefined, 'FAST');
      } catch (e) {
        console.error('Impossible d\'insérer une photo au PDF', e);
      }
      if (col === cols - 1 || i === photos.length - 1) state.y += boxH + 8;
    });
  }

  async function drawElement(doc, state, el, ctx) {
    ensureSpace(doc, state, 16, ctx);
    doc.setFont('times', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(20);
    doc.text(el.nom, MARGIN, state.y);
    const vetusteLabel = VETUSTE_LABELS[el.vetuste] || '';
    if (vetusteLabel) {
      doc.setFont('times', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(90);
      doc.text(vetusteLabel, PAGE_W - MARGIN, state.y, { align: 'right' });
      doc.setTextColor(20);
    }
    state.y += 15;
    if (el.note) {
      doc.setFont('times', 'italic');
      doc.setFontSize(9.5);
      doc.setTextColor(70);
      writeWrapped(doc, state, el.note, MARGIN, CONTENT_W, 12.5, ctx);
      doc.setTextColor(20);
      state.y += 4;
    }
    const photos = await loadPhotos(el.files);
    drawPhotoGrid(doc, state, photos, ctx);
    state.y += 10;
  }

  async function drawRoom(doc, state, room, ctx) {
    ensureSpace(doc, state, 26, ctx);
    doc.setFont('times', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(room.nom, MARGIN, state.y);
    state.y += 8;
    doc.setDrawColor(180);
    doc.setLineWidth(0.75);
    doc.line(MARGIN, state.y, PAGE_W - MARGIN, state.y);
    state.y += 14;
    for (const el of room.elements) {
      await drawElement(doc, state, el, ctx);
    }
    state.y += 6;
  }

  async function drawMeter(doc, state, m, ctx) {
    ensureSpace(doc, state, 16, ctx);
    doc.setFont('times', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(20);
    doc.text(m.numero ? `${m.nom} (N° ${m.numero})` : m.nom, MARGIN, state.y);
    const idxLabel = (m.index === '' || m.index == null) ? 'Non relevé' : `Index relevé : ${m.index}`;
    doc.setFont('times', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(90);
    doc.text(idxLabel, PAGE_W - MARGIN, state.y, { align: 'right' });
    doc.setTextColor(20);
    state.y += 15;
    const photos = await loadPhotos(m.files);
    drawPhotoGrid(doc, state, photos, ctx);
    state.y += 10;
  }

  function drawCover(doc, ctx, y0) {
    let y = y0 + 26;
    doc.setFont('times', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(20);
    const title = ctx.sens === 'sortant' ? 'ÉTAT DES LIEUX DE SORTIE' : "ÉTAT DES LIEUX D'ENTRÉE";
    doc.text(title, PAGE_W / 2, y, { align: 'center' });
    y += 22;
    doc.setFont('times', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(90);
    doc.text(ctx.bienNom || '', PAGE_W / 2, y, { align: 'center' });
    doc.setTextColor(20);
    y += 34;

    const rows = [
      ['Bien concerné', (ctx.bienAdresse || '').replace(/\n/g, ', ') || '—'],
      ['Locataire', ctx.locataireNom || '—'],
      ['Date', ctx.dateLabel || '—'],
    ];
    doc.setFontSize(10);
    rows.forEach(([label, val]) => {
      doc.setFont('times', 'bold');
      doc.text(label + ' :', MARGIN, y);
      doc.setFont('times', 'normal');
      const lines = doc.splitTextToSize(val, CONTENT_W - 140);
      doc.text(lines, MARGIN + 140, y);
      y += Math.max(16, lines.length * 14);
    });
    y += 10;
    doc.setDrawColor(180);
    doc.setLineWidth(0.75);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    y += 26;
    return y;
  }

  function collectEcarts(ctx) {
    const vetusteDiffs = [];
    (ctx.pieces || []).forEach((room) => {
      (room.elements || []).forEach((el) => {
        if (el.vetusteEntree === undefined) return;
        const before = el.vetusteEntree || '';
        const after = el.vetuste || '';
        if (before !== after) vetusteDiffs.push({ room: room.nom, element: el.nom, before, after });
      });
    });
    const meterDiffs = [];
    (ctx.compteurs || []).forEach((m) => {
      if (m.indexEntree === undefined) return;
      const entree = Number(m.indexEntree);
      const sortie = Number(m.index);
      if (m.indexEntree !== '' && m.index !== '' && !Number.isNaN(entree) && !Number.isNaN(sortie)) {
        meterDiffs.push({ nom: m.nom, entree, sortie, conso: sortie - entree });
      }
    });
    const hasComparisonData = (ctx.pieces || []).some((room) => (room.elements || []).some((el) => el.vetusteEntree !== undefined))
      || (ctx.compteurs || []).some((m) => m.indexEntree !== undefined);
    return { vetusteDiffs, meterDiffs, hasComparisonData };
  }

  function drawEcartsSummary(doc, state, ctx) {
    if (ctx.sens !== 'sortant') return;
    const { vetusteDiffs, meterDiffs, hasComparisonData } = collectEcarts(ctx);
    if (!hasComparisonData) return;

    ensureSpace(doc, state, 30, ctx);
    doc.setFont('times', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text("Résumé des écarts avec l'état des lieux d'entrée", MARGIN, state.y);
    state.y += 8;
    doc.setDrawColor(180);
    doc.setLineWidth(0.75);
    doc.line(MARGIN, state.y, PAGE_W - MARGIN, state.y);
    state.y += 16;

    doc.setFontSize(9.5);
    doc.setTextColor(20);
    if (vetusteDiffs.length === 0 && meterDiffs.length === 0) {
      doc.setFont('times', 'normal');
      writeWrapped(doc, state, "Aucun écart de vétusté ou de consommation constaté par rapport à l'état des lieux d'entrée.", MARGIN, CONTENT_W, 13, ctx);
      state.y += 10;
      return;
    }
    if (vetusteDiffs.length) {
      ensureSpace(doc, state, 14, ctx);
      doc.setFont('times', 'bold');
      doc.text('Vétusté', MARGIN, state.y);
      state.y += 14;
      doc.setFont('times', 'normal');
      vetusteDiffs.forEach((d) => {
        const line = `${d.room} — ${d.element} : ${VETUSTE_LABELS[d.before] || 'Non renseigné'} → ${VETUSTE_LABELS[d.after] || 'Non renseigné'}`;
        writeWrapped(doc, state, line, MARGIN, CONTENT_W, 13, ctx);
      });
      state.y += 6;
    }
    if (meterDiffs.length) {
      ensureSpace(doc, state, 14, ctx);
      doc.setFont('times', 'bold');
      doc.text('Compteurs', MARGIN, state.y);
      state.y += 14;
      doc.setFont('times', 'normal');
      meterDiffs.forEach((d) => {
        const line = `${d.nom} : ${d.entree} → ${d.sortie} (consommation : ${d.conso})`;
        writeWrapped(doc, state, line, MARGIN, CONTENT_W, 13, ctx);
      });
      state.y += 6;
    }
    state.y += 10;
  }

  async function drawSignatures(doc, state, ctx) {
    ensureSpace(doc, state, 150, ctx);
    doc.setFont('times', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(20);
    doc.text('Signatures', MARGIN, state.y);
    state.y += 20;

    const gap = 30;
    const colW = (CONTENT_W - gap) / 2;
    const boxH = 100;
    const col2X = MARGIN + colW + gap;

    doc.setFont('times', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(90);
    doc.text('Le bailleur', MARGIN, state.y);
    doc.text('Le locataire', col2X, state.y);
    doc.setTextColor(20);

    const boxY = state.y + 8;
    doc.setDrawColor(200);
    doc.rect(MARGIN, boxY, colW, boxH);
    doc.rect(col2X, boxY, colW, boxH);

    async function placeSignature(dataUrl, boxX) {
      if (!dataUrl) return;
      try {
        const dims = await imageDims(dataUrl);
        const fitted = fitContain(dims.w, dims.h, colW - 20, boxH - 20);
        const ix = boxX + (colW - fitted.w) / 2;
        const iy = boxY + (boxH - fitted.h) / 2;
        const format = /^data:image\/png/i.test(dataUrl) ? 'PNG' : 'JPEG';
        doc.addImage(dataUrl, format, ix, iy, fitted.w, fitted.h, undefined, 'FAST');
      } catch (e) {
        console.error('Impossible d\'insérer une signature au PDF', e);
      }
    }
    await placeSignature(ctx.signatureBailleur, MARGIN);
    await placeSignature(ctx.signatureLocataire, col2X);

    state.y = boxY + boxH + 10;
  }

  function stampFooters(doc, ctx) {
    const total = doc.internal.getNumberOfPages();
    const now = new Date();
    const genLabel = `${ctx.sciNom || ''} — Édité le ${now.toLocaleDateString('fr-FR')} à ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setFont('times', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text(genLabel, MARGIN, FOOTER_Y);
      doc.text(`Page ${p} / ${total}`, PAGE_W - MARGIN, FOOTER_Y, { align: 'right' });
      doc.setTextColor(20);
    }
  }

  async function generate(ctx) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const state = { y: drawLetterhead(doc, ctx) };
    state.y = drawCover(doc, ctx, state.y);
    drawEcartsSummary(doc, state, ctx);
    for (const room of (ctx.pieces || [])) {
      await drawRoom(doc, state, room, ctx);
    }
    if (ctx.compteurs && ctx.compteurs.length) {
      ensureSpace(doc, state, 30, ctx);
      doc.setFont('times', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(20);
      doc.text('Relevé des compteurs', MARGIN, state.y);
      state.y += 8;
      doc.setDrawColor(180);
      doc.setLineWidth(0.75);
      doc.line(MARGIN, state.y, PAGE_W - MARGIN, state.y);
      state.y += 14;
      for (const m of ctx.compteurs) {
        await drawMeter(doc, state, m, ctx);
      }
    }
    await drawSignatures(doc, state, ctx);
    stampFooters(doc, ctx);
    return doc;
  }

  function slug(str) {
    return String(str || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/(^-+|-+$)/g, '')
      .toLowerCase();
  }

  function filename(ctx) {
    const sensSlug = ctx.sens === 'sortant' ? 'sortant' : 'entrant';
    return `etat-des-lieux-${sensSlug}-${slug(ctx.bienNom)}-${ctx.date || 'sans-date'}.pdf`;
  }

  return { generate, filename };
})();
