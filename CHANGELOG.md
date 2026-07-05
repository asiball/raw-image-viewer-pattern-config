# Change Log

All notable changes to the "rawviewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- **Colormap selector** for grayscale-family formats (`gray8`, `gray16le`, `gray16be`, `depth16`, `float32`) — choose between Grayscale (default), Jet, Viridis, and Hot, applied after window/level normalization

### Changed

- Webview styling now uses VS Code theme variables for better light/dark/high-contrast support; added focus-visible outlines and tooltips to the viewer toolbar buttons

### Fixed

- Error boxes now expose `role="alert"` for screen readers, and the colormap selector has an accessible label
- `rawviewer.createConfig` now overwrites an existing but empty `.rawimagerc` with the template instead of leaving it untouched
- The `render` message handler called an undefined `renderImage()` function (introduced by a prior refactor), which meant no image was ever rendered and errors were silently swallowed; the inline rendering logic now runs correctly

## [0.1.0] - 2026-04-27

### Added

- **Pattern-based `.rawimagerc`** — configuration is now structured as a `patterns` object whose keys are glob patterns (like `.editorconfig`), enabling per-file or per-directory settings from a single config file
- **`rawviewer.createConfig` command** — creates a `.rawimagerc` template in the current directory and opens it in the editor
- **`float32` format** — 32-bit little-endian float grayscale with automatic window/level normalization
- **`depth16` format** — 16-bit little-endian depth image with automatic window/level normalization
- **Window/Level sliders** — interactive Min/Max sliders for grayscale, float32, and depth16 images; auto-initialised to the detected value range; Reset button restores the initial values
- **Pixel value inspection** — status bar below the canvas shows cursor coordinates and per-format raw pixel values (RGB channels for color images; raw Gray value for grayscale/depth/float formats)
- Manual GitHub Actions release dispatch so GitHub Mobile can publish releases without pushing tags
- Release workflow support for both manual dispatch and `v*` tag pushes

### Changed

- Large-scale refactor: split `extension.ts` into 5 focused modules (`types.ts`, `decoder.ts`, `config.ts`, `webviewHtml.ts`) for improved maintainability and code organization

## [0.0.3] - 2026-04-15

### Added

- **Fit to Screen** toggle button in the viewer toolbar — keeps the image fitted to the viewport (enabled by default); clicking again disables auto-fit so you can freely zoom and pan
- **1:1** button to jump to 100 % (pixel-exact) zoom at any time
- Automatic re-fit on viewport resize when Fit mode is active
- Double-click on the canvas re-enables Fit mode

### Changed

- The former **Reset Zoom** button has been replaced by the **Fit** toggle and the **1:1** button for clearer semantics
- Manual zoom (Ctrl+Scroll) or drag-pan now automatically disables Fit mode so the user's manual position is preserved

## [0.0.2] - 2026-03-12

### Added

- Custom read-only editor for raw binary image files (`.raw`, `.bin`, `.data`, `.img`, `.gray`, `.yuv`)
- Right-click context menu entry **Open as Raw Image** for any file in the Explorer or editor title bar
- Canvas-based renderer supporting 10 pixel formats:
  - `gray8` — 8-bit grayscale
  - `gray16le` / `gray16be` — 16-bit grayscale (little-endian / big-endian)
  - `rgb24` / `bgr24` — 24-bit RGB / BGR
  - `rgba32` / `bgra32` — 32-bit RGBA / BGRA
  - `yuv420p` — planar YUV 4:2:0
  - `nv12` — semi-planar YUV 4:2:0
  - `yuyv422` — packed YUV 4:2:2
- Streaming decode for memory-efficient rendering of `gray8`, `gray16le/be`, `rgb24`, `bgr24`, `rgba32`, `bgra32`
- `.rawimagerc` configuration file support (JSON, walks up the directory tree like `.editorconfig`)
- JSON schema for `.rawimagerc` — VS Code provides autocomplete and validation automatically
- Workspace fallback settings: `rawviewer.defaultWidth`, `rawviewer.defaultHeight`, `rawviewer.defaultHeaderSize`, `rawviewer.defaultFormat`, `rawviewer.inferFromFilename`
- Filename inference — extracts width, height, and format from patterns like `frame_1920x1080_rgb24.raw`
- Info bar showing width, height, format, header size, file size, and configuration source
- **Export PNG** button to save the rendered canvas as a `.png` file
- Auto-refresh when the image file or any `.rawimagerc` in the search path changes
- GitHub Actions workflow to build and upload a `.vsix` artifact (`build-vsix.yml`)
- GitHub Actions workflow to create a GitHub Release with the `.vsix` attached when a `v*` tag is pushed (`release.yml`)
