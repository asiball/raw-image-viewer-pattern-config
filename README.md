# Raw Image Viewer

A VS Code extension that displays raw binary image files directly in the editor using a canvas-based renderer.

## Features

- Opens raw binary image files (`.raw`, `.bin`, `.data`, `.img`, `.gray`, `.yuv`) as images
- Configurable via a `.rawimagerc` file (searched from the file's directory up to the filesystem root, similar to `.editorconfig`)
- Right-click any file in the Explorer → **Open as Raw Image** to view it with this extension
- Supports multiple pixel formats

## Configuration: `.rawimagerc`

Create a `.rawimagerc` file in the same directory as your binary file, or any parent directory. The nearest file found wins.

```json
{
  "width": 640,
  "height": 480,
  "headerSize": 0,
  "format": "rgb24"
}
```

| Field        | Type   | Default  | Description                                  |
|--------------|--------|----------|----------------------------------------------|
| `width`      | number | required | Image width in pixels                        |
| `height`     | number | required | Image height in pixels                       |
| `headerSize` | number | `0`      | Number of bytes to skip at the start of file |
| `format`     | string | `"rgb24"`| Pixel format (see table below)               |

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

## Usage

1. Place a `.rawimagerc` file in the directory containing your binary image (or a parent directory).
2. Open a `.raw`, `.bin`, `.data`, `.img`, `.gray`, or `.yuv` file in VS Code — it will automatically render as an image.
3. For other file extensions, right-click the file in the Explorer and choose **Open as Raw Image**.

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

