/**
 * webview/main.ts — Webview のエントリーポイント
 *
 * VS Code の Webview（拡張機能の内側に表示される小さなブラウザ）内で実行される
 * TypeScript コード。esbuild によって `out/webview/main.js` に IIFE 形式で
 * バンドルされ、`webviewHtml.ts` が生成する HTML から
 * `<script nonce="..." src="...">` として読み込まれる。
 *
 * 【旧実装からの変更点】
 * 以前は decoder.ts の関数を `.toString()` で文字列化し、webviewHtml.ts の
 * テンプレート文字列に直接埋め込んでいた。このファイルではその代わりに
 * decoder.ts / types.ts を通常の ES import で共有する。これにより Extension
 * 側（Node）と Webview 側（ブラウザ、バンドル後）が同一のコンパイル済み
 * ロジックを実行するようになり、tsc/ESLint の検査も届くようになった。
 */

import {
  appendFloat32Chunk,
  appendGrayChunk,
  appendRawImageChunk,
  applyWindowLevel,
  createFloat32DecodeState,
  createGrayDecodeState,
  createRawImageDecodeState,
  decodeRawImageToRgba,
} from '../decoder';
import { getRawImageFormatDescriptor, rawImageFormatDescriptorList } from '../formats';
import { grayscaleStreamFormats, streamDecodableFormats } from '../types';
import type {
  ExtensionToWebviewMessage,
  GrayscaleStreamFormat,
  RawImageConfig,
  StreamDecodableRawImageFormat,
  WebviewToExtensionMessage,
} from '../types';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();

function isGrayscaleFormat(format: RawImageConfig['format']): format is GrayscaleStreamFormat {
  return (grayscaleStreamFormats as readonly string[]).includes(format);
}

function isStreamDecodableFormat(
  format: RawImageConfig['format']
): format is StreamDecodableRawImageFormat {
  return (streamDecodableFormats as readonly string[]).includes(format);
}

type ColormapName = 'Grayscale' | 'Jet' | 'Viridis' | 'Hot';
const colormapNames: ColormapName[] = ['Grayscale', 'Jet', 'Viridis', 'Hot'];

function buildColormapLut(name: ColormapName): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  let r: number;
  let g: number;
  let b: number;
  if (name === 'Viridis') {
    const vp = [
      [0, 68, 1, 84],
      [64, 59, 82, 139],
      [128, 33, 145, 140],
      [192, 94, 201, 98],
      [255, 253, 231, 37],
    ];
    for (let i = 0; i < 256; i++) {
      let s = 0;
      while (s < vp.length - 2 && i >= vp[s + 1][0]) {
        s++;
      }
      const t = (i - vp[s][0]) / (vp[s + 1][0] - vp[s][0]);
      r = Math.round(vp[s][1] + t * (vp[s + 1][1] - vp[s][1]));
      g = Math.round(vp[s][2] + t * (vp[s + 1][2] - vp[s][2]));
      b = Math.round(vp[s][3] + t * (vp[s + 1][3] - vp[s][3]));
      lut[i * 3] = r;
      lut[i * 3 + 1] = g;
      lut[i * 3 + 2] = b;
    }
  } else {
    for (let i = 0; i < 256; i++) {
      if (name === 'Jet') {
        if (i < 64) {
          r = 0;
          g = i * 4;
          b = 255;
        } else if (i < 128) {
          r = 0;
          g = 255;
          b = 255 - (i - 64) * 4;
        } else if (i < 192) {
          r = (i - 128) * 4;
          g = 255;
          b = 0;
        } else {
          r = 255;
          g = 255 - (i - 192) * 4;
          b = 0;
        }
      } else if (name === 'Hot') {
        if (i < 85) {
          r = Math.round(i * 3);
          g = 0;
          b = 0;
        } else if (i < 170) {
          r = 255;
          g = Math.round((i - 85) * 3);
          b = 0;
        } else {
          r = 255;
          g = 255;
          b = Math.round((i - 170) * 3);
        }
      } else {
        r = i;
        g = i;
        b = i;
      }
      lut[i * 3] = r;
      lut[i * 3 + 1] = g;
      lut[i * 3 + 2] = b;
    }
  }
  return lut;
}

// --- 状態変数 ---
let readyTimer: ReturnType<typeof setInterval> | null = null; // Extension への ready 送信インターバル
let startupTimeout: ReturnType<typeof setTimeout> | null = null; // タイムアウト表示用タイマー
let activeAbortController: AbortController | null = null; // fetch のキャンセル用
let activeRenderId = 0; // 最新のレンダリング ID（古いレンダリングを無視するため）
let activeResizeObserver: ResizeObserver | null = null; // ResizeObserver の参照（再レンダリング時に解放するため）
let currentColormap: ColormapName = 'Grayscale';
let currentColormapLut: Uint8Array | null = null; // buildColormapLut() の結果をキャッシュ（Grayscale は null）

// パン操作（mousemove/mouseup）は window に直接バインドするため、
// render のたびに前回のリスナーを解除してから新しいものを登録する。
// これをしないと再描画のたびにリスナーが蓄積するリークになる
// （修正: 旧実装ではこの解除がなく、開いたまま何度も再描画するとリスナーが増え続けていた）。
let activePanMoveHandler: ((e: MouseEvent) => void) | null = null;
let activePanUpHandler: (() => void) | null = null;

function clearActivePanHandlers(): void {
  if (activePanMoveHandler) {
    window.removeEventListener('mousemove', activePanMoveHandler);
    activePanMoveHandler = null;
  }
  if (activePanUpHandler) {
    window.removeEventListener('mouseup', activePanUpHandler);
    activePanUpHandler = null;
  }
}

function applyColormapToData(data: Uint8ClampedArray, npx: number): void {
  if (!currentColormapLut) {
    return;
  }
  const lut = currentColormapLut;
  for (let wi = 0; wi < npx; wi++) {
    const wg = data[wi * 4];
    data[wi * 4] = lut[wg * 3];
    data[wi * 4 + 1] = lut[wg * 3 + 1];
    data[wi * 4 + 2] = lut[wg * 3 + 2];
  }
}

// --- ユーティリティ ---

function clearReadyTimer(): void {
  if (readyTimer !== null) {
    clearInterval(readyTimer);
    readyTimer = null;
  }
  if (startupTimeout !== null) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
}

// HTML を安全に表示するためにエスケープする（XSS 対策）
function escapeHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 設定未検出時のヘルプテーブルの行を、`src/formats.ts` の記述子テーブルから生成する
// （フォーマットを追加してもここを手で更新する必要がないようにするため）。
function buildFormatHelpTableRows(): string {
  return rawImageFormatDescriptorList
    .map(
      (descriptor) =>
        '<tr><td><code>' +
        escapeHtml(descriptor.name) +
        '</code></td><td>' +
        escapeHtml(descriptor.description) +
        '</td><td>' +
        descriptor.bytesPerPixel +
        '</td></tr>'
    )
    .join('');
}

function showRuntimeError(err: unknown): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }
  root.className = 'center';
  root.innerHTML =
    '<div class="error-box" role="alert"><strong>Webview Error:</strong> ' +
    escapeHtml(String(err)) +
    '</div>';
}

// --- メッセージハンドラ（Extension からのメッセージを受け取る）---

function isExtensionToWebviewMessage(value: unknown): value is ExtensionToWebviewMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return type === 'render' || type === 'error';
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const msg = event.data;
  const root = document.getElementById('root');
  if (!root) {
    return;
  }
  if (!isExtensionToWebviewMessage(msg)) {
    return; // プロトコル外のメッセージは無視する
  }

  if (msg.type === 'error') {
    clearReadyTimer();
    root.className = 'center';
    root.innerHTML =
      '<div class="error-box" role="alert"><strong>Error:</strong> ' +
      escapeHtml(msg.message) +
      '</div>';
    return;
  }

  // msg.type === 'render'
  clearReadyTimer();
  currentColormap = 'Grayscale';
  currentColormapLut = null;
  const { config, configSource, fileUri, fileSize } = msg;

  if (!config) {
    root.className = 'center';
    root.innerHTML =
      '<div class="no-config-box">' +
      '<h3>⚙ No .rawimagerc configuration found</h3>' +
      '<p>Create a <code>.rawimagerc</code> file in the same directory as the file, or any parent directory, to configure how to render this binary file as an image.</p>' +
      '<p>Alternatively, set workspace defaults such as <code>rawviewer.defaultWidth</code> and <code>rawviewer.defaultHeight</code>, or include metadata in the filename like <code>frame_1920x1080_rgb24.raw</code>.</p>' +
      '<pre>{\n  "patterns": {\n    "*": {\n      "width": 640,\n      "height": 480,\n      "headerSize": 0,\n      "format": "rgb24"\n    }\n  }\n}</pre>' +
      '<p>Supported formats:</p>' +
      '<table>' +
      '<tr><th>Format</th><th>Description</th><th>Bytes/pixel</th></tr>' +
      buildFormatHelpTableRows() +
      '</table>' +
      '</div>';
    return;
  }

  const width = config.width;
  const height = config.height;
  const headerSize = config.headerSize || 0;
  const format = config.format || 'rgb24';

  if (!fileUri) {
    root.className = 'center';
    root.innerHTML =
      '<div class="error-box" role="alert"><strong>Error:</strong> Missing file URI for webview fetch.</div>';
    return;
  }

  // デコードを開始する前に、ファイルサイズがこのフォーマット・解像度に必要な
  // 最小バイト数を満たしているか検証する。以前はストリーミング系フォーマットや
  // yuyv422 はここでチェックせず、データ不足時に無警告で黒画像を表示していた。
  // headerSize が fileSize 以上の場合も「利用可能バイト数 0」として扱う。
  const requiredBytesForFormat = getRawImageFormatDescriptor(format).requiredBytes(width, height);
  const availableBytes = fileSize - headerSize;
  if (availableBytes < requiredBytesForFormat) {
    root.className = 'center';
    root.innerHTML =
      '<div class="error-box" role="alert"><strong>Error:</strong> Insufficient data: ' +
      escapeHtml(format) +
      ' ' +
      width +
      'x' +
      height +
      ' requires ' +
      requiredBytesForFormat +
      ' bytes, file has ' +
      Math.max(0, availableBytes) +
      ' bytes after header.</div>';
    return;
  }

  // 既存のフェッチをキャンセルして新しいレンダリングを開始する
  if (activeAbortController) {
    activeAbortController.abort();
  }
  if (activeResizeObserver) {
    activeResizeObserver.disconnect();
    activeResizeObserver = null;
  }
  clearActivePanHandlers();

  activeAbortController = typeof AbortController === 'function' ? new AbortController() : null;
  const currentRenderId = ++activeRenderId;

  const grayFormat = isGrayscaleFormat(format) ? format : null;
  const isFloat32 = format === 'float32';
  const streamFormat = !grayFormat && !isFloat32 && isStreamDecodableFormat(format) ? format : null;

  root.className = 'center';
  root.innerHTML = '<div class="spinner"></div><p>Loading...</p>';

  // VS Code の Webview URI スキームを使ってファイルを fetch する
  fetch(fileUri, activeAbortController ? { signal: activeAbortController.signal } : undefined)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error('Failed to read file in webview: HTTP ' + response.status);
      }

      // Canvas を作成してデコードしたピクセルを書き込む準備をする
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('2D canvas context is not available.');
      }
      const imageData = ctx.createImageData(width, height);
      const pixels = imageData.data;

      let rawGray: Uint16Array | Float32Array | null = null; // ウィンドウ調整用の生グレー値
      let grayMinValue = 0;
      let grayMaxValue = 255;
      let grayWindowMin = 0;
      let grayWindowMax = 255;
      let isFloatGray = false;

      // --- フォーマット別デコード処理 ---

      if (grayFormat) {
        // グレースケール: ストリーミングで rawGray に書き込み後、ウィンドウ適用
        const grayState = createGrayDecodeState(width, height, headerSize, grayFormat);
        if (response.body && typeof response.body.getReader === 'function') {
          const grayReader = response.body.getReader();
          try {
            while (grayState.pixelsWritten < grayState.totalPixels) {
              const grayStep = await grayReader.read();
              if (grayStep.done) {
                break;
              }
              if (grayStep.value) {
                appendGrayChunk(grayState, grayStep.value);
              }
            }
            if (
              grayState.pixelsWritten >= grayState.totalPixels &&
              typeof grayReader.cancel === 'function'
            ) {
              await grayReader.cancel();
            }
          } finally {
            grayReader.releaseLock();
          }
        } else {
          const rawBuf = new Uint8Array(await response.arrayBuffer());
          appendGrayChunk(grayState, rawBuf);
        }
        rawGray = grayState.rawGray;
        grayMaxValue = grayState.maxValue;
        let autoMin = grayState.autoMin;
        let autoMax = grayState.autoMax;
        if (autoMin >= autoMax) {
          autoMin = 0;
          autoMax = grayMaxValue;
        }
        grayWindowMin = autoMin;
        grayWindowMax = autoMax;
        applyWindowLevel(rawGray, width * height, grayWindowMin, grayWindowMax, pixels);
        applyColormapToData(pixels, width * height);
      } else if (isFloat32) {
        // float32: ストリーミングで rawGrayF32 に書き込み後、ウィンドウ適用
        const f32State = createFloat32DecodeState(width, height, headerSize);
        if (response.body && typeof response.body.getReader === 'function') {
          const f32Reader = response.body.getReader();
          try {
            while (f32State.pixelsWritten < f32State.totalPixels) {
              const f32Step = await f32Reader.read();
              if (f32Step.done) {
                break;
              }
              if (f32Step.value) {
                appendFloat32Chunk(f32State, f32Step.value);
              }
            }
            if (
              f32State.pixelsWritten >= f32State.totalPixels &&
              typeof f32Reader.cancel === 'function'
            ) {
              await f32Reader.cancel();
            }
          } finally {
            f32Reader.releaseLock();
          }
        } else {
          const f32Buf = new Uint8Array(await response.arrayBuffer());
          appendFloat32Chunk(f32State, f32Buf);
        }
        rawGray = f32State.rawGrayF32;
        isFloatGray = true;
        let f32AutoMin = f32State.autoMin;
        let f32AutoMax = f32State.autoMax;
        if (!isFinite(f32AutoMin) || !isFinite(f32AutoMax) || f32AutoMin >= f32AutoMax) {
          f32AutoMin = 0;
          f32AutoMax = 1;
        }
        grayMinValue = f32AutoMin;
        grayMaxValue = f32AutoMax;
        grayWindowMin = f32AutoMin;
        grayWindowMax = f32AutoMax;
        applyWindowLevel(rawGray, width * height, grayWindowMin, grayWindowMax, pixels);
        applyColormapToData(pixels, width * height);
      } else if (response.body && typeof response.body.getReader === 'function' && streamFormat) {
        // RGB/BGR 系: ストリーミングで直接 pixels に書き込む
        const reader = response.body.getReader();
        const decodeState = createRawImageDecodeState(width, height, headerSize, streamFormat);
        try {
          while (decodeState.pixelsWritten < decodeState.totalPixels) {
            const step = await reader.read();
            if (step.done) {
              break;
            }
            if (step.value) {
              appendRawImageChunk(decodeState, step.value, pixels);
            }
          }
          if (
            decodeState.pixelsWritten >= decodeState.totalPixels &&
            typeof reader.cancel === 'function'
          ) {
            await reader.cancel();
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        // YUV 系など: 全バイトを一括でデコードする
        const rawBytes = new Uint8Array(await response.arrayBuffer());
        imageData.data.set(
          decodeRawImageToRgba(rawBytes.subarray(headerSize), width, height, format)
        );
      }

      // レンダリング中に新しいレンダリングが始まった場合は破棄する
      if (currentRenderId !== activeRenderId) {
        return;
      }

      ctx.putImageData(imageData, 0, 0);

      // --- UI の構築 ---

      root.className = 'viewer';
      root.innerHTML = '';

      const viewerHeader = document.createElement('div');
      viewerHeader.className = 'viewer-header';

      // 画像情報バー（幅・高さ・フォーマット・ファイルサイズなど）
      const infoBar = document.createElement('div');
      infoBar.className = 'info-bar';
      infoBar.textContent =
        width +
        ' × ' +
        height +
        ' | ' +
        format +
        ' | header: ' +
        headerSize +
        ' B | file: ' +
        fileSize +
        ' B | source: ' +
        (configSource || '.rawimagerc');

      const exportButton = document.createElement('button');
      exportButton.type = 'button';
      exportButton.className = 'action-button';
      exportButton.textContent = 'Export PNG';
      exportButton.title = 'Export current view as a PNG image';
      exportButton.addEventListener('click', () => {
        // Canvas の内容を PNG として Extension に送信する
        const message: WebviewToExtensionMessage = {
          type: 'savePng',
          dataUrl: canvas.toDataURL('image/png'),
        };
        vscode.postMessage(message);
      });

      const fitButton = document.createElement('button');
      fitButton.type = 'button';
      fitButton.className = 'action-button active';
      fitButton.textContent = 'Fit';
      fitButton.title = 'Fit image to window';

      const zoom1to1Button = document.createElement('button');
      zoom1to1Button.type = 'button';
      zoom1to1Button.className = 'action-button';
      zoom1to1Button.textContent = '1:1';
      zoom1to1Button.title = 'View image at 100% original size';

      // ズーム・パン用のビューポート
      const viewport = document.createElement('div');
      viewport.className = 'canvas-viewport';

      const zoomIndicator = document.createElement('div');
      zoomIndicator.className = 'zoom-indicator';
      zoomIndicator.textContent = '100%';

      const zoomHint = document.createElement('div');
      zoomHint.className = 'zoom-hint';
      zoomHint.textContent = 'Ctrl+Scroll: zoom · Drag: pan · Dbl-click: fit';

      canvas.style.transformOrigin = '0 0';

      // ズーム・パンの状態変数
      let panX = 0;
      let panY = 0;
      let zoom = 1.0;
      let fitMode = true;
      let isPanning = false;
      let dragStartX = 0;
      let dragStartY = 0;
      let dragStartPanX = 0;
      let dragStartPanY = 0;

      function applyTransform(): void {
        canvas.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
        zoomIndicator.textContent = Math.round(zoom * 100) + '%';
      }

      function fitToViewport(): void {
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        if (vw > 0 && vh > 0 && canvas.width > 0 && canvas.height > 0) {
          zoom = Math.min(vw / canvas.width, vh / canvas.height);
          panX = (vw - canvas.width * zoom) / 2;
          panY = (vh - canvas.height * zoom) / 2;
        } else {
          zoom = 1;
          panX = 0;
          panY = 0;
        }
        applyTransform();
      }

      function setFitMode(enabled: boolean): void {
        fitMode = enabled;
        if (enabled) {
          fitButton.classList.add('active');
          fitToViewport();
        } else {
          fitButton.classList.remove('active');
        }
      }

      fitButton.addEventListener('click', () => {
        setFitMode(!fitMode);
      });

      zoom1to1Button.addEventListener('click', () => {
        setFitMode(false);
        zoom = 1.0;
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        panX = (vw - canvas.width) / 2;
        panY = (vh - canvas.height) / 2;
        applyTransform();
      });

      // Ctrl+スクロールでズーム（マウス位置を中心に拡縮）
      viewport.addEventListener(
        'wheel',
        (e: WheelEvent) => {
          if (!e.ctrlKey) {
            return;
          }
          e.preventDefault();
          fitMode = false;
          fitButton.classList.remove('active');
          const rect = viewport.getBoundingClientRect();
          const cx = (e.clientX - rect.left - panX) / zoom;
          const cy = (e.clientY - rect.top - panY) / zoom;
          const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
          zoom = Math.max(0.01, Math.min(32, zoom * factor));
          panX = e.clientX - rect.left - cx * zoom;
          panY = e.clientY - rect.top - cy * zoom;
          applyTransform();
        },
        { passive: false }
      );

      // ドラッグでパン
      viewport.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0) {
          return;
        }
        isPanning = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartPanX = panX;
        dragStartPanY = panY;
        viewport.classList.add('panning');
        e.preventDefault();
      });

      // 修正: window スコープの mousemove/mouseup は再描画のたびに蓄積しないよう、
      // ハンドラの参照を保持して次回 render 冒頭（clearActivePanHandlers）で解除する。
      const panMoveHandler = (e: MouseEvent): void => {
        if (!isPanning) {
          return;
        }
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (fitMode && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
          fitMode = false;
          fitButton.classList.remove('active');
        }
        panX = dragStartPanX + dx;
        panY = dragStartPanY + dy;
        applyTransform();
      };
      const panUpHandler = (): void => {
        if (isPanning) {
          isPanning = false;
          viewport.classList.remove('panning');
        }
      };
      window.addEventListener('mousemove', panMoveHandler);
      window.addEventListener('mouseup', panUpHandler);
      activePanMoveHandler = panMoveHandler;
      activePanUpHandler = panUpHandler;

      // ダブルクリックでフィットモードに戻る
      viewport.addEventListener('dblclick', () => {
        setFitMode(true);
      });

      // ビューポートサイズ変更時にフィットモードなら再フィットする
      if (typeof ResizeObserver === 'function') {
        activeResizeObserver = new ResizeObserver(() => {
          if (fitMode) {
            fitToViewport();
          }
        });
        activeResizeObserver.observe(viewport);
      }

      const spacer = document.createElement('div');
      spacer.className = 'spacer';

      const buttonGroup = document.createElement('div');
      buttonGroup.className = 'button-group';
      buttonGroup.appendChild(fitButton);
      buttonGroup.appendChild(zoom1to1Button);

      viewerHeader.appendChild(infoBar);
      viewerHeader.appendChild(spacer);
      viewerHeader.appendChild(exportButton);
      viewerHeader.appendChild(buttonGroup);
      root.appendChild(viewerHeader);

      viewport.appendChild(canvas);
      viewport.appendChild(zoomIndicator);
      viewport.appendChild(zoomHint);
      root.appendChild(viewport);

      requestAnimationFrame(fitToViewport);

      // ピクセル情報バー（マウスオーバーで座標と値を表示）
      const pixelInfoBar = document.createElement('div');
      pixelInfoBar.className = 'pixel-info-bar';
      root.appendChild(pixelInfoBar);

      canvas.addEventListener('mousemove', (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const px = Math.floor((e.clientX - rect.left) * scaleX);
        const py = Math.floor((e.clientY - rect.top) * scaleY);
        if (px < 0 || px >= width || py < 0 || py >= height) {
          pixelInfoBar.textContent = '';
          return;
        }
        let text = '(' + px + ', ' + py + ')';
        if (rawGray !== null) {
          const rawVal = rawGray[py * width + px];
          text += '  Gray: ' + (isFloatGray ? rawVal.toFixed(4) : rawVal);
        } else {
          const idx4 = (py * width + px) * 4;
          text +=
            '  R: ' +
            imageData.data[idx4] +
            '  G: ' +
            imageData.data[idx4 + 1] +
            '  B: ' +
            imageData.data[idx4 + 2];
        }
        pixelInfoBar.textContent = text;
      });

      canvas.addEventListener('mouseleave', () => {
        pixelInfoBar.textContent = '';
      });

      // グレースケール・float32 の場合はウィンドウ/レベルスライダーを表示する
      if (rawGray !== null) {
        const capturedRawGray = rawGray;
        const totalPx = width * height;
        const wlControls = document.createElement('div');
        wlControls.className = 'window-controls';

        const minValSpan = document.createElement('span');
        minValSpan.textContent = isFloatGray ? grayWindowMin.toFixed(3) : String(grayWindowMin);
        const minLbl = document.createElement('label');
        minLbl.appendChild(document.createTextNode('Min '));
        const minSlider = document.createElement('input');
        minSlider.type = 'range';
        minSlider.min = String(grayMinValue);
        minSlider.max = String(grayMaxValue);
        minSlider.value = String(grayWindowMin);
        if (isFloatGray) {
          minSlider.step = 'any';
        }
        minLbl.appendChild(minSlider);
        minLbl.appendChild(document.createTextNode(' '));
        minLbl.appendChild(minValSpan);

        const maxValSpan = document.createElement('span');
        maxValSpan.textContent = isFloatGray ? grayWindowMax.toFixed(3) : String(grayWindowMax);
        const maxLbl = document.createElement('label');
        maxLbl.appendChild(document.createTextNode('Max '));
        const maxSlider = document.createElement('input');
        maxSlider.type = 'range';
        maxSlider.min = String(grayMinValue);
        maxSlider.max = String(grayMaxValue);
        maxSlider.value = String(grayWindowMax);
        if (isFloatGray) {
          maxSlider.step = 'any';
        }
        maxLbl.appendChild(maxSlider);
        maxLbl.appendChild(document.createTextNode(' '));
        maxLbl.appendChild(maxValSpan);

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'window-reset';
        resetBtn.textContent = 'Reset';
        resetBtn.title = 'Reset window/level controls to defaults';

        const initialMin = grayWindowMin;
        const initialMax = grayWindowMax;
        const capturedCtx = ctx;
        const capturedImageData = imageData;
        const capturedIsFloat = isFloatGray;
        let rafPending = false;

        function readSliderVal(slider: HTMLInputElement): number {
          return capturedIsFloat ? parseFloat(slider.value) : parseInt(slider.value, 10);
        }
        function fmtSliderVal(val: number): string {
          return capturedIsFloat ? val.toFixed(3) : String(val);
        }

        // requestAnimationFrame でまとめて再描画する（スライダー操作を滑らかにする）
        function scheduleWindowRender(): void {
          if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => {
              rafPending = false;
              const wMin = readSliderVal(minSlider);
              const wMax = readSliderVal(maxSlider);
              minValSpan.textContent = fmtSliderVal(wMin);
              maxValSpan.textContent = fmtSliderVal(wMax);
              applyWindowLevel(capturedRawGray, totalPx, wMin, wMax, capturedImageData.data);
              applyColormapToData(capturedImageData.data, totalPx);
              capturedCtx.putImageData(capturedImageData, 0, 0);
            });
          }
        }

        minSlider.addEventListener('input', () => {
          const wMin = readSliderVal(minSlider);
          const wMax = readSliderVal(maxSlider);
          if (wMin > wMax) {
            minSlider.value = String(wMax);
          }
          scheduleWindowRender();
        });
        maxSlider.addEventListener('input', () => {
          const wMin = readSliderVal(minSlider);
          const wMax = readSliderVal(maxSlider);
          if (wMax < wMin) {
            maxSlider.value = String(wMin);
          }
          scheduleWindowRender();
        });
        resetBtn.addEventListener('click', () => {
          minSlider.value = String(initialMin);
          maxSlider.value = String(initialMax);
          scheduleWindowRender();
        });

        const colormapSelect = document.createElement('select');
        colormapSelect.className = 'colormap-select';
        colormapSelect.title = 'Colormap for grayscale display';
        colormapSelect.setAttribute('aria-label', 'Colormap');
        colormapNames.forEach((cm) => {
          const opt = document.createElement('option');
          opt.value = cm;
          opt.textContent = cm;
          if (cm === currentColormap) {
            opt.selected = true;
          }
          colormapSelect.appendChild(opt);
        });
        colormapSelect.addEventListener('change', () => {
          currentColormap = colormapSelect.value as ColormapName;
          currentColormapLut =
            currentColormap !== 'Grayscale' ? buildColormapLut(currentColormap) : null;
          requestAnimationFrame(() => {
            applyWindowLevel(
              capturedRawGray,
              totalPx,
              readSliderVal(minSlider),
              readSliderVal(maxSlider),
              capturedImageData.data
            );
            applyColormapToData(capturedImageData.data, totalPx);
            capturedCtx.putImageData(capturedImageData, 0, 0);
          });
        });

        wlControls.appendChild(minLbl);
        wlControls.appendChild(maxLbl);
        wlControls.appendChild(resetBtn);
        wlControls.appendChild(colormapSelect);
        root.appendChild(wlControls);
      }
    })
    .catch((err: unknown) => {
      if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError') {
        return; // 意図的なキャンセルは無視する
      }
      if (currentRenderId !== activeRenderId) {
        return;
      }
      root.className = 'center';
      root.innerHTML =
        '<div class="error-box" role="alert"><strong>Error:</strong> ' +
        escapeHtml(String(err)) +
        '</div>';
    });
});

// --- エラーハンドラ ---

window.addEventListener('error', (event: ErrorEvent) => {
  clearReadyTimer();
  showRuntimeError(event.error || event.message || 'Unknown script error');
});

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  clearReadyTimer();
  showRuntimeError(event.reason || 'Unhandled promise rejection');
});

// --- 起動時の Extension との同期 ---

// Extension が 'render' メッセージを送るまで 'ready' を繰り返し送信する。
// 起動タイミングのずれで最初のメッセージが届かないことがあるための対策。
readyTimer = setInterval(() => {
  const readyMessage: WebviewToExtensionMessage = { type: 'ready' };
  vscode.postMessage(readyMessage);
}, 250);
vscode.postMessage({ type: 'ready' } satisfies WebviewToExtensionMessage);

// 4秒以内に 'render' が届かない場合はエラーを表示する
startupTimeout = setTimeout(() => {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }
  root.className = 'center';
  root.innerHTML =
    '<div class="error-box" role="alert"><strong>Error:</strong> Extension host did not respond in time. Reload the extension host and reopen the file.</div>';
}, 4000);
