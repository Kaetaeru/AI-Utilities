const escapeXml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

export function screenToSvg(screen) {
  const depthOf = (node) => { let depth = 0; let parentId = node.parentId; const seen = new Set(); while (parentId && !seen.has(parentId) && depth < 20) { seen.add(parentId); const parent = screen.nodes.find((item) => item.id === parentId); if (!parent) break; depth += 1; parentId = parent.parentId; } return depth; };
  const nodes = screen.nodes.filter((node) => !node.hidden).map((node, index) => ({ node, index, depth: depthOf(node) })).sort((a, b) => a.depth - b.depth || Number(b.node.type === 'frame') - Number(a.node.type === 'frame') || a.index - b.index).map((entry) => entry.node);
  const content = nodes.map(nodeToSvg).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${screen.width}" height="${screen.height}" viewBox="0 0 ${screen.width} ${screen.height}">
  <rect width="100%" height="100%" fill="${escapeXml(screen.background || '#ffffff')}"/>
${content}
</svg>`;
}

function nodeToSvg(node) {
  const { x, y, width, height } = node.bounds;
  const style = node.style || {};
  const fill = style.fill || 'transparent';
  const stroke = style.stroke || 'transparent';
  const radius = Number(style.radius || 0);
  const borderWidth = Math.max(0, Number(style.borderWidth ?? 1));
  const borderStyle = style.borderStyle || 'solid';
  const rx = Math.min(radius, width / 2, height / 2);
  const dash = borderStyle === 'dashed' ? ' stroke-dasharray="6 5"' : '';

  if (node.type === 'text') {
    return renderText(node.text, x, y, width, height, style);
  }

  const shape = `  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${borderWidth}"${dash}/>`;

  if (node.type === 'image') {
    const diagonal = borderWidth > 0 ? `
  <line x1="${x}" y1="${y}" x2="${x + width}" y2="${y + height}" stroke="${escapeXml(stroke)}" stroke-width="1" opacity="0.55"/>
  <line x1="${x + width}" y1="${y}" x2="${x}" y2="${y + height}" stroke="${escapeXml(stroke)}" stroke-width="1" opacity="0.55"/>` : '';
    return `${shape}${diagonal}\n${renderText(node.text || 'Image', x, y, width, height, style)}`;
  }

  if (node.type === 'frame') {
    const labelStyle = { ...style, verticalAlign: 'top', textAlign: 'left' };
    return `${shape}\n${renderText(node.text || node.name, x, y, width, height, labelStyle)}`;
  }

  return `${shape}\n${node.text ? renderText(node.text, x, y, width, height, style) : ''}`;
}

function renderText(text, x, y, width, height, style = {}) {
  const lines = String(text || '').split(/\r?\n/).slice(0, 30);
  if (!lines.length) return '';
  const fontSize = Number(style.fontSize || 14);
  const fontWeight = Number(style.fontWeight || 500);
  const lineHeight = Math.max(0.8, Number(style.lineHeight || 1.25));
  const color = style.textColor || '#202124';
  const align = style.textAlign || 'left';
  const vertical = style.verticalAlign || 'top';
  const padX = Math.max(0, Number(style.paddingX || 0));
  const padY = Math.max(0, Number(style.paddingY || 0));
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
  const tx = align === 'center' ? x + width / 2 : align === 'right' ? x + width - padX : x + padX;
  const step = fontSize * lineHeight;
  const totalHeight = Math.max(fontSize, (lines.length - 1) * step + fontSize);
  let firstY = y + padY + fontSize;
  if (vertical === 'center') firstY = y + (height - totalHeight) / 2 + fontSize;
  if (vertical === 'bottom') firstY = y + height - padY - totalHeight + fontSize;
  const tspans = lines.map((line, index) => `<tspan x="${tx}" dy="${index === 0 ? 0 : step}">${escapeXml(line)}</tspan>`).join('');
  return `  <text x="${tx}" y="${firstY}" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="${escapeXml(color)}" text-anchor="${anchor}">${tspans}</text>`;
}

export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function svgToPngBlob(svgText, width, height, scale = 1) {
  const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = svgUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG export failed.')), 'image/png'));
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

export function safeFileName(name, fallback = 'ui-blueprint') {
  const cleaned = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-');
  return cleaned || fallback;
}
