# Specification: Raw Image Viewer (VS Code Extension)

## 1. Overview
The **Raw Image Viewer** is a Visual Studio Code extension designed to visualize raw binary image data directly within the editor. It provides a custom editor using a Canvas-based webview to render pixel data based on user-defined configurations or automatic inference.

## 2. Core Features (Current)

### 2.1. File Association
The extension acts as a custom editor for the following file extensions by default:
- `.raw`, `.bin`, `.data`, `.img`, `.gray`, `.yuv`
- Users can manually open any file via the context menu: **"Open as Raw Image"**.

### 2.2. Configuration Hierarchy
To render a raw image correctly, the viewer needs metadata (width, height, format, etc.). It resolves these in the following order of precedence:
1. **`.rawimagerc` (JSON)**: Searched from the file's directory upwards to the filesystem root.
2. **Filename Inference**: Parses patterns like `name_1920x1080_rgb24.raw`.
3. **Workspace Settings**: Fallback values defined in `rawviewer.defaultWidth`, `rawviewer.defaultHeight`, etc.

### 2.3. Supported Pixel Formats
| Category | Format | Bytes/Pixel | Description |
| :--- | :--- | :--- | :--- |
| **Grayscale** | `gray8`, `gray16le`, `gray16be` | 1, 2 | 8-bit or 16-bit (LE/BE) |
| **RGB/BGR** | `rgb24`, `bgr24`, `rgba32`, `bgra32` | 3, 4 | Interleaved color channels |
| **YUV** | `yuv420p`, `nv12`, `yuyv422` | 1.5 - 2 | Planar or semi-planar YUV |
| **Scientific** | `float32`, `depth16` | 4, 2 | Supports auto window/level adjustment |

### 2.4. Functionality
- **Canvas Rendering**: Efficiently renders large binary files using HTML5 Canvas.
- **PNG Export**: Allows users to save the current rendered view as a standard PNG file.
- **JSON Schema**: Provides validation and IntelliSense for `.rawimagerc` files.

---

## 3. Future Requirements (Planned)

### 3.1. Interactive Viewing (Zoom & Pan)
- **Zooming**: Support mouse wheel or UI buttons to zoom in/out (from 1% to 1000%+).
- **Panning**: Support clicking and dragging to navigate large images when zoomed in.
- **Interpolation Toggle**: Option to switch between "Nearest Neighbor" (for pixel-perfect inspection) and "Bilinear" (for smooth viewing).

### 3.2. Pixel Inspection (Data Probe)
- **Hover Info**: Display coordinates (x, y) and raw pixel values (e.g., R:255, G:128, B:0) at the mouse cursor position.
- **Bit-depth Support**: Correctly display values for 16-bit, float, and YUV formats.

### 3.3. Real-time Analytics
- **Histogram**: Show the distribution of luminance or individual color channels.
- **Image Statistics**: Compute and display Min, Max, Average, and Median values for the current view.

### 3.4. Dynamic UI Controls
- **Live Adjustment**: A sidebar or toolbar within the webview to change width, height, format, or header size without manually editing `.rawimagerc`.
- **Endianness Toggle**: Quickly switch between Little Endian and Big Endian for multi-byte formats.
- **Window/Level Sliders**: Interactive sliders for `float32` and `depth16` formats to adjust the visible range.

---

## 4. Technical Architecture
- **Extension Side**: Manages file access, configuration resolution, and provides the `CustomTextEditorProvider`.
- **Webview Side**: 
  - Receives binary data as `Uint8Array`.
  - Implements format-specific decoders in JavaScript/TypeScript.
  - Renders to a Canvas element.
- **Communication**: Uses `postMessage` for bidirectional communication between the extension and the webview.
