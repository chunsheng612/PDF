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
  const text = String(spec || "").trim().toLowerCase().replace(/\s+/g, "");
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
  return { canvas, pageCount: doc.numPages, viewport };
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
      const { canvas, pageCount } = await renderPdfCanvas(file);
      const item = document.createElement("div");
      item.className = "preview-item";
      const name = document.createElement("div");
      name.className = "preview-name";
      name.textContent = `${file.name} | ${pageCount} 頁 | ${formatSize(file.size)}`;
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
    grid.innerHTML = '<p class="preview-empty">目前清單為空，請先加入檔案。</p>';
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

  addBtn?.addEventListener("click", async () => {
    const selected = [...(fileInput.files || [])];
    if (!selected.length) return;
    for (const file of selected) mergeQueue.push(file);
    fileInput.value = "";
    await renderMergePreview(form);
  });

  clearBtn?.addEventListener("click", async () => {
    mergeQueue.length = 0;
    fileInput.value = "";
    await renderMergePreview(form);
  });

  renderMergePreview(form);
}

async function pdfToPng(form) {
  const file = oneFile(form);
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
  const indices = parsePages(form.elements.pages.value, pdf.numPages);
  const dpi = Math.max(72, Math.min(Number(form.elements.dpi.value || 180), 360));
  const scaleBase = dpi / 72;
  const zip = new JSZip();
  const stem = baseName(file);

  for (const index of indices) {
    const page = await pdf.getPage(index + 1);
    const viewport = page.getViewport({ scale: scaleBase });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
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
  if (files.length < 2) throw new Error("合併至少需要 2 個 PDF。請先加入清單。\n");

  const out = await PDFDocument.create();
  for (const file of files) {
    const src = await PDFDocument.load(await readBytes(file));
    const indices = [...Array(src.getPageCount()).keys()];
    const copied = await out.copyPages(src, indices);
    copied.forEach((page) => out.addPage(page));
  }

  return { payload: await out.save({ useObjectStreams: true }), filename: "merged.pdf" };
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
  const note = finalSize < originalSize
    ? `壓縮成功：${formatSize(originalSize)} -> ${formatSize(finalSize)}（-${ratio}%）`
    : `未能縮小：原始 ${formatSize(originalSize)}，最佳結果 ${formatSize(finalSize)}。此檔案可能已接近最佳化。`;

  return {
    payload: best.bytes,
    filename: `${baseName(file)}_compressed_${best.name}.pdf`,
    note,
  };
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
    if (!window.fontkit) throw new Error("字型引擎尚未載入，無法使用自訂字型。");
    src.registerFontkit(window.fontkit);
    const fontBytes = await customFont.arrayBuffer();
    font = await src.embedFont(fontBytes, { subset: true });
  } else {
    font = await src.embedFont(StandardFonts.Helvetica);
  }

  const [r, g, b] = String(form.elements.color.value || "0,0,0").split(",").map(Number);
  const page = src.getPage(pageIndex);
  page.drawText(text, {
    x: Number(form.elements.x.value || 72),
    y: Number(form.elements.y.value || 720),
    size: Number(form.elements.size.value || 14),
    font,
    color: rgb(r, g, b),
    lineHeight: Number(form.elements.size.value || 14) * 1.35,
  });

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
    output.classList.remove("error");
    output.textContent = "處理中...";
    button.disabled = true;
    try {
      assertLibraries(tool);
      const result = await handlers[tool](form);
      const size = download(result.payload, result.filename, result.type || "application/pdf");
      output.textContent = result.note
        ? `${result.note} | 已下載 ${result.filename}`
        : `完成，已下載 ${result.filename}（${(size / 1024 / 1024).toFixed(2)} MB）`;
      if (tool === "merge") {
        mergeQueue.length = 0;
        await renderMergePreview(form);
      }
    } catch (error) {
      output.classList.add("error");
      output.textContent = error.message || "處理失敗";
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
