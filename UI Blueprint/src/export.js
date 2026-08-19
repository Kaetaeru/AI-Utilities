const escapeXml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

export function screenToSvg(screen) {
  const nodes = screen.nodes.filter((node) => !node.hidden);
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
  const textColor = style.textColor || '#202124';
  const fontSize = Number(style.fontSize || 14);
  const textAlign = style.textAlign || 'left';
  const rx = Math.min(radius, width / 2, height / 2);

  if (node.type === 'text') {
    return renderText(node.text, x, y, width, height, fontSize, textColor, textAlign, false);
  }

  if (node.type === 'image') {
    const diagonal = `
  <line x1="${x}" y1="${y}" x2="${x + width}" y2="${y + height}" stroke="${escapeXml(stroke)}" stroke-width="1" opacity="0.55"/>
  <line x1="${x + width}" y1="${y}" x2="${x}" y2="${y + height}" stroke="${escapeXml(stroke)}" stroke-width="1" opacity="0.55"/>`;
    return `  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="1"/>${diagonal}\n${renderText(node.text || 'Image', x, y, width, height, fontSize, textColor, 'center', true)}`;
  }

  const dash = node.type === 'frame' ? ' stroke-dasharray="6 5"' : '';
  return `  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="1"${dash}/>
${node.text ? renderText(node.text, x, y, width, height, fontSize, textColor, textAlign, node.type === 'box') : ''}`;
}

function renderText(text, x, y, width, height, fontSize, color, align, centerVertically) {
  const lines = String(text || '').split(/\r?\n/).slice(0, 20);
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
  const tx = align === 'center' ? x + width / 2 : align === 'right' ? x + width - 10 : x + 10;
  const lineHeight = fontSize * 1.25;
  const totalHeight = lines.length * lineHeight;
  const firstY = centerVertically ? y + (height - totalHeight) / 2 + fontSize : y + fontSize + 4;
  const tspans = lines.map((line, index) => `<tspan x="${tx}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join('');
  return `  <text x="${tx}" y="${firstY}" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="${fontSize}" fill="${escapeXml(color)}" text-anchor="${anchor}">${tspans}</text>`;
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
