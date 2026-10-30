// Files dropped on the bar. Each becomes a block the models can read: PDFs,
// images, audio and video go to Gemini as they are (Claude takes PDFs and
// images); text, code and Word documents are read as text, so every model,
// including the offline one, can use them.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_FILE_MB = 15;
const MAX_TOTAL_MB = 18; // Gemini accepts about 20 MB per question
const MAX_TEXT_CHARS = 200000;

const MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic',
  '.mp3': 'audio/mp3', '.wav': 'audio/wav', '.m4a': 'audio/aac', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
};
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.sql', '.sh', '.ps1', '.bat',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.log', '.tex', '.r', '.m', '.lua', '.dart', '.vue', '.svelte']);

// Word documents are zip files; the text is in word/document.xml.
function docxText(buf) {
  let eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a valid .docx file');
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === 'word/document.xml') {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + size);
      const xml = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
      return xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('no text found in the .docx file');
}

// PDF text for the offline model (the cloud models read the PDF itself).
async function pdfText(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

const clip = (t) => (t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}\n[…cut: the file is longer than ${MAX_TEXT_CHARS} characters]` : t);

// Returns { blocks, names } or throws an Error with a message for the user.
async function load(paths, { needText = false } = {}) {
  const blocks = [];
  const names = [];
  let total = 0;
  for (const p of paths) {
    const name = path.basename(p);
    const ext = path.extname(p).toLowerCase();
    const stat = fs.statSync(p);
    if (stat.isDirectory()) throw new Error(`${name} is a folder. Drop the files inside it instead.`);
    const mb = stat.size / 1024 / 1024;
    if (ext === '.docx') {
      const text = docxText(fs.readFileSync(p));
      blocks.push({ type: 'text', text: `File ${name}:\n${clip(text)}` });
    } else if (TEXT_EXT.has(ext) || (!MIME[ext] && mb < 2 && isProbablyText(p))) {
      const text = fs.readFileSync(p, 'utf8');
      blocks.push({ type: 'text', text: `File ${name}:\n\`\`\`\n${clip(text)}\n\`\`\`` });
    } else if (MIME[ext]) {
      if (mb > MAX_FILE_MB) throw new Error(`${name} is ${mb.toFixed(0)} MB. Files can be up to ${MAX_FILE_MB} MB.`);
      total += mb;
      if (total > MAX_TOTAL_MB) throw new Error(`Those files add up to more than ${MAX_TOTAL_MB} MB, which is too much for one question. Drop fewer at a time.`);
      const buf = fs.readFileSync(p);
      const block = { type: 'file', name, mime: MIME[ext], data: buf.toString('base64') };
      if (needText && ext === '.pdf') {
        try { block.text = clip(await pdfText(buf)); } catch { /* the model is told it can't open it */ }
      }
      blocks.push(block);
    } else {
      throw new Error(`Assistant can't read ${ext || 'this kind of'} files (${name}). Try PDF, Word, text, code, images, audio or video.`);
    }
    names.push(name);
  }
  return { blocks, names };
}

function isProbablyText(p) {
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(4096);
  const n = fs.readSync(fd, buf, 0, 4096, 0);
  fs.closeSync(fd);
  return !buf.subarray(0, n).includes(0);
}

module.exports = { load, MAX_FILE_MB };
