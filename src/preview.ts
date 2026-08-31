import { Five } from '@realsee/five';
import * as THREE from 'three';
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

// Realsee Five only renders a work when its signed `base_url` / `allow_hosts`
// match the serving host & the signature verifies. Outside RealSee's own hosts
// (localhost / IPs / *.realsee / *.lianjia …) that check is enforced, so any
// rewrite of the signed payload (base_url, allow_hosts, certificate) → "Invalid
// signature" — exactly the local-vs-deployed difference.
//
// Five skips that verification when a work is supplied as a *verified reference*:
// an object carrying a `getURL` member (see five/work/workVerify). We rebuild the
// raw work as such a reference, which lets us set base_url to ./vr freely. Asset
// requests then resolve to the archive bytes via the fetch/XHR/Image interceptors
// below, regardless of host.
function buildTrustedWork(workJSON: Record<string, any>): Record<string, any> {
  const initial = workJSON.initial ?? {};
  const horizon = Array.isArray(workJSON.panorama?.list)
    ? workJSON.panorama.list
    : Array.isArray(workJSON.panorama?.info)
      ? workJSON.panorama.info
      : [];
  const observers = Array.isArray(workJSON.observers) ? workJSON.observers : [];

  const reference: Record<string, any> = {
    getURL: () => './vr',
    allowHosts: ['*'],
    expire: new Date(Number(workJSON.expire_at) || Date.now() + 6e10),
    issuer: 'auto',
    projectId: workJSON.project_id ?? workJSON.vr_code ?? '',
    workCode: workJSON.vr_code ?? workJSON.code ?? workJSON.work_code ?? '',
    name: workJSON.name ?? '',
    baseURL: './vr',
    initial: {
      mode: 'Panorama',
      panoIndex: initial.pano_index != null ? initial.pano_index : 0,
      longitude: initial.longitude,
      latitude: initial.latitude,
      fov: initial.fov,
    },
    model: workJSON.model
      ? {
          file: workJSON.model.file_url,
          textureBase: workJSON.model.material_base_url,
          textures: Array.isArray(workJSON.model.material_textures)
            ? workJSON.model.material_textures.slice()
            : [],
          upAxis: workJSON.model.up_axis,
          layers: [],
        }
      : undefined,
    observers: observers.map((o: Record<string, any>, i: number) => {
      const pano = horizon[i] ?? {};
      return {
        index: o.index != null ? o.index : i,
        panoIndex: i,
        derivedId: o.derived_id != null ? o.derived_id : 0,
        derivedIdStr: o.derived_id_str ?? String(o.derived_id != null ? o.derived_id : i),
        floorIndex: o.floor_index != null ? o.floor_index : 0,
        position: new THREE.Vector3().fromArray(o.position ?? [0, 0, 0]),
        standingPosition: new THREE.Vector3().fromArray(o.standing_position ?? [0, 0, 0]),
        quaternion: new THREE.Quaternion(
          o.quaternion?.x ?? 0,
          o.quaternion?.y ?? 0,
          o.quaternion?.z ?? 0,
          o.quaternion?.w ?? 1,
        ),
        accessibleNodes: Array.isArray(o.accessible_nodes) ? o.accessible_nodes.slice() : [],
        active: o.active !== false,
        loadable: o.loadable != null ? o.loadable : true,
        images: {
          sizeList: [2048],
          up: pano.up,
          down: pano.down,
          right: pano.right,
          left: pano.left,
          front: pano.front,
          back: pano.back,
        },
      };
    }),
  };
  return reference;
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
      <a class="preview__back" href="./">← 打包工具</a>
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
// Rewrite asset network traffic to the in-memory bytes unpacked from the
// uploaded archive.
//
// Realsee Five loads scene assets through XMLHttpRequest and Image elements —
// NOT fetch — so a fetch-only interceptor leaves every asset request untouched
// and the browser 404s against the dev server. We therefore patch all three
// primitives Five actually uses:
//   • fetch   -> return the stored Blob directly
//   • XHR     -> rewrite the request URL to a blob: object URL (the real XHR
//                still fires progress / load / error and honours responseType)
//   • <img>   -> rewrite src to a blob: object URL
// A cached blob: URL keeps each asset's bytes alive for the whole session.
// ---------------------------------------------------------------------------

const blobUrlByPath = new Map<string, string>();

function objectUrlFor(blob: Blob, path: string): string {
  let url = blobUrlByPath.get(path);
  if (!url) {
    url = URL.createObjectURL(blob);
    blobUrlByPath.set(path, url);
  }
  return url;
}

// Resolve a request URL to the stored path for it, tolerating a base_url `vr/`
// prefix mismatch (the archive may or may not carry the vr/ segment).
function lookupStoredPath(url: string): string | undefined {
  const path = urlToPath(url);
  if (!path) return undefined;
  if (fileStore.has(path)) return path;
  if (path.startsWith('vr/') && fileStore.has(path.slice(3))) return path.slice(3);
  const prefixed = path.startsWith('vr/') ? path : `vr/${path}`;
  if (fileStore.has(prefixed)) return prefixed;
  return undefined;
}

function storedBlobFor(url: string): Blob | undefined {
  const key = lookupStoredPath(url);
  return key ? fileStore.get(key) : undefined;
}

// --- fetch ---------------------------------------------------------------
const origFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const blob = storedBlobFor(url);
  if (blob) {
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    });
  }
  return origFetch(input, init);
};

// --- XMLHttpRequest --------------------------------------------------------
const NativeXMLHttpRequest = window.XMLHttpRequest as typeof window.XMLHttpRequest;
const nativeOpen = NativeXMLHttpRequest.prototype.open;
NativeXMLHttpRequest.prototype.open = function (
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  async?: boolean,
  username?: string | null,
  password?: string | null,
): void {
  let target = url;
  const key = lookupStoredPath(String(url));
  const blob = key ? fileStore.get(key) : undefined;
  if (blob) target = objectUrlFor(blob, key as string);
  return nativeOpen.call(this, method, target, async ?? true, username, password);
};

// --- Image --------------------------------------------------------------
const imgProto = HTMLImageElement.prototype;
const srcDescriptor = Object.getOwnPropertyDescriptor(imgProto, 'src');
if (srcDescriptor?.set && srcDescriptor.get) {
  Object.defineProperty(imgProto, 'src', {
    configurable: srcDescriptor.configurable,
    enumerable: srcDescriptor.enumerable,
    get(this: HTMLImageElement) {
      return srcDescriptor.get!.call(this) as string;
    },
    set(this: HTMLImageElement, value: string) {
      let v = value;
      const key = lookupStoredPath(String(value));
      const blob = key ? fileStore.get(key) : undefined;
      if (blob) v = objectUrlFor(blob, key as string);
      srcDescriptor.set!.call(this, v);
    },
  });
}

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
    const loading = instance.load(buildTrustedWork(workJSON));
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
  blobUrlByPath.clear();
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
    workJSON.allow_hosts.push('aikongjain-vr.fangjin.life');
    console.log('----------------------', workJSON)
  } catch {
    setStatus('work.json 内容不是合法的 JSON，无法预览。', 'error');
    return;
  }

  // Previewing is always local. We hand Five a trusted reference (built later in
  // mountFive) whose base_url is ./vr, so assets resolve to the unpacked archive
  // below; the original signed payload is left untouched so Five's verification
  // (only enforced off RealSee's own hosts) never trips over our rewrites.
  fileStore = new Map();
  blobUrlByPath.clear();
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
