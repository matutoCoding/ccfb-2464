// 极简 PDF 生成器: 整页光栅化 (JPEG), 无需嵌入字体, 规避中文字体问题
// 支持多页 A4 纵向, 图片 + 基础文字 (拉丁字符用标准 Helvetica)

function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc;
}

interface PdfImage {
  x: number; y: number; w: number; h: number;
  data: Uint8Array;
  width: number; height: number;
}
interface PdfText {
  x: number; y: number; size: number; text: string;
}

export class PdfDocument {
  private pages: { images: PdfImage[]; texts: PdfText[] }[] = [];
  private readonly pageW = 595.28; // A4 @72dpi
  private readonly pageH = 841.89;

  addPage(): void {
    this.pages.push({ images: [], texts: [] });
  }

  addImage(x: number, y: number, w: number, h: number, dataUrl: string): void {
    const page = this.pages[this.pages.length - 1];
    const { bytes, width, height } = decodeDataUrlJpeg(dataUrl);
    page.images.push({ x, y, w, h, data: bytes, width, height });
  }

  /** y 为距页面顶部的距离, 内部转 PDF 底部坐标 */
  addTextTop(x: number, yTop: number, size: number, text: string): void {
    const page = this.pages[this.pages.length - 1];
    page.texts.push({ x, y: this.pageH - yTop, size, text: sanitizeLatin(text) });
  }

  build(): Blob {
    const objects: string[] = [];
    const binaries: Uint8Array[] = [];
    // 1: catalog, 2: pages, 之后动态分配
    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    const pageObjIds: number[] = [];
    let nextId = 3;
    const contentIds: number[] = [];
    const imageIds: number[] = [];

    for (const page of this.pages) {
      const pageId = nextId++;
      pageObjIds.push(pageId);
      // 图片对象
      const pageImageIds: number[] = [];
      for (const img of page.images) {
        imageIds.push(nextId);
        pageImageIds.push(nextId);
        binaries.push(img.data);
        objects.push(
          `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.data.length} >>`,
        );
        nextId++;
      }
      // 内容流
      let stream = '';
      page.images.forEach((img, i) => {
        stream += `q\n${img.w} 0 0 ${img.h} ${img.x} ${this.pageH - img.y - img.h} cm\n/Im${i} Do\nQ\n`;
      });
      for (const t of page.texts) {
        stream += `BT /F1 ${t.size} Tf ${t.x} ${t.y} Td (${t.text}) Tj ET\n`;
      }
      const enc = new TextEncoder().encode(stream);
      binaries.push(enc);
      contentIds.push(nextId);
      const xobj = pageImageIds.map((id, i) => `/Im${i} ${id} 0 R`).join(' ');
      objects.push(`<< /Length ${enc.length} >>\nstream\n__BIN${binaries.length - 1}__\nendstream`);
      nextId++;
      const fontRef = '/F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.pageW} ${this.pageH}] ` +
          `/Resources << /Font << ${fontRef} >> /XObject << ${xobj} >> >> /Contents ${contentIds[contentIds.length - 1]} 0 R >>`,
      );
      nextId++;
    }

    objects[1] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjIds.length} >>`;

    // 序列化
    const chunks: Uint8Array[] = [];
    const encoder = new TextEncoder();
    chunks.push(encoder.encode('%PDF-1.4\n%\xff\xff\xff\xff\n'));
    const offsets: number[] = [];
    let byteOffset = chunks[0].length;
    const pushAscii = (s: string) => {
      const b = encoder.encode(s);
      chunks.push(b);
      byteOffset += b.length;
    };
    objects.forEach((obj, idx) => {
      offsets.push(byteOffset);
      const id = idx + 1;
      const binMatch = obj.match(/__BIN(\d+)__/);
      if (binMatch) {
        const head = `${id} 0 obj\n<< /Length `.length; // 不需要, 直接拼
        void head;
        const [pre, post] = obj.split(/__BIN\d+__/);
        pushAscii(`${id} 0 obj\n${pre}`);
        const bin = binaries[Number(binMatch[1])];
        chunks.push(bin);
        byteOffset += bin.length;
        pushAscii(`${post}endobj\n`);
      } else {
        pushAscii(`${id} 0 obj\n${obj}\nendobj\n`);
      }
    });
    const xrefStart = byteOffset;
    pushAscii(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
    for (const off of offsets) pushAscii(`${String(off).padStart(10, '0')} 00000 n \n`);
    pushAscii(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
    );
    void crc32;
    return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
  }
}

function sanitizeLatin(s: string): string {
  // PDF 字面字符串转义; 非 Latin-1 字符替换为 '?', 中文由图片承载
  return s
    .replace(/[\\()]/g, (m) => `\\${m}`)
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

function decodeDataUrlJpeg(dataUrl: string): { bytes: Uint8Array; width: number; height: number } {
  const base64 = dataUrl.split(',')[1];
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // 解析 JPEG SOF0 段拿宽高
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return { bytes, width, height };
    }
    i += 2 + len;
  }
  throw new Error('无法解析 JPEG 尺寸');
}

/** Canvas 导出为 JPEG data URL (PDF 内嵌用) */
export function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.88): string {
  return canvas.toDataURL('image/jpeg', quality);
}
