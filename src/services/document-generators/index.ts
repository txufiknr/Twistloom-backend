/**
 * @overview In-Memory Document Generators
 *
 * Generates EPUB, DOCX, and PDF document Buffers in server memory with zero filesystem writes.
 * Supports clean typesetting, chapter divisions, author attribution, and cover integration.
 */

import epub from 'epub-gen-memory';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import PDFDocument from 'pdfkit';
import type { ExportPage } from '../book-export.js';

export interface DocumentGeneratorMeta {
  title: string;
  authorName?: string | null;
  summary?: string | null;
  coverImageUrl?: string | null;
  language?: string | null;
}

export interface GeneratedDocument {
  buffer: Buffer;
  contentType: string;
  ext: string;
}

/**
 * Compiles a book manuscript into an EPUB file buffer.
 */
export async function generateEpubBuffer(
  meta: DocumentGeneratorMeta,
  pages: ExportPage[],
): Promise<Buffer> {
  const chapters = pages.map((p) => ({
    title: `Chapter ${p.page}`,
    content: `<p>${p.text.replace(/\r\n/g, '\n').replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`,
  }));

  const options: {
    title: string;
    author: string;
    publisher: string;
    description?: string;
    cover?: string;
  } = {
    title: meta.title || 'Untitled Story',
    author: meta.authorName || 'Twistloom Creator',
    publisher: 'Twistloom',
  };

  if (meta.summary) {
    options.description = meta.summary;
  }

  if (meta.coverImageUrl && meta.coverImageUrl.startsWith('http')) {
    options.cover = meta.coverImageUrl;
  }

  return epub(options, chapters);
}

/**
 * Compiles a book manuscript into an editable Microsoft Word (.docx) document buffer.
 */
export async function generateDocxBuffer(
  meta: DocumentGeneratorMeta,
  pages: ExportPage[],
): Promise<Buffer> {
  const author = meta.authorName || 'Twistloom Creator';
  const title = meta.title || 'Untitled Story';

  const doc = new Document({
    title,
    creator: author,
    description: meta.summary || undefined,
    sections: [
      {
        properties: {},
        children: [
          // Title
          new Paragraph({
            text: title,
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { before: 800, after: 300 },
          }),
          // Author
          new Paragraph({
            text: `by ${author}`,
            alignment: AlignmentType.CENTER,
            spacing: { after: 1200 },
          }),
          // Story Content (Chapter by Chapter)
          ...pages.flatMap((p) => [
            new Paragraph({
              text: `Chapter ${p.page}`,
              heading: HeadingLevel.HEADING_2,
              pageBreakBefore: true,
              spacing: { before: 400, after: 300 },
            }),
            ...p.text
              .replace(/\r\n/g, '\n')
              .split(/\n\n+/)
              .filter(Boolean)
              .map(
                (paragraph) =>
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: paragraph.replace(/\n/g, ' '),
                        size: 24, // 12pt
                        font: 'Times New Roman',
                      }),
                    ],
                    spacing: { line: 360, after: 200 },
                  }),
              ),
          ]),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

/**
 * Compiles a book manuscript into a clean, flowable PDF document buffer.
 * Text flows naturally across pages, with page breaks placed only at chapter headings.
 */
export async function generatePdfBuffer(
  meta: DocumentGeneratorMeta,
  pages: ExportPage[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const author = meta.authorName || 'Twistloom Creator';
    const title = meta.title || 'Untitled Story';

    const doc = new PDFDocument({
      size: 'A4',
      margin: 54, // 0.75 in
      bufferPages: true,
      info: {
        Title: title,
        Author: author,
        Creator: 'Twistloom Publishing Engine',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Title Page ──
    doc.moveDown(8);
    doc.fontSize(26).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown(1.5);
    doc.fontSize(14).font('Helvetica').text(`by ${author}`, { align: 'center' });
    if (meta.summary) {
      doc.moveDown(3);
      doc.fontSize(10).font('Helvetica-Oblique').text(meta.summary, {
        align: 'center',
        width: 360,
      });
    }

    // ── Chapters ──
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      doc.addPage();
      doc.fontSize(16).font('Helvetica-Bold').text(`Chapter ${p.page}`, { align: 'left' });
      doc.moveDown(1);

      const paragraphs = p.text
        .replace(/\r\n/g, '\n')
        .split(/\n\n+/)
        .filter(Boolean);

      doc.fontSize(11).font('Helvetica');
      for (const para of paragraphs) {
        doc.text(para.replace(/\n/g, ' '), {
          align: 'justify',
          lineGap: 3,
          paragraphGap: 8,
        });
      }
    }

    // ── Dynamic Running Headers & Footers ──
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      // Skip title page (page 0)
      if (i > 0) {
        // Footer: Page number centered
        doc
          .fontSize(9)
          .font('Helvetica')
          .text(
            `${i}`,
            54,
            doc.page.height - 40,
            { align: 'center', width: doc.page.width - 108 },
          );
      }
    }

    doc.end();
  });
}

/**
 * Universal dispatcher that generates the requested format and returns content type and file extension.
 */
export async function generateDocument(
  meta: DocumentGeneratorMeta,
  pages: ExportPage[],
  format: 'epub' | 'docx' | 'pdf',
): Promise<GeneratedDocument> {
  switch (format) {
    case 'epub': {
      const buffer = await generateEpubBuffer(meta, pages);
      return {
        buffer,
        contentType: 'application/epub+zip',
        ext: 'epub',
      };
    }
    case 'docx': {
      const buffer = await generateDocxBuffer(meta, pages);
      return {
        buffer,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ext: 'docx',
      };
    }
    case 'pdf': {
      const buffer = await generatePdfBuffer(meta, pages);
      return {
        buffer,
        contentType: 'application/pdf',
        ext: 'pdf',
      };
    }
    default: {
      throw new Error(`Unsupported export format: ${format as string}`);
    }
  }
}
