import { Five } from '@realsee/five';
import { unzip, type UnzipEntry } from './unzip.js';
import './preview.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function $<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  return root.querySelector(selector) as T;
}

function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'json') return 'application/json';
  return 'application/octet-stream';
}

// Maps a fetch request URL back to the archive path key (e.g. /vr/model/.. -> vr/model/..).
function urlToPath(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    return decodeURIComponent(u.pathname).replace(/^\/+/, '').replace(/\/+$/, '');
  } catch {
    return '';
  }
}

// Prepares the bundled work.json for local playback. The certificate is often
// stored with escaped literal "\n" instead of real newlines, which crashes
// Five's PEM parser; decoding it makes the (lenient, non-validating) local path
// behave cleanly.
function normalizeWorkForLocal(workJSON: any): void {
  workJSON.base_url = './vr';
  if (typeof workJSON.certificate === 'string') {
    workJSON.certificate = workJSON.certificate.split('\\n').join('\n');
  }
}

// ---------------------------------------------------------------------------
// Boot the UI
// ---------------------------------------------------------------------------

const $app = $<HTMLElement>('#app');
$app.innerHTML = `
  <div class="preview">
    <header class="preview__bar">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true"></span>
        <span class="brand__name">VR Preview</span>
      </div>
      <a class="preview__back" href="./download.html">← 打包工具</a>
    </header>

    <main class="preview__body">
      <section class="uploader">
        <div class="uploader__card">
          <h1 class="uploader__title">上传 zip 预览</h1>
          <p class="uploader__lede">
            选择由打包工具生成的 zip（内含 <code>work.json</code> 与 <code>vr/</code> 素材），
            在这里直接预览整套 VR 场景。
          </p>
          <div class="dropzone" tabindex="0" role="button" aria-label="上传 zip 文件">
            <input id="file" type="file" accept=".zip,application/zip" hidden />
            <div class="dropzone__glyph" aria-hidden="true">
              <span></span><span></span><span></span>
            </div>
            <p class="dropzone__main">把 zip 拖到这里，或点击选择文件</p>
            <p class="dropzone__sub">支持打包工具生成的标准 zip · STORE / DEFLATE 均可</p>
          </div>
          <p class="status" role="status" data-state="idle"></p>
        </div>
      </section>

      <section class="viewer" hidden>
        <div class="viewer__canvas"></div>
        <div class="viewer__controls">
          <button class="viewer__mode" type="button">切换成模型态</button>
          <button class="viewer__again" type="button">重新上传</button>
        </div>
      </section>
    </main>
  </div>
`;

const uploader = $<HTMLElement>('.uploader');
const viewer = $<HTMLElement>('.viewer');
const viewerCanvas = $<HTMLElement>('.viewer__canvas');
const fileInput = $<HTMLInputElement>('#file');
const dropzone = $<HTMLElement>('.dropzone');
const statusEl = $<HTMLElement>('.status');
const modeBtn = $<HTMLButtonElement>('.viewer__mode');
const againBtn = $<HTMLButtonElement>('.viewer__again');

let fileStore = new Map<string, Blob>();
let five: Five | null = null;

// ---------------------------------------------------------------------------
// Intercept fetch so asset URLs (base_url ./vr + relative path) resolve to the
// in-memory bytes unpacked from the uploaded archive.
// ---------------------------------------------------------------------------

const origFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = urlToPath(url);
  if (path) {
    const blob = fileStore.get(path);
    if (blob) {
      return new Response(blob, {
        status: 200,
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      });
    }
  }
  return origFetch(input, init);
};

// ---------------------------------------------------------------------------
// Viewer lifecycle
// ---------------------------------------------------------------------------

async function mountFive(workJSON: any): Promise<void> {
  if (five) {
    try {
      five.dispose();
    } catch {
      /* ignore */
    }
    five = null;
  }
  viewerCanvas.innerHTML = '';

  const instance = new Five({
    imageOptions: { size: 512 },
    textureOptions: { autoResize: false },
  });
  five = instance;
  modeBtn.textContent = '切换成模型态';
  instance.on('modeChange', (mode) => {
    modeBtn.textContent = mode === Five.Mode.Panorama ? '切换成模型态' : '切换成全景态';
  });

  try {
    const loading = instance.load(workJSON);
    instance.appendTo(viewerCanvas);
    await loading;
    instance.refresh();
  } catch (error) {
    try {
      instance.dispose();
    } catch {
      /* ignore */
    }
    if (five === instance) five = null;
    viewerCanvas.innerHTML = '';
    throw error;
  }
}

function resetToUploader(): void {
  if (five) {
    try {
      five.dispose();
    } catch {
      /* ignore */
    }
    five = null;
  }
  fileStore = new Map();
  viewerCanvas.innerHTML = '';
  viewer.hidden = true;
  uploader.hidden = false;
  fileInput.value = '';
  setStatus('', 'idle');
}

function setStatus(text: string, state: 'idle' | 'busy' | 'ok' | 'error' = 'idle'): void {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

async function handleFile(file: File): Promise<void> {
  setStatus('正在解析 zip…', 'busy');
  let entries: UnzipEntry[];
  try {
    const bytes = await file.arrayBuffer();
    entries = await unzip(new Uint8Array(bytes));
  } catch (error) {
    setStatus(`解析失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    return;
  }

  const jsonEntry =
    entries.find((entry) => entry.path === 'work.json') ||
    entries.find((entry) => entry.path === 'work_json.json') ||
    entries.find((entry) => /^[^/]+\.json$/i.test(entry.path));
  if (!jsonEntry) {
    setStatus('这个 zip 里没有找到 work.json，无法预览。', 'error');
    return;
  }

  let workJSON: any;
  try {
    workJSON = JSON.parse(new TextDecoder().decode(jsonEntry.data));
  } catch {
    setStatus('work.json 内容不是合法的 JSON，无法预览。', 'error');
    return;
  }

  // Previewing is always local: point the bundle at the unpacked vr/ assets
  // and make the certificate parseable for Five's lenient local path.
  normalizeWorkForLocal(workJSON);

  fileStore = new Map();
  for (const entry of entries) {
    if (entry.path.endsWith('/')) continue;
    const key = entry.path.replace(/^\/+/, '');
    fileStore.set(key, new Blob([entry.data as unknown as BlobPart], { type: mimeFor(entry.path) }));
  }

  // Show the viewer first so the canvas has real dimensions at append time and
  // actually draws the scene.
  uploader.hidden = true;
  viewer.hidden = false;
  setStatus('正在渲染…', 'busy');
  try {
    await mountFive(workJSON);
  } catch (error) {
    setStatus(`渲染失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    uploader.hidden = false;
    viewer.hidden = true;
    return;
  }
  setStatus('');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void handleFile(file);
});

dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('is-dragging');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragging'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('is-dragging');
  const file = event.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
});

modeBtn.addEventListener('click', () => {
  if (!five) return;
  const { mode } = five.getCurrentState();
  if (mode === Five.Mode.Panorama) five.changeMode(Five.Mode.Floorplan);
  else five.changeMode(Five.Mode.Panorama);
});

againBtn.addEventListener('click', resetToUploader);

window.addEventListener('resize', () => {
  if (five) five.refresh();
});
