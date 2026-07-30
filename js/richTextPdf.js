// Conversion d'un éditeur "contenteditable" (gras/italique/souligné, paragraphes,
// listes à puces) vers du texte jsPDF. Heuristique : un paragraphe est considéré
// gras/italique/souligné seulement si TOUT son texte l'est (les titres d'articles
// rédigés en gras sur une ligne entière, cas le plus courant, sont donc préservés).
const RichTextPdf = (function () {
  function extractBlocks(root) {
    const blocks = [];
    let pendingInline = [];

    const flushPending = () => {
      if (pendingInline.length) {
        const wrapper = document.createElement('div');
        pendingInline.forEach((n) => wrapper.appendChild(n.cloneNode(true)));
        blocks.push({ kind: 'p', el: wrapper });
        pendingInline = [];
      }
    };

    Array.from(root.childNodes).forEach((node) => {
      const tag = node.nodeType === 1 ? node.tagName : null;
      if (tag === 'P' || tag === 'DIV') {
        flushPending();
        blocks.push({ kind: 'p', el: node });
      } else if (tag === 'UL' || tag === 'OL') {
        flushPending();
        Array.from(node.children).forEach((li) => {
          if (li.tagName === 'LI') blocks.push({ kind: 'li', el: li });
        });
      } else if (tag === 'BR') {
        flushPending();
        blocks.push({ kind: 'p', el: document.createElement('span') });
      } else {
        pendingInline.push(node);
      }
    });
    flushPending();
    return blocks;
  }

  function hasAncestorTag(node, root, tags) {
    let el = node.parentElement;
    while (el && el !== root) {
      if (tags.indexOf(el.tagName) !== -1) return true;
      el = el.parentElement;
    }
    return false;
  }

  function analyzeBlock(blockEl) {
    let bold = null;
    let italic = null;
    let underline = null;
    let text = '';

    function walk(node) {
      if (node.nodeType === 3) {
        const t = node.textContent;
        if (t === '') return;
        text += t;
        if (t.trim() === '') return;
        const b = hasAncestorTag(node, blockEl, ['B', 'STRONG']);
        const i = hasAncestorTag(node, blockEl, ['I', 'EM']);
        const u = hasAncestorTag(node, blockEl, ['U']);
        bold = bold === null ? b : (bold && b);
        italic = italic === null ? i : (italic && i);
        underline = underline === null ? u : (underline && u);
      } else if (node.nodeType === 1) {
        if (node.tagName === 'BR') { text += '\n'; return; }
        Array.from(node.childNodes).forEach(walk);
      }
    }
    walk(blockEl);

    return {
      text: text.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim(),
      bold: !!bold,
      italic: !!italic,
      underline: !!underline,
    };
  }

  function isEmpty(root) {
    return extractBlocks(root).every((b) => analyzeBlock(b.el).text === '');
  }

  function render(doc, root, opts) {
    const {
      x = 56,
      y0 = 60,
      maxWidth = 483,
      lineHeight = 15,
      fontFamily = 'times',
      fontSize = 10.5,
      pageHeight = 841.89,
      topMargin = 56,
      bottomMargin = 56,
    } = opts || {};

    let y = y0;
    const blocks = extractBlocks(root);

    function setStyle(bold, italic) {
      const style = bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal';
      doc.setFont(fontFamily, style);
      doc.setFontSize(fontSize);
    }

    function ensureSpace(next, bold, italic) {
      if (y + next > pageHeight - bottomMargin) {
        doc.addPage();
        y = topMargin;
        setStyle(bold, italic);
      }
    }

    blocks.forEach((block) => {
      const { text, bold, italic, underline } = analyzeBlock(block.el);
      setStyle(bold, italic);

      const indent = block.kind === 'li' ? 14 : 0;
      const availWidth = maxWidth - indent;

      if (!text) {
        y += lineHeight * 0.6;
        return;
      }

      const rawLines = text.split('\n');
      rawLines.forEach((rawLine, i) => {
        const prefix = block.kind === 'li' && i === 0 ? '•  ' : '';
        const wrapped = doc.splitTextToSize(prefix + rawLine, availWidth);
        wrapped.forEach((lineStr) => {
          ensureSpace(lineHeight, bold, italic);
          const lx = x + indent;
          doc.text(lineStr, lx, y);
          if (underline && lineStr.trim()) {
            const w = doc.getTextWidth(lineStr);
            doc.setDrawColor(20, 20, 20);
            doc.setLineWidth(0.5);
            doc.line(lx, y + 2, lx + w, y + 2);
          }
          y += lineHeight;
        });
      });
    });

    return y;
  }

  return { render, isEmpty };
})();
