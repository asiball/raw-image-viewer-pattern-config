# Change Log

All notable changes to the "rawviewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
