# Annotamate

**Annotamate** is a powerful, user-friendly, and highly customizable image annotation tool built with Python and CustomTkinter. Designed for efficiency, it supports bounding box annotation for object detection tasks and exports to popular formats like YOLO, Pascal VOC, and COCO.

![Annotamate Banner](annotamate/assets/name_logo.png)

## Features

- **Multi-Format Export**: Save annotations in **YOLO (.txt)**, **Pascal VOC (.xml)**, and **COCO (.json)** formats.
- **Efficient Workflow**: Optimized for speed with keyboard shortcuts for navigation, drawing, and editing.
- **Smart Editing**:
  - Drag-and-drop box adjustment.
  - Resize handles for precision.
  - Easy class switching.
- **Modern UI**:
  - **Dark/Light Mode** support.
  - Sidebar with object visibility toggles.
  - Zoom and Pan capabilities.
- **Batch Processing**: Built-in batch renaming tool for dataset organization.
- **Class Management**: Dynamic class addition/removal with color-coded visualization.

## Installation

### Prerequisites
- Python 3.8 or higher

### Install via pip
Clone the repository and install dependencies:

```bash
git clone https://github.com/yourusername/Annotamate.git
cd Annotamate
pip install .
```

## Usage

### Running the App
After installation, you can launch the application from anywhere using:

```bash
annotamate
```

Or run via python module:
```bash
python -m annotamate
```

### Quick Start Guide
1. **Load Images**: Click **Folder Icon** (Top Left) to open your image directory.
2. **Set Classes**: Click **Tag Icon** to manage your class labels (e.g., person, car).
3. **Draw Boxes**: 
   - Press `W` to enter **Rect Mode**.
   - Click and drag to draw a box.
4. **Edit Boxes**:
   - Press `X` for **Edit Mode**.
   - Drag corners to resize or center to move.
5. **Save**: Press `Ctrl+S` to save annotations.

### Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| **W** | Draw Rectangle Mode |
| **X** | Edit / Move Mode |
| **A / D** | Previous / Next Image |
| **Ctrl + S** | Save Annotation |
| **Ctrl + Z** | Undo |
| **Ctrl + Y** | Redo |
| **Ctrl + Scroll** | Zoom In/Out |
| **Right Click** | Delete/Undo Box |

## Development

To contribute or modify the code:

1. Install in editable mode:
   ```bash
   pip install -e .
   ```
2. Run tests (if available) or verify changes manually.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---
**Created by Rugved Jalit**