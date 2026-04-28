import os
import struct

def create_gradient_gray8(filename, width, height):
    with open(filename, 'wb') as f:
        for y in range(height):
            for x in range(width):
                val = int((x / width) * 255)
                f.write(struct.pack('B', val))

def create_gradient_rgb24(filename, width, height, header_size=0):
    with open(filename, 'wb') as f:
        if header_size > 0:
            f.write(b'\x00' * header_size)
        for y in range(height):
            for x in range(width):
                r = int((x / width) * 255)
                g = int((y / height) * 255)
                b = 128
                f.write(struct.pack('BBB', r, g, b))

def create_gradient_rgba32(filename, width, height):
    with open(filename, 'wb') as f:
        for y in range(height):
            for x in range(width):
                r = int((x / width) * 255)
                g = int((y / height) * 255)
                b = 128
                a = int(((x+y)/(width+height)) * 255)
                f.write(struct.pack('BBBB', r, g, b, a))

if __name__ == '__main__':
    base_dir = os.path.dirname(os.path.abspath(__file__))
    
    # 1. basic RGB24
    os.makedirs(os.path.join(base_dir, 'scenario1'), exist_ok=True)
    create_gradient_rgb24(os.path.join(base_dir, 'scenario1', 'test_rgb24.raw'), 256, 256)
    with open(os.path.join(base_dir, 'scenario1', '.rawimagerc'), 'w') as f:
        f.write('{\n  "patterns": {\n    "*": {\n      "width": 256,\n      "height": 256,\n      "headerSize": 0,\n      "format": "rgb24"\n    }\n  }\n}\n')

    # 2. Gray8
    os.makedirs(os.path.join(base_dir, 'scenario2'), exist_ok=True)
    create_gradient_gray8(os.path.join(base_dir, 'scenario2', 'test_gray8.gray'), 128, 128)
    with open(os.path.join(base_dir, 'scenario2', '.rawimagerc'), 'w') as f:
        f.write('{\n  "patterns": {\n    "*": {\n      "width": 128,\n      "height": 128,\n      "headerSize": 0,\n      "format": "gray8"\n    }\n  }\n}\n')

    # 3. Header size test
    os.makedirs(os.path.join(base_dir, 'scenario3'), exist_ok=True)
    create_gradient_rgb24(os.path.join(base_dir, 'scenario3', 'test_header.bin'), 64, 64, header_size=128)
    with open(os.path.join(base_dir, 'scenario3', '.rawimagerc'), 'w') as f:
        f.write('{\n  "patterns": {\n    "*": {\n      "width": 64,\n      "height": 64,\n      "headerSize": 128,\n      "format": "rgb24"\n    }\n  }\n}\n')
        
    print("Test images generated successfully.")
