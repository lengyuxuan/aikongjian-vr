import './download.css';
import { createZip, type ZipEntry } from './zip.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function $<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  return root.querySelector(selector) as T;
}

// Normalises an asset path to a clean relative path with forward slashes,
// mimicking node:path/posix join for the relative paths download.js produces
// (no leading slash, no "." / "..", collapsed "/").
function relJoin(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const segment of part.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') segments.pop();
      else segments.push(segment);
    }
  }
  return segments.join('/');
}

// Builds the browser URL used to fetch a single asset. A relative base_url is
// resolved against the work.json location; an absolute one is used as-is.
function resolveAssetUrl(baseUrl: string, assetPath: string, jsonUrl: string): string {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const asset = assetPath.replace(/^\/+/, '');
  const joined = base ? `${base}/${asset}` : asset;
  try {
    return new URL(joined, jsonUrl).href;
  } catch {
    return joined;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

// ---------------------------------------------------------------------------
// Types & state
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'loading' | 'downloading' | 'packing' | 'done' | 'error';

interface JsonLike {
  base_url?: unknown;
  model?: {
    file_url?: unknown;
    material_base_url?: unknown;
    material_textures?: unknown[];
  };
  panorama?: { list?: unknown[] };
  picture_url?: unknown;
  title_picture_url?: unknown;
  vr_code?: unknown;
}

// ---------------------------------------------------------------------------
// Collect the file list — mirrors the order/resources download.js fetches.
// ---------------------------------------------------------------------------

const POSITIONS = ['back', 'down', 'front', 'left', 'right', 'up'];

function collectAssets(json: JsonLike): { base: string; paths: string[]; vrCode: string } {
  const base = typeof json?.base_url === 'string' ? json.base_url : '';
  const set = new Set<string>();
  const push = (path: string) => {
    const normalized = relJoin(path);
    if (normalized) set.add(normalized);
  };

  const model = json?.model;
  if (model) {
    if (typeof model.file_url === 'string') push(model.file_url);
    const materialBase = typeof model.material_base_url === 'string' ? model.material_base_url : '';
    const textures = Array.isArray(model.material_textures) ? model.material_textures : [];
    for (const texture of textures) {
      if (typeof texture === 'string') push(relJoin(materialBase, texture));
    }
  }

  const list = json?.panorama?.list;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      for (const pos of POSITIONS) {
        const value = (item as Record<string, unknown>)[pos];
        if (typeof value === 'string') push(value);
      }
    }
  }

  if (typeof json?.picture_url === 'string') push(json.picture_url);
  if (typeof json?.title_picture_url === 'string') push(json.title_picture_url);

  return {
    base,
    paths: Array.from(set),
    vrCode: typeof json?.vr_code === 'string' ? json.vr_code : '',
  };
}

// ---------------------------------------------------------------------------
// Boot the UI
// ---------------------------------------------------------------------------

const $app = $<HTMLElement>('#app');
$app.innerHTML = `
  <div class="archiver">
    <header class="archiver__bar">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true"></span>
        <span class="brand__name">VR Bundle Archiver</span>
      </div>
      <a class="archiver__back" href="./index.html">← 返回查看器</a>
    </header>

    <main class="archiver__card">
      <section class="hero">
        <h1 class="hero__title">把远程 VR 场景抓下来</h1>
        <p class="hero__lede">
          粘贴 <code>work.json</code> 的远程地址，读取素材清单，逐一抓取全部文件，
          并打包成一个<strong>可按原目录结构解压</strong>的 zip。
        </p>
      </section>

      <form class="packer" autocomplete="off">
        <label class="packer__label" for="src-url">远程 work.json 地址</label>
        <div class="packer__row">
          <input
            id="src-url"
            class="packer__input"
            type="url"
            inputmode="url"
            spellcheck="false"
            placeholder="https://example.com/path/work.json"
          />
          <button class="packer__submit" type="submit">
            <span class="packer__submit-text">提取素材</span>
          </button>
        </div>
        <label class="packer__local">
          <input id="local-base" type="checkbox" checked />
          <span>打包为本地可用：把 JSON 里的 <code>base_url</code> 改写为 <code>./vr</code></span>
        </label>
        <p class="packer__hint">要点：该地址需允许跨域访问（CORS）；资源路径以 JSON 内的 base_url 为准。打包时会一并放入 <code>work.json</code>（位于 zip 根目录，与 <code>vr/</code> 同级）。</p>
      </form>

      <ol class="steps" aria-label="下载流程">
        <li class="step" data-step="1"><span class="step__dot"></span><span class="step__txt">读取清单</span></li>
        <li class="step" data-step="2"><span class="step__dot"></span><span class="step__txt">下载素材</span></li>
        <li class="step" data-step="3"><span class="step__dot"></span><span class="step__txt">打包 ZIP</span></li>
      </ol>

      <section class="outcome" hidden>
        <div class="progress">
          <div class="progress__bar"><span class="progress__fill"></span></div>
          <p class="progress__label">等待开始</p>
        </div>

        <div class="manifest" hidden>
          <p class="manifest__head">素材清单（下载进度）</p>
          <div class="manifest__list"></div>
        </div>

        <div class="result" hidden>
          <div class="result__box">
            <p class="result__flag">打包完成</p>
            <div class="result__file">
              <span class="result__name"></span>
              <button class="result__copy" type="button">复制下载地址</button>
            </div>
            <p class="result__meta"></p>
            <a class="result__dl" href="#" download>下载 ZIP 包</a>
          </div>
          <div class="result__url">
            <span>下载地址：</span>
            <code class="result__href"></code>
          </div>
          <button class="result__again" type="button">再来一个</button>
        </div>

        <div class="errorbox" hidden>
          <p class="errorbox__title">没能完成</p>
          <p class="errorbox__msg"></p>
          <div class="errorbox__files" hidden></div>
          <div class="errorbox__actions">
            <button class="errorbox__retry" type="button">重试失败项</button>
            <button class="errorbox__again" type="button">换一个地址</button>
          </div>
        </div>
      </section>
    </main>
  </div>
`;

// DOM references
const form = $<HTMLFormElement>('.packer');
const input = $<HTMLInputElement>('#src-url');
const localBase = $<HTMLInputElement>('#local-base');
const submitBtn = $<HTMLButtonElement>('.packer__submit');
const submitText = $<HTMLSpanElement>('.packer__submit-text');
const body = document.body;

const outcomeEl = $<HTMLElement>('.outcome');
const progressEl = $<HTMLElement>('.progress');
const progressFill = $<HTMLElement>('.progress__fill');
const progressLabel = $<HTMLElement>('.progress__label');
const manifestEl = $<HTMLElement>('.manifest');
const manifestList = $<HTMLElement>('.manifest__list');

const resultEl = $<HTMLElement>('.result');
const resultName = $<HTMLElement>('.result__name');
const resultMeta = $<HTMLElement>('.result__meta');
const resultDl = $<HTMLAnchorElement>('.result__dl');
const resultHref = $<HTMLElement>('.result__href');
const resultCopy = $<HTMLButtonElement>('.result__copy');
const resultAgain = $<HTMLButtonElement>('.result__again');

const errorEl = $<HTMLElement>('.errorbox');
const errorMsg = $<HTMLElement>('.errorbox__msg');
const errorFiles = $<HTMLElement>('.errorbox__files');
const errorRetry = $<HTMLButtonElement>('.errorbox__retry');
const errorAgain = $<HTMLButtonElement>('.errorbox__again');

const stepEls = [
  $<HTMLElement>('[data-step="1"]'),
  $<HTMLElement>('[data-step="2"]'),
  $<HTMLElement>('[data-step="3"]'),
];

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const CONCURRENCY = 6;
let assetPaths: string[] = [];
let processed = new Set<string>();
let entries: ZipEntry[] = [];
const failures = new Map<string, string>();
let totalBytes = 0;
let currentJsonUrl = '';
let currentBase = '';
let currentVrCode = '';
let currentJson: JsonLike | null = null;
const rowByPath = new Map<string, HTMLElement>();

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStep(el: HTMLElement, state: 'pending' | 'active' | 'done' | 'error'): void {
  el.setAttribute('data-state', state);
}

function setPhase(phase: Phase, failedStep: 1 | 2 | 3 = 2): void {
  body.dataset.phase = phase;
  const [s1, s2, s3] = stepEls;
  if (phase === 'idle') {
    setStep(s1, 'pending');
    setStep(s2, 'pending');
    setStep(s3, 'pending');
  } else if (phase === 'loading') {
    setStep(s1, 'active');
    setStep(s2, 'pending');
    setStep(s3, 'pending');
  } else if (phase === 'downloading') {
    setStep(s1, 'done');
    setStep(s2, 'active');
    setStep(s3, 'pending');
  } else if (phase === 'packing') {
    setStep(s1, 'done');
    setStep(s2, 'done');
    setStep(s3, 'active');
  } else if (phase === 'done') {
    setStep(s1, 'done');
    setStep(s2, 'done');
    setStep(s3, 'done');
  } else if (phase === 'error') {
    if (failedStep === 1) {
      setStep(s1, 'error');
      setStep(s2, 'pending');
      setStep(s3, 'pending');
    } else if (failedStep === 3) {
      setStep(s1, 'done');
      setStep(s2, 'done');
      setStep(s3, 'error');
    } else {
      setStep(s1, 'done');
      setStep(s2, 'error');
      setStep(s3, 'pending');
    }
  }

  const busy = phase === 'loading' || phase === 'downloading' || phase === 'packing';
  submitBtn.disabled = busy;
  submitText.textContent = phase === 'loading' ? '读取中…' : phase === 'downloading' ? '下载中…' : phase === 'packing' ? '打包中…' : '提取素材';

  const showOutcome = phase !== 'idle' && phase !== 'loading';
  outcomeEl.hidden = !showOutcome;
  progressEl.hidden = phase !== 'downloading' && phase !== 'packing';
  manifestEl.hidden = phase !== 'downloading' && phase !== 'packing' && phase !== 'done';
  resultEl.hidden = phase !== 'done';
  errorEl.hidden = phase !== 'error';
}

function updateProgress(): void {
  const total = assetPaths.length;
  const done = processed.size;
  const pct = total ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = `已获取 ${done} / ${total} 个文件`;
}

function makeRow(path: string, url: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'manifest__row';
  row.dataset.status = 'pending';
  const dot = document.createElement('span');
  dot.className = 'manifest__dot';
  const name = document.createElement('span');
  name.className = 'manifest__path';
  name.textContent = path;
  name.title = url;
  const size = document.createElement('span');
  size.className = 'manifest__size';
  size.textContent = '等待';
  row.append(dot, name, size);
  rowByPath.set(path, row);
  return row;
}

function markRow(path: string, status: 'pending' | 'ok' | 'error', sizeLabel: string): void {
  const row = rowByPath.get(path);
  if (!row) return;
  row.dataset.status = status;
  const sizeEl = $<HTMLElement>('.manifest__size', row);
  sizeEl.textContent = sizeLabel;
  processed.add(path);
  updateProgress();
}

function renderManifest(paths: string[], base: string, jsonUrl: string): void {
  manifestList.innerHTML = '';
  rowByPath.clear();
  // The work.json is fetched upfront and always included in the archive.
  const jsonRow = makeRow('work.json', jsonUrl);
  jsonRow.dataset.status = 'ok';
  $<HTMLElement>('.manifest__size', jsonRow).textContent = '已就绪';
  manifestList.appendChild(jsonRow);
  for (const path of paths) {
    manifestList.appendChild(makeRow(path, resolveAssetUrl(base, path, jsonUrl)));
  }
}

function showError(message: string, files?: string[]): void {
  errorMsg.textContent = message;
  if (files && files.length) {
    errorFiles.hidden = false;
    errorFiles.innerHTML = '';
    const title = document.createElement('p');
    title.className = 'errorbox__files-title';
    title.textContent = `${files.length} 个文件未能获取：`;
    errorFiles.appendChild(title);
    for (const file of files) {
      const item = document.createElement('p');
      item.className = 'errorbox__file';
      item.textContent = file;
      errorFiles.appendChild(item);
    }
  } else {
    errorFiles.hidden = true;
  }
}

function describeError(error: unknown, url: string): string {
  if (error instanceof TypeError) {
    return `无法获取 ${url}。可能是跨域（CORS）受限、地址无效或服务不可达。请确认该地址允许浏览器直接访问。`;
  }
  if (error instanceof Error) {
    return `获取 ${url} 时出错：${error.message}`;
  }
  return `获取 ${url} 时出错。`;
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

async function downloadAll(paths: string[]): Promise<void> {
  setPhase('downloading');
  let index = 0;
  const worker = async () => {
    while (index < paths.length) {
      const path = paths[index++];
      const url = resolveAssetUrl(currentBase, path, currentJsonUrl);
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = new Uint8Array(await res.arrayBuffer());
        entries.push({ path: `vr/${path}`, data });
        failures.delete(path);
        totalBytes += data.length;
        markRow(path, 'ok', formatBytes(data.length));
      } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : '网络错误';
        failures.set(path, reason);
        markRow(path, 'error', '失败');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker));
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

// Serialises the fetched work.json for inclusion in the archive. When the
// "local" option is on, base_url is rewritten to ./vr so the extracted bundle
// (work.json + vr/) is immediately playable offline, like the bundled example.
function buildWorkJsonEntry(): ZipEntry {
  const json = localBase.checked ? { ...currentJson, base_url: './vr' } : currentJson;
  return {
    path: 'work.json',
    data: new TextEncoder().encode(JSON.stringify(json, null, 2)),
  };
}

async function packZip(): Promise<boolean> {
  setPhase('packing');
  try {
    const jsonEntry = buildWorkJsonEntry();
    const allEntries = [jsonEntry, ...entries];
    const bytes = await createZip(allEntries);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const name = `vr-${currentVrCode || 'bundle'}.zip`;
    resultName.textContent = name;
    resultMeta.textContent = `${allEntries.length} 个文件 · ${formatBytes(totalBytes + jsonEntry.data.length)} · 含 work.json`;
    resultDl.href = url;
    resultDl.setAttribute('download', name);
    resultHref.textContent = url;
    resultUrl = url;
    return true;
  } catch {
    return false;
  }
}

let resultUrl = '';

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

function resetState(): void {
  assetPaths = [];
  processed = new Set();
  entries = [];
  failures.clear();
  totalBytes = 0;
  currentJsonUrl = '';
  currentBase = '';
  currentVrCode = '';
  currentJson = null;
  rowByPath.clear();
}

function resetManifest(): void {
  manifestList.innerHTML = '';
}

async function run(url: string): Promise<void> {
  resetState();
  resetManifest();
  progressFill.style.width = '0%';
  progressLabel.textContent = '等待开始';
  setPhase('loading');
  currentJsonUrl = url;

  let json: JsonLike;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = (await res.json()) as JsonLike;
  } catch (error) {
    setPhase('error', 1);
    showError(describeError(error, url));
    return;
  }

  const collected = collectAssets(json);
  if (collected.paths.length === 0) {
    setPhase('error', 1);
    showError('这个地址看起来不是 Realsee 的 work.json：没有解析到任何素材。请确认返回的是完整的 work.json。');
    return;
  }

  assetPaths = collected.paths;
  currentBase = collected.base;
  currentVrCode = collected.vrCode;
  currentJson = json;
  renderManifest(assetPaths, currentBase, currentJsonUrl);

  await downloadAll(assetPaths);

  if (failures.size > 0) {
    setPhase('error', 2);
    showError('部分文件下载失败，无法生成完整可用的包。', Array.from(failures.keys()));
    return;
  }

  const ok = await packZip();
  if (ok) {
    setPhase('done');
  } else {
    setPhase('error', 3);
    showError('打包 ZIP 时出错，请重试。');
  }
}

async function retryFailed(): Promise<void> {
  const failedPaths = Array.from(failures.keys());
  if (failedPaths.length === 0) return;
  failures.clear();
  // Only re-attempt the failed subset; already-downloaded files stay in the archive.
  for (const path of failedPaths) {
    processed.delete(path);
    const row = rowByPath.get(path);
    if (row) {
      row.dataset.status = 'pending';
      const sizeEl = $<HTMLElement>('.manifest__size', row);
      sizeEl.textContent = '等待';
    }
  }
  updateProgress();
  await downloadAll(failedPaths);
  if (failures.size > 0) {
    setPhase('error', 2);
    showError('仍有一些文件下载失败。', Array.from(failures.keys()));
    return;
  }
  const ok = await packZip();
  if (ok) setPhase('done');
  else {
    setPhase('error', 3);
    showError('打包 ZIP 时出错，请重试。');
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) {
    input.focus();
    return;
  }
  void run(url);
});

resultCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(resultUrl);
    resultCopy.textContent = '已复制';
    setTimeout(() => (resultCopy.textContent = '复制下载地址'), 1200);
  } catch {
    resultCopy.textContent = '复制失败';
    setTimeout(() => (resultCopy.textContent = '复制下载地址'), 1200);
  }
});

resultAgain.addEventListener('click', () => {
  resetState();
  resetManifest();
  progressFill.style.width = '0%';
  progressLabel.textContent = '等待开始';
  setPhase('idle');
  input.value = '';
  input.focus();
});

errorAgain.addEventListener('click', () => {
  resetState();
  resetManifest();
  progressFill.style.width = '0%';
  progressLabel.textContent = '等待开始';
  setPhase('idle');
  input.value = '';
  input.focus();
});

errorRetry.addEventListener('click', () => {
  void retryFailed();
});

setPhase('idle');
