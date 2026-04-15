# Raw Image Viewer

A VS Code extension that displays raw binary image files directly in the editor using a canvas-based renderer.

## Features

- Opens raw binary image files (`.raw`, `.bin`, `.data`, `.img`, `.gray`, `.yuv`) as images
- Configurable via a `.rawimagerc` file (searched from the file's directory up to the filesystem root, similar to `.editorconfig`)
- Falls back to workspace settings and filename hints when `.rawimagerc` is missing
- Provides schema-backed autocomplete and validation for `.rawimagerc` in VS Code
- Right-click any file in the Explorer → **Open as Raw Image** to view it with this extension
- Supports multiple pixel formats
- Lets you export the rendered canvas as a PNG from the custom editor

## Configuration: `.rawimagerc`

Create a `.rawimagerc` file in the same directory as your binary file, or any parent directory. The nearest file found wins.

The extension contributes a JSON schema for `.rawimagerc`, so VS Code can offer autocomplete and validation for the supported fields and pixel formats.

If `.rawimagerc` is not present, the extension can still render files by combining:

1. Filename inference from patterns like `frame_1920x1080_rgb24.raw`
2. Workspace settings such as `rawviewer.defaultWidth`, `rawviewer.defaultHeight`, `rawviewer.defaultHeaderSize`, and `rawviewer.defaultFormat`

`.rawimagerc` always takes precedence over these fallbacks.

```json
{
  "width": 640,
  "height": 480,
  "headerSize": 0,
  "format": "rgb24"
}
```

| Field        | Type      | Default  | Description                                  |
|--------------|-----------|----------|----------------------------------------------|
| `width`      | integer   | required | Image width in pixels                        |
| `height`     | integer   | required | Image height in pixels                       |
| `headerSize` | integer   | `0`      | Number of bytes to skip at the start of file |
| `format`     | enum      | `"rgb24"`| Pixel format (see table below)               |

### Supported Pixel Formats

| Format     | Description                      | Bytes/pixel |
|------------|----------------------------------|-------------|
| `gray8`    | 8-bit grayscale                  | 1           |
| `gray16le` | 16-bit grayscale (little-endian) | 2           |
| `gray16be` | 16-bit grayscale (big-endian)    | 2           |
| `rgb24`    | 24-bit RGB                       | 3           |
| `bgr24`    | 24-bit BGR                       | 3           |
| `rgba32`   | 32-bit RGBA                      | 4           |
| `bgra32`   | 32-bit BGRA                      | 4           |
| `yuv420p`  | Planar YUV 4:2:0                 | 1.5         |
| `nv12`     | Semi-planar YUV 4:2:0            | 1.5         |
| `yuyv422`  | Packed YUV 4:2:2                 | 2           |
| `float32`  | 32-bit float grayscale           | 4           |
| `depth16`  | 16-bit depth (little-endian)     | 2           |

For `yuv420p` and `nv12`, use even image widths and heights. `yuyv422` requires an even width. `float32` and `depth16` display with auto window/level controls; you can adjust the min/max range after rendering.

## Usage

1. Place a `.rawimagerc` file in the directory containing your binary image (or a parent directory).
2. Open a `.raw`, `.bin`, `.data`, `.img`, `.gray`, or `.yuv` file in VS Code — it will automatically render as an image.
3. For other file extensions, right-click the file in the Explorer and choose **Open as Raw Image**.
4. Click **Export PNG** above the canvas to save the current rendering as a `.png` file.

## GitHub Actions Workflows

### Build VSIX (artifact)

Every push and pull request runs the **Build VSIX** workflow, which packages the extension and uploads a `rawviewer-vsix` artifact. This does not publish anything to the Visual Studio Marketplace.

1. Push your branch to GitHub, or trigger the workflow manually from the **Actions** tab.
2. Download the `rawviewer-vsix` artifact from the workflow run.
3. Install it in VS Code with **Extensions: Install from VSIX...**.

### GitHub Releases (automated)

Pushing a `v*` tag to `main` triggers the **Release** workflow, which builds the `.vsix`, creates a GitHub Release, and attaches the file as a release asset.

```bash
git tag v0.1.0
git push origin v0.1.0
```

Download any release from the [Releases](../../releases) page and install with **Extensions: Install from VSIX...**.

## Fallback Settings

Add these workspace settings if you want a project-wide fallback when `.rawimagerc` is absent:

```json
{
  "rawviewer.defaultWidth": 1920,
  "rawviewer.defaultHeight": 1080,
  "rawviewer.defaultHeaderSize": 0,
  "rawviewer.defaultFormat": "rgb24",
  "rawviewer.inferFromFilename": true
}
```

With `rawviewer.inferFromFilename` enabled, a file named `capture_1280x720_gray8.raw` can supply width, height, and format automatically. Any missing pieces are filled from the workspace defaults above.

## Example

Suppose you have a 320×240 8-bit grayscale image at `/project/images/frame.raw` with no header. Create `/project/images/.rawimagerc`:

```json
{
  "width": 320,
  "height": 240,
  "headerSize": 0,
  "format": "gray8"
}
```

Open `frame.raw` in VS Code and the image will be displayed on a canvas.
