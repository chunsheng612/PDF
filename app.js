const { PDFDocument, degrees, rgb, StandardFonts, ParseSpeeds } = window.PDFLib || {};

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const forms = document.querySelectorAll(".tool-form[data-tool]");
const navButtons = document.querySelectorAll(".nav-btn[data-target]");
const pages = document.querySelectorAll(".tool-page[data-page]");
const themeToggle = document.getElementById("theme-toggle");
const mergeQueue = [];

function activatePage(pageKey) {
  for (const page of pages) page.classList.toggle("active", page.dataset.page === pageKey);
  for (const button of navButtons) button.classList.toggle("active", button.dataset.target === pageKey);
}

for (const button of navButtons) {
  button.addEventListener("click", () => activatePage(button.dataset.target));
}

function assertLibraries(tool) {
  if (!window.PDFLib) throw new Error("PDF 函式庫尚未載入。請確認網路可連到 CDN，或改成本地 vendor 檔。");
  if ((tool === "png" || tool === "preview") && !window.pdfjsLib) throw new Error("PDF.js 尚未載入，無法預覽或轉 PNG。");
  if ((tool === "png" || tool === "splitRanges" || tool === "splitEvery") && !window.JSZip) throw new Error("JSZip 尚未載入，無法輸出 ZIP。");
}

function baseName(file) {
  return (file?.name || "output").replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 90) || "output";
}

function oneFile(form, name = "file") {
  const file = form.elements[name]?.files?.[0];
  if (!file) throw new Error("請先選擇 PDF 檔案。");
  return file;
}

async function readBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

function parsePages(spec, total, defaultAll = true) {
  const text = String(spec || "")
    .trim()
    .toLowerCase()
    .replace(/[，、]/g, ",")
    .replace(/\s+/g, "");
  if (!text || text === "all") {
    if (defaultAll) return [...Array(total).keys()];
    throw new Error("請輸入頁碼範圍，例如 1,3-5。");
  }
  const pagesList = [];
  for (const part of text.split(",")) {
    if (!part) continue;
    if (part.includes("-")) {
      const [a, b] = part.split("-", 2);
      const start = !a || a === "start" ? 1 : Number(a);
      const end = !b || b === "end" ? total : Number(b);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) throw new Error(`頁碼範圍錯誤：${part}`);
      for (let p = start; p <= end; p += 1) pagesList.push(p - 1);
    } else {
      const page = part === "end" ? total : Number(part);
      if (!Number.isInteger(page)) throw new Error(`頁碼格式錯誤：${part}`);
      pagesList.push(page - 1);
    }
  }
  const unique = [];
  const seen = new Set();
  for (const p of pagesList) {
    if (p < 0 || p >= total) throw new Error(`頁碼超出範圍：${p + 1}，此 PDF 共 ${total} 頁。`);
    if (!seen.has(p)) {
      unique.push(p);
      seen.add(p);
    }
  }
  if (!unique.length) throw new Error("沒有有效頁碼。");
  return unique;
}

function parseGroups(spec, total) {
  const groups = String(spec || "")
    .replace(/；/g, ";")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parsePages(s, total, false));
  if (!groups.length) throw new Error("請輸入分段範圍，例如 1-3;4-6;7-end。");
  return groups;
}

function download(bytesOrBlob, filename, type = "application/pdf") {
  const blob = bytesOrBlob instanceof Blob ? bytesOrBlob : new Blob([bytesOrBlob], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return blob.size;
}

function setOutput(output, message, isError = false) {
  output.classList.toggle("error", isError);
  output.textContent = message;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function copySelectedPages(srcDoc, indices) {
  const out = await PDFDocument.create();
  const copied = await out.copyPages(srcDoc, indices);
  copied.forEach((page) => out.addPage(page));
  return out.save({ useObjectStreams: true });
}

function createPreviewSkeleton(panel, title) {
  panel.innerHTML = "";
  const header = document.createElement("div");
  header.className = "preview-header";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const meta = document.createElement("span");
  meta.textContent = "尚未載入";
  header.append(strong, meta);

  const grid = document.createElement("div");
  grid.className = "preview-grid";

  panel.append(header, grid);
  return { meta, grid };
}

async function renderPdfCanvas(file, scale = 0.35) {
  assertLibraries("preview");
  const bytes = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: ctx, viewport }).promise;
  canvas.dataset.pdfScale = String(scale);
  return { canvas, pageCount: doc.numPages, viewport, scale };
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function bindSinglePreview(form) {
  const panel = form.querySelector('[data-preview="single"]');
  const input = form.querySelector('input[type="file"][name="file"]');
  if (!panel || !input) return;

  const { meta, grid } = createPreviewSkeleton(panel, "PDF 預覽");
  grid.innerHTML = '<p class="preview-empty">尚未選擇檔案。</p>';

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) {
      meta.textContent = "尚未載入";
      grid.innerHTML = '<p class="preview-empty">尚未選擇檔案。</p>';
      return;
    }
    meta.textContent = "載入中...";
    grid.innerHTML = "";
    try {
      const { canvas, pageCount, viewport, scale } = await renderPdfCanvas(file);
      const item = document.createElement("div");
      item.className = "preview-item";
      const name = document.createElement("div");
      name.className = "preview-name";
      name.textContent = `${file.name} | ${pageCount} 頁 | ${formatSize(file.size)}`;
      if (form.dataset.tool === "textEdit") {
        form.elements.page.max = String(pageCount);
        if (!form.elements.y.dataset.userSet) {
          form.elements.y.value = Math.max(0, Math.round(viewport.height / scale - 72));
        }
        form.elements.x.addEventListener("input", () => { form.elements.x.dataset.userSet = "true"; }, { once: true });
        form.elements.y.addEventListener("input", () => { form.elements.y.dataset.userSet = "true"; }, { once: true });
        canvas.addEventListener("click", (event) => {
          const rect = canvas.getBoundingClientRect();
          const scaleX = canvas.width / rect.width;
          const scaleY = canvas.height / rect.height;
          const pixelX = (event.clientX - rect.left) * scaleX;
          const pixelY = (event.clientY - rect.top) * scaleY;
          const pdfScale = Number(canvas.dataset.pdfScale || 1);
          form.elements.x.value = Math.round(pixelX / pdfScale);
          form.elements.y.value = Math.round((canvas.height - pixelY) / pdfScale);
          form.elements.x.dataset.userSet = "true";
          form.elements.y.dataset.userSet = "true";
          name.textContent = `${file.name} | ${pageCount} 頁 | 座標 X ${form.elements.x.value}, Y ${form.elements.y.value}`;
        });
      }
      item.append(canvas, name);
      grid.append(item);
      meta.textContent = "已載入";
    } catch (error) {
      grid.innerHTML = `<p class="preview-empty">預覽失敗：${error.message || "未知錯誤"}</p>`;
      meta.textContent = "失敗";
    }
  });
}

async function renderMergePreview(form) {
  const panel = form.querySelector('[data-preview="merge"]');
  if (!panel) return;
  const { meta, grid } = createPreviewSkeleton(panel, "合併清單預覽");
  if (!mergeQueue.length) {
    meta.textContent = "0 份";
    grid.innerHTML = '<p class="preview-empty">目前清單為空，選擇 PDF 後會自動加入。</p>';
    return;
  }
  meta.textContent = `${mergeQueue.length} 份`;
  grid.innerHTML = "";

  const maxPreview = 6;
  for (let i = 0; i < mergeQueue.length; i += 1) {
    const file = mergeQueue[i];
    const item = document.createElement("div");
    item.className = "preview-item";

    try {
      if (i < maxPreview) {
        const { canvas, pageCount } = await renderPdfCanvas(file, 0.24);
        item.append(canvas);
        const name = document.createElement("div");
        name.className = "preview-name";
        name.textContent = `${i + 1}. ${file.name} | ${pageCount} 頁`;
        item.append(name);
      } else {
        const name = document.createElement("div");
        name.className = "preview-name";
        name.textContent = `${i + 1}. ${file.name}`;
        item.append(name);
      }
    } catch {
      const name = document.createElement("div");
      name.className = "preview-name";
      name.textContent = `${i + 1}. ${file.name}（無法預覽）`;
      item.append(name);
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "mini-btn";
    removeBtn.textContent = "移除";
    removeBtn.addEventListener("click", async () => {
      mergeQueue.splice(i, 1);
      await renderMergePreview(form);
    });
    item.append(removeBtn);
    grid.append(item);
  }

  if (mergeQueue.length > maxPreview) {
    const tail = document.createElement("p");
    tail.className = "preview-empty";
    tail.textContent = `其餘 ${mergeQueue.length - maxPreview} 份已加入合併清單。`;
    grid.append(tail);
  }
}

function bindMergeControls(form) {
  if (form.dataset.tool !== "merge") return;
  const fileInput = form.elements.files;
  const addBtn = form.querySelector('[data-action="merge-add"]');
  const clearBtn = form.querySelector('[data-action="merge-clear"]');

  const addSelectedFiles = async () => {
    const selected = [...(fileInput.files || [])];
    if (!selected.length) return;
    const existing = new Set(mergeQueue.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
    for (const file of selected) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (!existing.has(key)) {
        mergeQueue.push(file);
        existing.add(key);
      }
    }
    fileInput.value = "";
    await renderMergePreview(form);
  };

  fileInput.addEventListener("change", addSelectedFiles);
  addBtn?.addEventListener("click", addSelectedFiles);

  clearBtn?.addEventListener("click", async () => {
    mergeQueue.length = 0;
    fileInput.value = "";
    await renderMergePreview(form);
  });

  renderMergePreview(form);
}

async function pdfToPng(form) {
  const file = oneFile(form);
  const output = form.querySelector("output");
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
  const indices = parsePages(form.elements.pages.value, pdf.numPages);
  const dpi = clampNumber(form.elements.dpi.value, 72, 360, 180);
  const scaleBase = dpi / 72;
  const zip = new JSZip();
  const stem = baseName(file);

  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i];
    if (output) setOutput(output, `轉換 PNG 中... ${i + 1}/${indices.length}`);
    const page = await pdf.getPage(index + 1);
    const viewport = page.getViewport({ scale: scaleBase });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("瀏覽器無法建立 PNG，請降低 DPI 後再試。");
    zip.file(`${stem}_page_${String(index + 1).padStart(3, "0")}.png`, blob);
  }

  const result = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  return { payload: result, filename: `${stem}_png_pages.zip`, type: "application/zip" };
}

async function halvePages(form) {
  const file = oneFile(form);
  const src = await PDFDocument.load(await readBytes(file));
  const out = await PDFDocument.create();
  const direction = form.elements.direction.value;
  const reverse = form.elements.order.value === "reverse";

  for (let i = 0; i < src.getPageCount(); i += 1) {
    const srcPage = src.getPage(i);
    const { width, height } = srcPage.getSize();
    let boxes;
    if (direction === "horizontal") {
      boxes = [
        { left: 0, bottom: height / 2, right: width, top: height, outWidth: width, outHeight: height / 2 },
        { left: 0, bottom: 0, right: width, top: height / 2, outWidth: width, outHeight: height / 2 },
      ];
    } else {
      boxes = [
        { left: 0, bottom: 0, right: width / 2, top: height, outWidth: width / 2, outHeight: height },
        { left: width / 2, bottom: 0, right: width, top: height, outWidth: width / 2, outHeight: height },
      ];
    }
    if (reverse) boxes.reverse();
    for (const box of boxes) {
      const embedded = await out.embedPage(srcPage, box);
      const page = out.addPage([box.outWidth, box.outHeight]);
      page.drawPage(embedded, { x: 0, y: 0, width: box.outWidth, height: box.outHeight });
    }
  }

  return { payload: await out.save({ useObjectStreams: true }), filename: `${baseName(file)}_halves.pdf` };
}

async function extractPages(form) {
  const file = oneFile(form);
  const src = await PDFDocument.load(await readBytes(file));
  const indices = parsePages(form.elements.pages.value, src.getPageCount(), false);
  return { payload: await copySelectedPages(src, indices), filename: `${baseName(file)}_extract.pdf` };
}

async function splitRanges(form) {
  const file = oneFile(form);
  const src = await PDFDocument.load(await readBytes(file));
  const groups = parseGroups(form.elements.groups.value, src.getPageCount());
  const zip = new JSZip();
  const stem = baseName(file);

  for (let i = 0; i < groups.length; i += 1) {
    zip.file(`${stem}_part_${String(i + 1).padStart(2, "0")}.pdf`, await copySelectedPages(src, groups[i]));
  }

  return {
    payload: await zip.generateAsync({ type: "blob", compression: "DEFLATE" }),
    filename: `${stem}_split_ranges.zip`,
    type: "application/zip",
  };
}

async function splitEvery(form) {
  const file = oneFile(form);
  const src = await PDFDocument.load(await readBytes(file));
  const chunk = Number(form.elements.chunk.value);
  if (!Number.isInteger(chunk) || chunk < 1) throw new Error("每份頁數必須大於 0。");

  const zip = new JSZip();
  const stem = baseName(file);
  const total = src.getPageCount();
  let part = 1;

  for (let start = 0; start < total; start += chunk) {
    const indices = [];
    for (let i = start; i < Math.min(start + chunk, total); i += 1) indices.push(i);
    zip.file(`${stem}_chunk_${String(part).padStart(2, "0")}_p${indices[0] + 1}-${indices[indices.length - 1] + 1}.pdf`, await copySelectedPages(src, indices));
    part += 1;
  }

  return { payload: await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), filename: `${stem}_split_every.zip`, type: "application/zip" };
}

async function mergePdfs(form) {
  const selected = [...(form.elements.files.files || [])];
  const files = mergeQueue.length ? [...mergeQueue] : selected;
  const output = form.querySelector("output");
  if (files.length < 2) throw new Error("合併至少需要 2 個 PDF。");

  const out = await PDFDocument.create();
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (output) setOutput(output, `合併中... ${i + 1}/${files.length}`);
    const src = await PDFDocument.load(await readBytes(file));
    const indices = [...Array(src.getPageCount()).keys()];
    const copied = await out.copyPages(src, indices);
    copied.forEach((page) => out.addPage(page));
  }

  return { payload: await out.save({ useObjectStreams: true }), filename: `merged_${files.length}_files.pdf` };
}

async function rotatePages(form) {
  const file = oneFile(form);
  const src = await PDFDocument.load(await readBytes(file));
  const selected = new Set(parsePages(form.elements.pages.value, src.getPageCount()));
  const deg = Number(form.elements.degrees.value);

  for (let i = 0; i < src.getPageCount(); i += 1) {
    if (selected.has(i)) {
      const page = src.getPage(i);
      const current = page.getRotation().angle || 0;
      page.setRotation(degrees(current + deg));
    }
  }

  return { payload: await src.save({ useObjectStreams: true }), filename: `${baseName(file)}_rotated.pdf` };
}

async function deletePages(form) {
  const file = oneFile(form);
  const src = await PDFDocument.load(await readBytes(file));
  const remove = new Set(parsePages(form.elements.pages.value, src.getPageCount(), false));
  const keep = [...Array(src.getPageCount()).keys()].filter((i) => !remove.has(i));
  if (!keep.length) throw new Error("不能刪除所有頁面。");
  return { payload: await copySelectedPages(src, keep), filename: `${baseName(file)}_deleted.pdf` };
}

function applyCompressionMetadata(pdfDoc) {
  pdfDoc.setTitle("");
  pdfDoc.setAuthor("");
  pdfDoc.setSubject("");
  pdfDoc.setKeywords([]);
  pdfDoc.setProducer("HTML PDF Workbench");
  pdfDoc.setCreator("HTML PDF Workbench");
}

async function rebuildPdfFromPages(srcDoc) {
  const rebuilt = await PDFDocument.create();
  const indices = [...Array(srcDoc.getPageCount()).keys()];
  const copied = await rebuilt.copyPages(srcDoc, indices);
  copied.forEach((page) => rebuilt.addPage(page));
  applyCompressionMetadata(rebuilt);
  return rebuilt;
}

async function compressPdf(form) {
  const file = oneFile(form);
  const level = form.elements.level.value;
  const inputBytes = await readBytes(file);
  const originalSize = inputBytes.byteLength;
  const variants = [];

  const docA = await PDFDocument.load(inputBytes, { updateMetadata: false, parseSpeed: ParseSpeeds?.Slow || 100 });
  applyCompressionMetadata(docA);
  variants.push({
    name: "balanced",
    bytes: await docA.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 25 }),
  });

  const docB = await PDFDocument.load(inputBytes, { updateMetadata: false, parseSpeed: ParseSpeeds?.Slow || 100 });
  applyCompressionMetadata(docB);
  const rebuiltB = await rebuildPdfFromPages(docB);
  variants.push({
    name: "rebuilt",
    bytes: await rebuiltB.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 20 }),
  });

  if (level === "extreme") {
    const docC = await PDFDocument.load(inputBytes, { updateMetadata: false, parseSpeed: ParseSpeeds?.Slow || 100 });
    applyCompressionMetadata(docC);
    try {
      const formObj = docC.getForm();
      formObj.flatten({ updateFieldAppearances: false });
    } catch {
      // Flatten can fail on malformed or no-form PDFs; keep processing other variants.
    }
    const rebuiltC = await rebuildPdfFromPages(docC);
    variants.push({
      name: "extreme",
      bytes: await rebuiltC.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 10 }),
    });
  }

  variants.sort((a, b) => a.bytes.length - b.bytes.length);
  const best = variants[0];
  const finalSize = best.bytes.length;
  const ratio = ((1 - finalSize / originalSize) * 100).toFixed(2);
  const didShrink = finalSize < originalSize;
  const note = didShrink
    ? `壓縮成功：${formatSize(originalSize)} -> ${formatSize(finalSize)}（-${ratio}%）`
    : `未能縮小：原始 ${formatSize(originalSize)}，最佳結果 ${formatSize(finalSize)}。已下載原檔副本，避免檔案變大。`;

  return {
    payload: didShrink ? best.bytes : inputBytes,
    filename: didShrink ? `${baseName(file)}_compressed_${best.name}.pdf` : `${baseName(file)}_original_best.pdf`,
    note,
  };
}

function hasNonWinAnsiText(text) {
  return /[^\u0009\u000a\u000d\u0020-\u007e\u00a0-\u00ff]/.test(text);
}

function resolveFontkit() {
  return window.fontkit || window.Fontkit;
}

async function textEditPdf(form) {
  const file = oneFile(form);
  const src = await PDFDocument.load(await readBytes(file));
  const pageIndex = Number(form.elements.page.value) - 1;
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= src.getPageCount()) {
    throw new Error(`頁碼超出範圍：${pageIndex + 1}`);
  }

  const text = String(form.elements.text.value || "").trim();
  if (!text) throw new Error("請輸入文字內容。");

  let font;
  const customFont = form.elements.font.files?.[0];
  if (customFont) {
    const fontkit = resolveFontkit();
    if (!fontkit) throw new Error("字型引擎尚未載入，無法使用自訂字型。");
    src.registerFontkit(fontkit);
    const fontBytes = await customFont.arrayBuffer();
    font = await src.embedFont(fontBytes, { subset: true });
  } else {
    if (hasNonWinAnsiText(text)) throw new Error("內建字型不支援中文。請上傳 .ttf 或 .otf 中文字型後再產生。");
    font = await src.embedFont(StandardFonts.Helvetica);
  }

  const [r, g, b] = String(form.elements.color.value || "0,0,0").split(",").map(Number);
  const page = src.getPage(pageIndex);
  const size = clampNumber(form.elements.size.value, 6, 96, 14);
  const lineHeight = size * 1.35;
  const x = Math.max(0, Number(form.elements.x.value || 72));
  const y = Math.max(0, Number(form.elements.y.value || 720));
  const lines = text.split(/\r?\n/);

  if (form.elements.cover.checked) {
    const coverWidth = Math.max(0, Number(form.elements.coverWidth.value || 260));
    const coverHeight = Math.max(0, Number(form.elements.coverHeight.value || lineHeight * lines.length));
    if (coverWidth > 0 && coverHeight > 0) {
      page.drawRectangle({
        x,
        y: y - coverHeight + size,
        width: coverWidth,
        height: coverHeight,
        color: rgb(1, 1, 1),
        opacity: 0.96,
      });
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    page.drawText(lines[i], {
      x,
      y: y - i * lineHeight,
      size,
      font,
      color: rgb(r, g, b),
      lineHeight,
    });
  }

  return {
    payload: await src.save({ useObjectStreams: true }),
    filename: `${baseName(file)}_text_edited.pdf`,
  };
}

const handlers = {
  png: pdfToPng,
  halve: halvePages,
  extract: extractPages,
  splitRanges,
  splitEvery,
  merge: mergePdfs,
  rotate: rotatePages,
  delete: deletePages,
  compress: compressPdf,
  textEdit: textEditPdf,
};

for (const form of forms) {
  bindSinglePreview(form);
  bindMergeControls(form);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const tool = form.dataset.tool;
    const output = form.querySelector("output");
    const button = form.querySelector('.button-wrap button[type="submit"]');
    setOutput(output, "處理中...");
    button.disabled = true;
    try {
      assertLibraries(tool);
      const result = await handlers[tool](form);
      const size = download(result.payload, result.filename, result.type || "application/pdf");
      setOutput(
        output,
        result.note
          ? `${result.note} | 已下載 ${result.filename}`
          : `完成，已下載 ${result.filename}（${formatSize(size)}）`
      );
      if (tool === "merge") {
        mergeQueue.length = 0;
        await renderMergePreview(form);
      }
    } catch (error) {
      setOutput(output, error.message || "處理失敗", true);
    } finally {
      button.disabled = false;
    }
  });
}

function applyTheme(mode) {
  const isLight = mode === "light";
  document.body.classList.toggle("light-mode", isLight);
  if (themeToggle) themeToggle.textContent = isLight ? "深色模式" : "淺色模式";
}

function initTheme() {
  const saved = localStorage.getItem("pdf-tool-theme");
  applyTheme(saved === "light" ? "light" : "dark");
}

themeToggle?.addEventListener("click", () => {
  const next = document.body.classList.contains("light-mode") ? "dark" : "light";
  localStorage.setItem("pdf-tool-theme", next);
  applyTheme(next);
});

initTheme();
activatePage("png");
