import customtkinter as ctk
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog
from PIL import Image, ImageTk, ImageDraw
import os
import glob
import sys
import subprocess
import shutil
import json
import xml.etree.ElementTree as ET
from xml.dom import minidom
import tkfontawesome  # pip install tkfontawesome
import warnings

# --- Suppress CTkImage Warning for TkFontAwesome ---
warnings.filterwarnings("ignore", message=".*CTkButton Warning: Given image is not CTkImage.*")

# --- Configuration ---
ctk.set_appearance_mode("Dark")
ctk.set_default_color_theme("dark-blue") 

# --- THEME CONSTANTS (Light, Dark) ---
# We define colors as tuples: (Light Mode Color, Dark Mode Color)
PS_GRAY_DARK = ("#e0e0e0", "#262626")   # Main Background / Canvas Area
PS_GRAY_MED = ("#f0f0f0", "#383838")    # Panels / Sidebar
PS_GRAY_LIGHT = ("#ffffff", "#535353")  # Buttons / Inputs
PS_GRAY_LIGHTER = ("#d0d0d0", "#6b6b6b") # Hover state / Active
PS_TEXT_COLOR = ("#1a1a1a", "#f0f0f0")  # Text
PS_BORDER_COLOR = ("#cccccc", "#1a1a1a")
PS_ACTIVE = ("#aaaaaa", "#6b6b6b")      # Active/Accent

# --- ICON GENERATOR (Using tkfontawesome) ---
class IconFactory:
    @staticmethod
    def create_icon(name, size=(20, 20), color=(220, 220, 220)):
        # Convert RGB tuple to Hex string for tkfontawesome
        hex_color = "#%02x%02x%02x" % color
        
        fa_map = {
            "folder": "folder-open",
            "tag": "tag",
            "save": "save",
            "trash": "trash-alt",
            "prev": "chevron-left",
            "next": "chevron-right",
            "eye": "eye",
            "eye_hide": "eye-slash",
            "sun": "sun",
            "moon": "moon",
            "bars": "bars",         # Hamburger menu
            "minus": "minus",       # Minimize
            "close": "times"        # Close/Remove
        }
        
        fa_name = fa_map.get(name, "question-circle")
        
        try:
            # Generate PhotoImage using tkfontawesome
            icon = tkfontawesome.icon_to_image(fa_name, fill=hex_color, scale_to_width=size[0])
            return icon
        except Exception as e:
            # Fallback (Just a blank transparent image if FA fails)
            return tk.PhotoImage(width=size[0], height=size[1])

# --- CLASS MANAGER DIALOG (Unified) ---
class ClassManagerDialog(ctk.CTkToplevel):
    def __init__(self, parent, selection_mode=False):
        super().__init__(parent)
        self.title("Class Manager")
        self.geometry("340x550")
        self.parent = parent
        self.selection_mode = selection_mode
        self.result = None 
        
        self.transient(parent) 
        self.configure(fg_color=PS_GRAY_MED) # Theme bg
        
        # Force focus so shortcuts work immediately in both modes
        self.focus_force()
        
        if selection_mode:
            self.grab_set() 
        
        if hasattr(parent, 'icon_path') and parent.icon_path:
            try: self.after(200, lambda: self.iconbitmap(parent.icon_path))
            except: pass

        # Title
        ctk.CTkLabel(self, text="Class Manager", font=("Arial", 16, "bold"), text_color=PS_TEXT_COLOR).pack(pady=(15, 5))
        
        # Toggle: Use Selected as Default
        self.chk_default = ctk.CTkSwitch(
            self, 
            text="Use selected class as default", 
            variable=self.parent.use_default_class_var,
            font=("Arial", 12),
            text_color=PS_TEXT_COLOR,
            progress_color=PS_ACTIVE,
            button_color="white",
            button_hover_color="white",
            fg_color=PS_GRAY_LIGHT
        )
        self.chk_default.pack(pady=5, padx=20, anchor="w")

        # Scrollable List of Classes
        self.scroll_classes = ctk.CTkScrollableFrame(self, label_text="Available Classes", label_text_color=PS_TEXT_COLOR, fg_color=PS_GRAY_DARK)
        self.scroll_classes.pack(fill="both", expand=True, padx=10, pady=5)
        
        # Entry for New Class
        self.entry_class = ctk.CTkEntry(self, placeholder_text="New Class Name...", fg_color=PS_GRAY_DARK, border_color=PS_GRAY_LIGHT, text_color=PS_TEXT_COLOR)
        self.entry_class.pack(fill="x", padx=10, pady=(10, 5))
        self.entry_class.bind("<Return>", lambda e: self.on_add())

        # Buttons Frame
        btn_frame = ctk.CTkFrame(self, fg_color="transparent")
        btn_frame.pack(fill="x", padx=10, pady=10)
        
        # Standard Buttons
        ctk.CTkButton(btn_frame, text="Add", width=60, fg_color=PS_GRAY_LIGHT, hover_color=PS_GRAY_LIGHTER, text_color=PS_TEXT_COLOR, command=self.on_add).pack(side="left", padx=5)
        ctk.CTkButton(btn_frame, text="Delete", width=60, fg_color=PS_GRAY_LIGHT, hover_color="#C0392B", text_color=PS_TEXT_COLOR, command=self.on_delete).pack(side="left", padx=5)

        # Confirm/Close Button
        btn_text = "Confirm (S)" if selection_mode else "Close (S)"
        btn_color = PS_ACTIVE if selection_mode else PS_GRAY_LIGHT
        
        ctk.CTkButton(
            btn_frame, 
            text=btn_text, 
            width=100, 
            fg_color=btn_color, 
            hover_color=PS_GRAY_LIGHTER if not selection_mode else "#888888",
            text_color=PS_TEXT_COLOR,
            command=self.on_confirm
        ).pack(side="right", padx=5)

        # Shortcuts
        self.bind("<s>", lambda e: self.on_confirm(e))
        self.bind("<q>", self.on_q)
        self.bind("<e>", self.on_e)

        self.refresh_list()

    def refresh_list(self):
        # Clear existing
        for w in self.scroll_classes.winfo_children(): w.destroy()
        
        current_val = self.parent.selected_class_var.get()

        for idx, cls in enumerate(self.parent.classes):
            str_idx = str(idx)
            
            # Row container
            row = ctk.CTkFrame(self.scroll_classes, fg_color="transparent", corner_radius=0)
            row.pack(fill="x", pady=2)
            
            # Color indicator
            color = self.parent.get_class_color(idx)
            ind = ctk.CTkFrame(row, fg_color=color, width=12, height=12, corner_radius=2)
            ind.pack(side="left", padx=(5, 8))

            # Radio Button (Directly modifies parent variable)
            rb = ctk.CTkRadioButton(
                row, 
                text=f"{idx}: {cls}", 
                variable=self.parent.selected_class_var, 
                value=str_idx,
                text_color=PS_TEXT_COLOR,
                fg_color=PS_ACTIVE,
                hover_color=PS_GRAY_LIGHT,
                command=self.parent.refresh_class_list # Trigger refresh if needed
            )
            rb.pack(side="left", fill="x", expand=True)
            
            if current_val == str_idx:
                rb.select()

    def on_add(self):
        name = self.entry_class.get().strip()
        if name:
            self.parent.add_class(name)
            self.entry_class.delete(0, tk.END)
            self.refresh_list()

    def on_delete(self):
        self.parent.delete_class()
        self.refresh_list()

    def _is_typing(self):
        # Check if focus is on an entry widget to prevent accidental shortcuts
        focused = self.focus_get()
        if focused and "entry" in focused.winfo_class().lower():
            return True
        return False

    def on_confirm(self, event=None):
        if self._is_typing(): return 
        
        if not self.parent.classes: 
            self.destroy()
            return
            
        try:
            self.result = int(self.parent.selected_class_var.get())
        except:
            self.result = None
        self.destroy()

    def on_q(self, event):
        if self._is_typing(): return 
        
        if not self.parent.classes: return
        try:
            curr = int(self.parent.selected_class_var.get())
        except: curr = 0
        
        new_idx = (curr - 1) if curr > 0 else (len(self.parent.classes) - 1)
        self.parent.selected_class_var.set(str(new_idx))
        self.refresh_list()

    def on_e(self, event):
        if self._is_typing(): return 
        
        if not self.parent.classes: return
        try:
            curr = int(self.parent.selected_class_var.get())
        except: curr = 0
        
        new_idx = (curr + 1) % len(self.parent.classes)
        self.parent.selected_class_var.set(str(new_idx))
        self.refresh_list()

# --- BATCH RENAME DIALOG ---
class BatchRenameDialog(ctk.CTkToplevel):
    def __init__(self, parent, callback):
        super().__init__(parent)
        self.title("Batch Rename")
        self.geometry("320x350")
        self.resizable(False, False)
        self.callback = callback
        self.transient(parent)
        self.configure(fg_color=PS_GRAY_MED)
        self.grab_set()
        
        if hasattr(parent, 'icon_path') and parent.icon_path:
            try: self.after(200, lambda: self.iconbitmap(parent.icon_path))
            except: pass
        
        ctk.CTkLabel(self, text="Batch Rename Settings", font=("Arial", 16, "bold"), text_color=PS_TEXT_COLOR).pack(pady=15)
        
        # Base Name
        self.frame1 = ctk.CTkFrame(self, fg_color="transparent")
        self.frame1.pack(fill="x", padx=20, pady=5)
        ctk.CTkLabel(self.frame1, text="Base Name:", width=80, anchor="w", text_color=PS_TEXT_COLOR).pack(side="left")
        self.entry_base = ctk.CTkEntry(self.frame1, placeholder_text="e.g. apple", fg_color=PS_GRAY_DARK, border_color=PS_GRAY_LIGHT, text_color=PS_TEXT_COLOR)
        self.entry_base.pack(side="left", fill="x", expand=True)
        
        # Start Number
        self.frame2 = ctk.CTkFrame(self, fg_color="transparent")
        self.frame2.pack(fill="x", padx=20, pady=5)
        ctk.CTkLabel(self.frame2, text="Start #:", width=80, anchor="w", text_color=PS_TEXT_COLOR).pack(side="left")
        self.entry_start = ctk.CTkEntry(self.frame2, fg_color=PS_GRAY_DARK, border_color=PS_GRAY_LIGHT, text_color=PS_TEXT_COLOR)
        self.entry_start.insert(0, "1")
        self.entry_start.pack(side="left", fill="x", expand=True)
        
        # Digits
        self.frame3 = ctk.CTkFrame(self, fg_color="transparent")
        self.frame3.pack(fill="x", padx=20, pady=5)
        ctk.CTkLabel(self.frame3, text="Digits:", width=80, anchor="w", text_color=PS_TEXT_COLOR).pack(side="left")
        self.entry_digits = ctk.CTkEntry(self.frame3, fg_color=PS_GRAY_DARK, border_color=PS_GRAY_LIGHT, text_color=PS_TEXT_COLOR)
        self.entry_digits.insert(0, "4")
        self.entry_digits.pack(side="left", fill="x", expand=True)
        
        # Preview
        self.lbl_preview = ctk.CTkLabel(self, text="Preview: apple_0001.jpg", text_color="gray")
        self.lbl_preview.pack(pady=10)
        
        # Bind updates for preview
        self.entry_base.bind("<KeyRelease>", self.update_preview)
        self.entry_start.bind("<KeyRelease>", self.update_preview)
        self.entry_digits.bind("<KeyRelease>", self.update_preview)

        ctk.CTkButton(self, text="Rename All", fg_color=PS_ACTIVE, hover_color=PS_GRAY_LIGHTER, text_color=PS_TEXT_COLOR, command=self.on_confirm).pack(pady=15, fill="x", padx=20)

        self.center_window()
        self.focus_force()

    def center_window(self):
        self.update_idletasks()
        try:
            x = self.master.winfo_x() + (self.master.winfo_width() // 2) - 160
            y = self.master.winfo_y() + (self.master.winfo_height() // 2) - 175
            self.geometry(f"+{x}+{y}")
        except: pass

    def update_preview(self, event=None):
        base = self.entry_base.get().strip()
        try: start = int(self.entry_start.get())
        except: start = 1
        try: digits = int(self.entry_digits.get())
        except: digits = 4
        
        example = f"{base}_{str(start).zfill(digits)}.jpg"
        self.lbl_preview.configure(text=f"Preview: {example}")

    def on_confirm(self):
        base = self.entry_base.get().strip()
        if not base:
            messagebox.showerror("Error", "Base name cannot be empty.")
            return
            
        try:
            start = int(self.entry_start.get())
            digits = int(self.entry_digits.get())
        except ValueError:
            messagebox.showerror("Error", "Start and Digits must be numbers.")
            return
            
        self.callback(base, start, digits)
        self.destroy()

# --- USAGE GUIDE DIALOG ---
class UsageGuideDialog(ctk.CTkToplevel):
    def __init__(self, parent):
        super().__init__(parent)
        self.title("How to Use")
        self.geometry("500x600")
        self.resizable(False, True)
        self.transient(parent)
        self.configure(fg_color=PS_GRAY_MED)
        self.grab_set()

        if hasattr(parent, 'icon_path') and parent.icon_path:
            try: self.after(200, lambda: self.iconbitmap(parent.icon_path))
            except: pass

        # Title
        ctk.CTkLabel(self, text="User Guide & Shortcuts", font=("Arial", 20, "bold"), text_color=PS_TEXT_COLOR).pack(pady=15)

        # Scrollable Content
        scroll_frame = ctk.CTkScrollableFrame(self, label_text="Instructions", label_text_color=PS_TEXT_COLOR, fg_color=PS_GRAY_DARK)
        scroll_frame.pack(fill="both", expand=True, padx=20, pady=(0, 20))

        # Instructions Text
        instructions = (
            "1. Setup:\n"
            "   - Click 'Open Directory' to load images.\n"
            "   - (Optional) 'Set Label Directory' if different from images.\n\n"
            "2. Classes:\n"
            "   - Click 'Classes' in the top bar to Manage/Select active class.\n"
            "   - The Sidebar shows objects drawn on the CURRENT image.\n\n"
            "3. Drawing:\n"
            "   - Press 'W' to activate Rect Tool.\n"
            "   - Click and drag to draw a box.\n"
            "   - Mode automatically switches to Edit after drawing.\n\n"
            "4. Editing:\n"
            "   - Edit Mode (X) allows moving/resizing.\n"
            "   - Press 'X' again with a box selected to change its class.\n"
            "   - Drag center to move, drag corners to resize.\n\n"
            "5. Saving:\n"
            "   - Select Format (YOLO/VOC/COCO) in toolbar.\n"
            "   - Press Ctrl+S to save."
        )

        lbl_instr = ctk.CTkLabel(
            scroll_frame, 
            text=instructions, 
            justify="left", 
            anchor="w",
            font=("Arial", 12),
            text_color="#cccccc",
            wraplength=420
        )
        lbl_instr.pack(fill="x", padx=10, pady=10)

        # Shortcuts Section
        ctk.CTkLabel(scroll_frame, text="Keyboard Shortcuts", font=("Arial", 14, "bold"), text_color=PS_TEXT_COLOR).pack(pady=(15, 5), anchor="w", padx=10)

        shortcuts = [
            ("A", "Previous Image"),
            ("D", "Next Image"),
            ("W", "Draw Rectangle"),
            ("X", "Edit Mode / Change Class"),
            ("Ctrl + S", "Save Annotation"),
            ("F", "Fit Image to Screen"),
            ("Ctrl + Z", "Undo Last Action"),
            ("Ctrl + Y", "Redo Action"),
            ("Ctrl + Scroll", "Zoom In/Out"),
            ("Right Click", "Undo Box"),
            ("Scroll", "Vertical Pan"),
            ("Shift + Scroll", "Horizontal Pan")
        ]

        # Grid for shortcuts
        sc_container = ctk.CTkFrame(scroll_frame, fg_color="transparent")
        sc_container.pack(fill="x", padx=10, pady=5)

        for i, (key, desc) in enumerate(shortcuts):
            k_lbl = ctk.CTkLabel(sc_container, text=key, font=("Courier", 12, "bold"), text_color=PS_ACTIVE, anchor="w")
            k_lbl.grid(row=i, column=0, sticky="w", pady=2, padx=(0, 20))
            
            d_lbl = ctk.CTkLabel(sc_container, text=desc, font=("Arial", 12), text_color="#cccccc", anchor="w")
            d_lbl.grid(row=i, column=1, sticky="w", pady=2)

        # Close Button
        ctk.CTkButton(self, text="Close", command=self.destroy, fg_color=PS_GRAY_LIGHT, hover_color=PS_GRAY_LIGHTER, text_color=PS_TEXT_COLOR).pack(pady=15)

        self.center_window()
        self.focus_force()

    def center_window(self):
        self.update_idletasks()
        try:
            x = self.master.winfo_x() + (self.master.winfo_width() // 2) - 250
            y = self.master.winfo_y() + (self.master.winfo_height() // 2) - 300
            self.geometry(f"+{x}+{y}")
        except: pass

# --- MAIN APP ---
class UltimateAnnotator(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Annotamate Pro")
        
        try: self.after(0, lambda: self.state('zoomed'))
        except: self.geometry("1400x900")
        
        # --- PATHS ---
        self.base_dir = os.path.dirname(os.path.abspath(__file__))
        self.assets_dir = os.path.join(self.base_dir, "assets")
        self.icon_path = None

        # --- Data ---
        self.image_list = []
        self.filtered_indices = [] # Maps listbox index -> real index in image_list
        self.annot_cache = {} # Caches annotation existence: path -> bool
        
        self.current_dir = None    
        self.label_dir = None      
        self.current_index = 0
        self.classes = ["person", "car", "bicycle", "dog"] 
        self.selected_class_var = tk.StringVar(value="0") 
        self.theme_mode = "Dark" # Track current theme
        self.nav_buttons = [] # Store buttons to update icons
        
        # Panel Visibility State - START MAXIMIZED
        self.objects_visible = True
        self.files_visible = True
        
        # Fixed Colors for Classes
        self.COLORS = ["#e74c3c", "#3498db", "#f1c40f", "#9b59b6", "#2ecc71", 
                       "#1abc9c", "#34495e", "#d35400", "#7f8c8d", "#c0392b"]
        
        self.bboxes = []       
        self.redo_stack = []   
        self.box_images = [] # Cache for Transparent PIL images
        
        self.auto_save_var = ctk.BooleanVar(value=False)
        self.show_all_var = ctk.BooleanVar(value=True) # For visibility toggle
        self.show_unlabelled_var = ctk.BooleanVar(value=False) # Filter Unlabelled
        self.use_default_class_var = ctk.BooleanVar(value=False) # Use selected class as default
        self.draw_mode_var = ctk.StringVar(value="Edit") 
        self.format_var = ctk.StringVar(value="YOLO") # Export format
        
        self.drawing = False
        self.start_x, self.start_y = 0, 0
        self.current_rect = None
        self.pil_image = None   
        self.tk_image = None    
        self.imscale = 1.0
        self.img_ox = 0 
        self.img_oy = 0
        self.is_processing = False 
        self.selected_box_idx = None
        self.drag_action = None
        self.has_unsaved_changes = False 
        
        self.class_manager_window = None

        self.branding_img = None
        self.lbl_zoom = None
        self.minimized_btns = {} # Store minimized tabs in footer
        
        # --- Init UI ---
        self.configure(fg_color=PS_GRAY_DARK) # Main Window BG
        self.load_assets()
        self.generate_icons()
        self._setup_menu()
        self._setup_ui()
        self._setup_footer()
        self._bind_shortcuts()
        
        # Auto-Start
        self.after(200, self.load_directory)

    def load_assets(self):
        self.icon_path = os.path.join(self.assets_dir, "logo.ico")
        if os.path.exists(self.icon_path):
            self.after(200, lambda: self.iconbitmap(self.icon_path))
        
        brand_path = os.path.join(self.assets_dir, "name_logo.png")
        if os.path.exists(brand_path):
            try:
                pil_brand = Image.open(brand_path)
                aspect = pil_brand.width / pil_brand.height
                new_h = 24 # Reduced height for branding
                new_w = int(new_h * aspect)
                self.branding_img = ctk.CTkImage(light_image=pil_brand, dark_image=pil_brand, size=(new_w, new_h))
            except: pass

    def generate_icons(self):
        # Update Icon Colors based on Theme Mode
        # Light Mode -> Dark Icons, Dark Mode -> Light Icons
        if self.theme_mode == "Light":
            c = (50, 50, 50)
            c_red = (200, 40, 40)
        else:
            c = (220, 220, 220)
            c_red = (255, 100, 100)

        s = (18, 18) 
        self.icon_folder = IconFactory.create_icon("folder", size=s, color=c)
        self.icon_tag = IconFactory.create_icon("tag", size=s, color=c)
        self.icon_save = IconFactory.create_icon("save", size=s, color=c)
        self.icon_del = IconFactory.create_icon("trash", size=s, color=c_red) 
        self.icon_prev = IconFactory.create_icon("prev", size=s, color=c)
        self.icon_next = IconFactory.create_icon("next", size=s, color=c)
        
        self.icon_theme = IconFactory.create_icon("moon" if self.theme_mode=="Light" else "sun", size=s, color=c)
        self.icon_bars = IconFactory.create_icon("bars", size=s, color=c)
        self.icon_min = IconFactory.create_icon("minus", size=(12,12), color=c)
        self.icon_close = IconFactory.create_icon("close", size=(12,12), color=c)
        
        # --- VISIBILITY ICONS ---
        self.icon_vis_on = IconFactory.create_icon("eye", size=(16, 16), color=c)
        # Hidden eye slightly dimmer
        dim_c = (150, 150, 150) if self.theme_mode == "Light" else (100, 100, 100)
        self.icon_vis_off = IconFactory.create_icon("eye_hide", size=(16, 16), color=dim_c)

    # --- COLOR HASHING ---
    def get_class_color(self, class_id):
        if 0 <= class_id < len(self.classes):
            name = self.classes[class_id]
            # Simple hash to keep color consistent per name
            hash_val = sum(map(ord, name)) 
            return self.COLORS[hash_val % len(self.COLORS)]
        return "#999999"

    def _setup_menu(self):
        # Determine Menu Colors based on theme (Standard TK Menu doesn't support tuples)
        # We use index 0 for Light, 1 for Dark
        t_idx = 0 if self.theme_mode == "Light" else 1
        
        bg_color = PS_GRAY_MED[t_idx]
        fg_color = PS_TEXT_COLOR[t_idx]
        active_bg = PS_ACTIVE[t_idx]

        menubar = tk.Menu(self, bg=bg_color, fg=fg_color, activebackground=active_bg, activeforeground="white", bd=0)
        
        file_menu = tk.Menu(menubar, tearoff=0, bg=bg_color, fg=fg_color)
        file_menu.add_command(label="Open New Window", command=lambda: subprocess.Popen([sys.executable, __file__]))
        file_menu.add_separator()
        file_menu.add_command(label="Open Directory...", command=self.load_directory)
        file_menu.add_command(label="Set Label Directory...", command=self.set_label_directory)
        file_menu.add_separator()
        file_menu.add_command(label="Save Annotation (Ctrl+S)", command=self.save_annotation)
        file_menu.add_command(label="Delete Image", command=self.delete_current_image)
        file_menu.add_separator()
        file_menu.add_command(label="Exit", command=self.quit)
        menubar.add_cascade(label="File", menu=file_menu)
        
        edit_menu = tk.Menu(menubar, tearoff=0, bg=bg_color, fg=fg_color)
        edit_menu.add_command(label="Rect Tool (W)", command=lambda: self.set_mode("Rect"))
        edit_menu.add_command(label="Edit Tool (X)", command=lambda: self.set_mode("Edit"))
        edit_menu.add_separator()
        edit_menu.add_command(label="Duplicate Box (Ctrl+D)", command=self.duplicate_selected_box)
        edit_menu.add_command(label="Undo (Ctrl+Z)", command=self.undo_last)
        edit_menu.add_command(label="Redo (Ctrl+Y)", command=self.redo_last)
        menubar.add_cascade(label="Edit", menu=edit_menu)
        
        # --- NEW RENAME MENU ---
        rename_menu = tk.Menu(menubar, tearoff=0, bg=bg_color, fg=fg_color)
        rename_menu.add_command(label="Rename Current Image", command=self.rename_current_single)
        rename_menu.add_command(label="Batch Rename Directory...", command=self.open_batch_rename)
        menubar.add_cascade(label="Rename", menu=rename_menu)
        
        help_menu = tk.Menu(menubar, tearoff=0, bg=bg_color, fg=fg_color)
        help_menu.add_command(label="How to Use", command=self.show_usage_guide)
        help_menu.add_separator()
        help_menu.add_command(label="About", command=self.show_about)
        menubar.add_cascade(label="Help", menu=help_menu)
        
        self.config(menu=menubar)

    # --- RENAME LOGIC ---
    def rename_current_single(self):
        if not self.image_list: return
        curr_path = self.image_list[self.current_index]
        old_name = os.path.basename(curr_path)
        
        dialog = ctk.CTkInputDialog(text="Enter new name (with extension):", title="Rename File")
        if self.icon_path:
            try: dialog.after(200, lambda: dialog.iconbitmap(self.icon_path))
            except: pass
        new_name = dialog.get_input()

        if not new_name: return
        
        dir_path = os.path.dirname(curr_path)
        new_path = os.path.join(dir_path, new_name)
        
        if os.path.exists(new_path):
            messagebox.showerror("Error", "File with that name already exists!")
            return
            
        try:
            os.rename(curr_path, new_path)
            # Rename corresponding annotation based on current format assumption or all? 
            # Currently only checking .txt for rename in legacy code, could expand but keep simple for now
            old_txt = os.path.splitext(curr_path)[0] + ".txt"
            new_txt = os.path.join(os.path.dirname(new_path), os.path.splitext(new_name)[0] + ".txt")
            if os.path.exists(old_txt):
                os.rename(old_txt, new_txt)
            
            self.image_list[self.current_index] = new_path
            
            # Update cache
            if curr_path in self.annot_cache:
                self.annot_cache[new_path] = self.annot_cache.pop(curr_path)

            self.refresh_file_list()
            self.load_image_data()
        except Exception as e:
            messagebox.showerror("Error", f"Failed to rename: {e}")

    def open_batch_rename(self):
        if not self.current_dir:
            messagebox.showinfo("Info", "Open a directory first.")
            return
        BatchRenameDialog(self, self.execute_batch_rename)

    def execute_batch_rename(self, base_name, start_num, digits):
        if not self.image_list: return
        files_to_rename = self.image_list.copy()
        count = start_num
        renamed_count = 0
        new_image_list = []
        try:
            for old_path in files_to_rename:
                dir_path = os.path.dirname(old_path)
                ext = os.path.splitext(old_path)[1]
                new_filename = f"{base_name}_{str(count).zfill(digits)}{ext}"
                new_path = os.path.join(dir_path, new_filename)
                
                if old_path != new_path:
                    os.rename(old_path, new_path)
                    # Basic txt rename support
                    old_txt = os.path.splitext(old_path)[0] + ".txt"
                    if os.path.exists(old_txt):
                        new_txt_name = f"{base_name}_{str(count).zfill(digits)}.txt"
                        new_txt = os.path.join(dir_path, new_txt_name)
                        os.rename(old_txt, new_txt)
                
                new_image_list.append(new_path)
                count += 1
                renamed_count += 1
            
            self.image_list = new_image_list
            self.annot_cache = {} # Clear cache on batch rename
            self.refresh_file_list()
            self.current_index = 0
            self.load_image_data()
            messagebox.showinfo("Success", f"Renamed {renamed_count} files.")
            
        except Exception as e:
            messagebox.showerror("Error", f"Batch rename interrupted: {e}")
            self.load_directory_manual(self.current_dir)

    def load_directory_manual(self, d):
        self.image_list = sorted(glob.glob(os.path.join(d, "*.*")))
        self.image_list = [x for x in self.image_list if x.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp'))]
        self.annot_cache = {}
        self.refresh_file_list()
        self.current_index = 0
        if self.image_list: self.load_image_data()

    # --- ABOUT & USAGE ---
    def show_about(self):
        messagebox.showinfo("About", "Annotamate Pro \nRugved Jalit © 2025")

    def show_usage_guide(self):
        UsageGuideDialog(self)

    def set_mode(self, mode):
        self.draw_mode_var.set(mode)
        self.on_mode_change(mode)

    # --- CLASS MANAGER LOGIC ---
    def open_class_manager(self):
        if self.class_manager_window is None or not self.class_manager_window.winfo_exists():
            # Pass False for selection_mode just to be explicit, but Confirm button will be "Close"
            self.class_manager_window = ClassManagerDialog(self, selection_mode=False)
        else:
            self.class_manager_window.focus()
            
    # --- THEME TOGGLE LOGIC ---
    def toggle_theme(self):
        self.theme_mode = "Light" if self.theme_mode == "Dark" else "Dark"
        
        # 1. Update CTk Theme Mode (Handles all CTk widgets automatically via Tuples)
        ctk.set_appearance_mode(self.theme_mode)
        
        # 2. Re-generate Icons for the new theme (Light background needs Dark icons)
        self.generate_icons()
        
        # 3. Update Nav Button Icons manually (since tkfontawesome icons are static bitmaps)
        # We need to map button instance to the icon it uses.
        # This mapping is rebuilt during toggle.
        for btn, icon_name in self.nav_buttons:
            if icon_name == "folder": img = self.icon_folder
            elif icon_name == "tag": img = self.icon_tag
            elif icon_name == "save": img = self.icon_save
            elif icon_name == "del": img = self.icon_del
            elif icon_name == "theme": img = self.icon_theme
            elif icon_name == "bars": img = self.icon_bars # Update hamburger
            elif icon_name == "min": img = self.icon_min
            elif icon_name == "close": img = self.icon_close
            
            try: btn.configure(image=img)
            except: pass
            
        # 4. Update Standard TK Widgets (Canvas, Listbox, Scrollbar, PanedWindow)
        # Get index: 0 for Light, 1 for Dark
        t_idx = 0 if self.theme_mode == "Light" else 1
        
        # Canvas
        self.canvas.config(bg=PS_GRAY_DARK[t_idx])
        
        # Listbox
        self.file_listbox.config(bg=PS_GRAY_DARK[t_idx], fg=PS_TEXT_COLOR[t_idx], selectbackground=PS_ACTIVE[t_idx])
        
        # Scrollbars (Standard TK)
        for sb in [self.v_scroll, self.h_scroll]:
            sb.config(bg=PS_GRAY_MED[t_idx], troughcolor=PS_GRAY_DARK[t_idx], activebackground=PS_GRAY_LIGHT[t_idx])
            
        # PanedWindow
        self.paned_window.config(bg=PS_BORDER_COLOR[t_idx])
        
        # Menu Bar (Re-create to update colors)
        self._setup_menu()
        
        # Update Sidebar eye icons (they are CTkButtons but use static images)
        self.update_sidebar_objects()
        self.refresh_file_list() # To update text color if needed

    # --- UI SETUP ---
    def _setup_ui(self):
        # 1. TOP NAV BAR (Reduced Height, Flat Gray)
        self.nav_bar = ctk.CTkFrame(self, height=42, corner_radius=0, fg_color=PS_GRAY_MED)
        self.nav_bar.pack(side="top", fill="x")
        self.nav_bar.grid_columnconfigure(2, weight=1) 
        
        # Branding
        if self.branding_img:
            lbl = ctk.CTkLabel(self.nav_bar, text="", image=self.branding_img)
            lbl.grid(row=0, column=0, sticky="w", padx=20, pady=5)
        else:
            ctk.CTkLabel(self.nav_bar, text="ANNOTAMATE", font=("Arial", 18, "bold"), text_color="white").grid(row=0, column=0, sticky="w", padx=20)

        # Left Tools
        self.frame_tools_left = ctk.CTkFrame(self.nav_bar, fg_color="transparent")
        self.frame_tools_left.grid(row=0, column=1, sticky="w", padx=20)
        
        self.nav_buttons = [] # Reset list

        def make_nav_btn(parent, text, icon, cmd, icon_name, color=PS_GRAY_MED, hover=PS_GRAY_LIGHTER):
            btn = ctk.CTkButton(
                parent, text=text, image=icon, compound="top", 
                width=42, height=36, corner_radius=2, fg_color=color, hover_color=hover, 
                text_color=PS_TEXT_COLOR, font=("Arial", 10), command=cmd
            )
            btn.pack(side="left", padx=3)
            # Store reference for theme toggling
            self.nav_buttons.append((btn, icon_name))
            return btn

        # (Removed Hamburger from here)

        make_nav_btn(self.frame_tools_left, "Image Dir", self.icon_folder, self.load_directory, "folder")
        make_nav_btn(self.frame_tools_left, "Labels Dir", self.icon_folder, self.set_label_directory, "folder")
        
        # Separator
        ctk.CTkFrame(self.frame_tools_left, width=1, height=26, fg_color=PS_GRAY_LIGHT).pack(side="left", padx=8)
        
        # Class Manager Button
        make_nav_btn(self.frame_tools_left, "Classes", self.icon_tag, self.open_class_manager, "tag")

        ctk.CTkFrame(self.frame_tools_left, width=1, height=26, fg_color=PS_GRAY_LIGHT).pack(side="left", padx=8)
        
        # Format Selector
        self.opt_format = ctk.CTkOptionMenu(self.frame_tools_left, variable=self.format_var, 
                                            values=["YOLO", "Pascal VOC", "COCO"], width=100, height=24,
                                            fg_color=PS_GRAY_LIGHT, button_color=PS_GRAY_LIGHTER, button_hover_color=PS_ACTIVE,
                                            dropdown_fg_color=PS_GRAY_MED, text_color=PS_TEXT_COLOR, corner_radius=2,
                                            command=lambda _: self.refresh_file_list()) # Refresh list to update checks
        self.opt_format.pack(side="left", padx=5)

        make_nav_btn(self.frame_tools_left, "Save", self.icon_save, self.save_annotation, "save", color=PS_GRAY_MED, hover=PS_ACTIVE)

        # Center (Nav)
        self.frame_center = ctk.CTkFrame(self.nav_bar, fg_color="transparent")
        self.frame_center.grid(row=0, column=2) 

        ctk.CTkButton(self.frame_center, text="", image=self.icon_prev, width=32, height=32, corner_radius=2, fg_color="transparent", hover_color=PS_GRAY_LIGHT, command=self.prev_image).pack(side="left", padx=5)
        ctk.CTkButton(self.frame_center, text="", image=self.icon_next, width=32, height=32, corner_radius=2, fg_color="transparent", hover_color=PS_GRAY_LIGHT, command=self.next_image).pack(side="left", padx=5)

        # Right Tools
        self.frame_tools_right = ctk.CTkFrame(self.nav_bar, fg_color="transparent")
        self.frame_tools_right.grid(row=0, column=3, sticky="e", padx=20)
        
        # THEME BUTTON
        make_nav_btn(self.frame_tools_right, "Theme", self.icon_theme, self.toggle_theme, "theme", color=PS_GRAY_MED, hover=PS_GRAY_LIGHTER)

        self.seg_mode = ctk.CTkSegmentedButton(
            self.frame_tools_right, 
            values=["Rect", "Edit"], 
            variable=self.draw_mode_var, 
            command=self.on_mode_change, 
            width=140, height=24,
            corner_radius=2,
            selected_color=PS_ACTIVE,
            selected_hover_color=PS_ACTIVE,
            unselected_color=PS_GRAY_LIGHT,
            unselected_hover_color=PS_GRAY_LIGHTER,
            text_color=PS_TEXT_COLOR
        )
        self.seg_mode.pack(side="left", padx=10)

        self.chk_autosave = ctk.CTkSwitch(
            self.frame_tools_right, 
            text="AutoSave", 
            variable=self.auto_save_var, 
            progress_color=PS_ACTIVE,
            button_color="white",
            button_hover_color="white",
            fg_color=PS_GRAY_LIGHT,
            text_color=PS_TEXT_COLOR,
            font=("Arial", 11, "bold"), 
            width=40, height=20
        )
        self.chk_autosave.pack(side="left", padx=5)
        
        make_nav_btn(self.frame_tools_right, "Delete Image", self.icon_del, self.delete_current_image, "del", color=PS_GRAY_MED, hover="#552222")

        # 3. BODY (Using Standard TK PanedWindow - requires manual theme handling)
        t_idx = 1 # Start Dark
        self.paned_window = tk.PanedWindow(self, orient=tk.HORIZONTAL, bg=PS_BORDER_COLOR[t_idx], sashwidth=2, sashrelief=tk.FLAT)

    def _setup_footer(self):
        self.footer = ctk.CTkFrame(self, height=30, corner_radius=0, fg_color=PS_GRAY_MED)
        self.footer.pack(side="bottom", fill="x")
        self.footer.pack_propagate(False)
        
        # --- HAMBURGER MENU (Footer Left) ---
        self.btn_hamburger = ctk.CTkButton(self.footer, text="", image=self.icon_bars, 
                                           width=24, height=24, 
                                           fg_color="transparent", hover_color=PS_GRAY_LIGHTER,
                                           command=self.show_hamburger_menu)
        self.btn_hamburger.pack(side="right", padx=(10, 5))
        # Add to nav_buttons so it toggles color with theme
        self.nav_buttons.append((self.btn_hamburger, "bars"))

        # Left Area: Minimized Tabs
        self.frame_minimized_tabs = ctk.CTkFrame(self.footer, fg_color="transparent")
        self.frame_minimized_tabs.pack(side="left", padx=5)

        # Right Area: Zoom (Packed BEFORE Center to ensure it stays right)
        self.frame_zoom = ctk.CTkFrame(self.footer, fg_color="transparent")
        self.frame_zoom.pack(side="right", padx=15)
        
        ctk.CTkButton(self.frame_zoom, text="Fit (F)", width=60, height=20, corner_radius=2, fg_color=PS_GRAY_LIGHT, hover_color=PS_GRAY_LIGHTER, text_color=PS_TEXT_COLOR, font=("Arial", 10), command=self.zoom_fit).pack(side="left", padx=5)
        ctk.CTkButton(self.frame_zoom, text="-", width=24, height=20, corner_radius=2, fg_color=PS_GRAY_LIGHT, hover_color=PS_GRAY_LIGHTER, text_color=PS_TEXT_COLOR, font=("Arial", 12, "bold"), command=self.zoom_out).pack(side="left", padx=2)
        self.lbl_zoom = ctk.CTkLabel(self.frame_zoom, text="100%", width=40, text_color=PS_TEXT_COLOR, font=("Arial", 11))
        self.lbl_zoom.pack(side="left", padx=2)
        ctk.CTkButton(self.frame_zoom, text="+", width=24, height=20, corner_radius=2, fg_color=PS_GRAY_LIGHT, hover_color=PS_GRAY_LIGHTER, text_color=PS_TEXT_COLOR, font=("Arial", 12, "bold"), command=self.zoom_in).pack(side="left", padx=2)

        # Center Area: File Info (Fills remaining space)
        self.frame_info = ctk.CTkFrame(self.footer, fg_color="transparent")
        self.frame_info.pack(side="left", fill="both", expand=True)

        # Single Centered Label for all info
        self.lbl_info = ctk.CTkLabel(self.frame_info, text="No Image", text_color="#aaaaaa", font=("Arial", 11))
        self.lbl_info.pack(expand=True) # Centers the label in the frame

        self.paned_window.pack(fill=tk.BOTH, expand=True)

        self.frame_left = ctk.CTkFrame(self.paned_window, corner_radius=0, fg_color=PS_GRAY_DARK) # Canvas Area
        self.paned_window.add(self.frame_left, stretch="always")
        self.frame_left.grid_rowconfigure(0, weight=1); self.frame_left.grid_columnconfigure(0, weight=1)

        t_idx = 1 # Start Dark
        self.v_scroll = tk.Scrollbar(self.frame_left, orient=tk.VERTICAL, bg=PS_GRAY_MED[t_idx], troughcolor=PS_GRAY_DARK[t_idx], activebackground=PS_GRAY_LIGHT[t_idx])
        self.h_scroll = tk.Scrollbar(self.frame_left, orient=tk.HORIZONTAL, bg=PS_GRAY_MED[t_idx], troughcolor=PS_GRAY_DARK[t_idx], activebackground=PS_GRAY_LIGHT[t_idx])
        
        self.canvas = tk.Canvas(
            self.frame_left, bg=PS_GRAY_DARK[t_idx], 
            highlightthickness=0, borderwidth=0, 
            cursor="tcross", 
            xscrollcommand=self.h_scroll.set, yscrollcommand=self.v_scroll.set
        )
        self.v_scroll.config(command=self.canvas.yview); self.h_scroll.config(command=self.canvas.xview)
        self.canvas.grid(row=0, column=0, sticky="nsew")

        self.canvas.bind("<ButtonPress-1>", self.on_mouse_down)   
        self.canvas.bind("<B1-Motion>", self.on_mouse_drag)       
        self.canvas.bind("<ButtonRelease-1>", self.on_mouse_up)   
        self.canvas.bind("<Motion>", self.on_mouse_move)          
        self.canvas.bind("<Button-3>", self.on_right_click)            
        self.canvas.bind("<Control-MouseWheel>", self.on_zoom)
        self.canvas.bind("<MouseWheel>", self.on_vertical_scroll)
        self.canvas.bind("<Shift-MouseWheel>", self.on_horizontal_scroll)
        
        self.frame_left.bind("<Configure>", self.on_resize_frame)

        # --- SIDEBAR CONSTRUCTION ---
        self.frame_right = ctk.CTkFrame(self.paned_window, corner_radius=0, width=300, fg_color=PS_GRAY_MED)
        self.paned_window.add(self.frame_right, stretch="never")
        
        # We use pack inside frame_right to allow panels to collapse/expand naturally
        
        # === GROUP 1: OBJECTS ===
        self.group_objects = ctk.CTkFrame(self.frame_right, fg_color="transparent")
        if self.objects_visible:
            self.group_objects.pack(side="top", fill="both", expand=True, padx=5, pady=5)
        else:
            self.create_footer_tab("objects")
        
        # Header Objects
        self.head_obj = ctk.CTkFrame(self.group_objects, height=28, fg_color="transparent")
        self.head_obj.pack(fill="x", pady=(0, 5))
        ctk.CTkLabel(self.head_obj, text="OBJECTS", font=("Arial", 12, "bold"), text_color="#aaaaaa").pack(side="left")
        
        # Controls
        self.btn_close_obj = ctk.CTkButton(self.head_obj, text="", image=self.icon_close, width=20, height=20, fg_color="transparent", hover_color="#C0392B", command=lambda: self.close_panel("objects"))
        self.btn_close_obj.pack(side="right", padx=2)
        self.nav_buttons.append((self.btn_close_obj, "close"))

        self.btn_min_obj = ctk.CTkButton(self.head_obj, text="", image=self.icon_min, width=20, height=20, fg_color="transparent", hover_color=PS_GRAY_LIGHT, command=lambda: self.minimize_panel("objects"))
        self.btn_min_obj.pack(side="right", padx=2)
        self.nav_buttons.append((self.btn_min_obj, "min"))

        # Content Objects
        self.frame_obj_content = ctk.CTkFrame(self.group_objects, fg_color="transparent")
        self.frame_obj_content.pack(fill="both", expand=True)
        
        self.chk_show_all = ctk.CTkSwitch(self.frame_obj_content, text="Show All", variable=self.show_all_var, 
                                          progress_color=PS_ACTIVE, fg_color=PS_GRAY_LIGHT, text_color=PS_TEXT_COLOR,
                                          command=self.toggle_show_all, width=80, height=20, font=("Arial", 10))
        self.chk_show_all.pack(side="top", anchor="w", pady=(0,5))

        self.scroll_objects = ctk.CTkScrollableFrame(self.frame_obj_content, label_text=None, fg_color=PS_GRAY_DARK)
        self.scroll_objects.pack(fill="both", expand=True)

        # === GROUP 2: FILES ===
        self.group_files = ctk.CTkFrame(self.frame_right, fg_color="transparent")
        if self.files_visible:
            self.group_files.pack(side="top", fill="both", expand=True, padx=5, pady=5)
        else:
            self.create_footer_tab("files")
        
        # Header Files
        self.head_file = ctk.CTkFrame(self.group_files, height=28, fg_color="transparent")
        self.head_file.pack(fill="x", pady=(0, 5))
        ctk.CTkLabel(self.head_file, text="IMAGE FILES", font=("Arial", 12, "bold"), text_color="#aaaaaa").pack(side="left")
        
        # Controls
        self.btn_close_file = ctk.CTkButton(self.head_file, text="", image=self.icon_close, width=20, height=20, fg_color="transparent", hover_color="#C0392B", command=lambda: self.close_panel("files"))
        self.btn_close_file.pack(side="right", padx=2)
        self.nav_buttons.append((self.btn_close_file, "close"))

        self.btn_min_file = ctk.CTkButton(self.head_file, text="", image=self.icon_min, width=20, height=20, fg_color="transparent", hover_color=PS_GRAY_LIGHT, command=lambda: self.minimize_panel("files"))
        self.btn_min_file.pack(side="right", padx=2)
        self.nav_buttons.append((self.btn_min_file, "min"))

        # Content Files
        self.frame_file_content = ctk.CTkFrame(self.group_files, fg_color="transparent")
        self.frame_file_content.pack(fill="both", expand=True)

        self.chk_unlabelled = ctk.CTkSwitch(self.frame_file_content, text="Unlabelled Only", variable=self.show_unlabelled_var,
                                            progress_color=PS_ACTIVE, fg_color=PS_GRAY_LIGHT, text_color=PS_TEXT_COLOR,
                                            command=self.refresh_file_list, width=80, height=20, font=("Arial", 10))
        self.chk_unlabelled.pack(side="top", anchor="w", pady=(0,5))
        
        self.entry_search = ctk.CTkEntry(self.frame_file_content, placeholder_text="Search files...", fg_color=PS_GRAY_DARK, border_color=PS_GRAY_LIGHT, text_color=PS_TEXT_COLOR)
        self.entry_search.pack(fill="x", pady=(0, 5))
        self.entry_search.bind("<KeyRelease>", self.refresh_file_list)
        self.entry_search.bind("<FocusIn>", lambda e: self.unbind_shortcuts())
        self.entry_search.bind("<FocusOut>", lambda e: self.bind_shortcuts_func())

        # Listbox Frame
        self.listbox_frame = ctk.CTkFrame(self.frame_file_content, fg_color="transparent")
        self.listbox_frame.pack(fill="both", expand=True)

        self.scrollbar_files = ctk.CTkScrollbar(self.listbox_frame, button_color=PS_GRAY_LIGHT, button_hover_color=PS_GRAY_LIGHTER)
        self.scrollbar_files.pack(side="right", fill="y")
        
        # Standard TK Listbox (Needs explicit theme init)
        self.file_listbox = tk.Listbox(
            self.listbox_frame, 
            bg=PS_GRAY_DARK[t_idx], 
            fg=PS_TEXT_COLOR[t_idx], 
            selectbackground=PS_ACTIVE[t_idx], 
            selectforeground="white",
            highlightthickness=0, 
            borderwidth=0,
            activestyle="none",
            font=("Arial", 10),
            yscrollcommand=self.scrollbar_files.set
        )
        self.file_listbox.pack(side="left", fill="both", expand=True)
        self.scrollbar_files.configure(command=self.file_listbox.yview)
        
        self.file_listbox.bind("<<ListboxSelect>>", self.on_listbox_select)

        self.refresh_class_list()
        self.reset_class_selection()
        
        # Ensure correct initial state (Hide sidebar if both are False)
        self.check_sidebar_visibility()

    # --- PANEL MANAGEMENT ---
    def show_hamburger_menu(self):
        # Create a popup menu
        menu = tk.Menu(self, tearoff=0)
        # Determine theme colors
        t_idx = 0 if self.theme_mode == "Light" else 1
        bg_color = PS_GRAY_MED[t_idx]
        fg_color = PS_TEXT_COLOR[t_idx]
        
        menu.config(bg=bg_color, fg=fg_color)
        
        # Add options to show panels
        # State logic: If hidden or minimized, clicking "Show" restores it.
        # If visible, clicking hides it.
        
        menu.add_checkbutton(label="Show Object Panel", 
                             variable=tk.BooleanVar(value=self.objects_visible),
                             command=lambda: self.toggle_panel_visibility("objects"))
        
        menu.add_checkbutton(label="Show Image Files Panel", 
                             variable=tk.BooleanVar(value=self.files_visible),
                             command=lambda: self.toggle_panel_visibility("files"))
                             
        try:
            x = self.btn_hamburger.winfo_rootx()
            y = self.btn_hamburger.winfo_rooty() + self.btn_hamburger.winfo_height()
            menu.tk_popup(x, y)
        finally:
            menu.grab_release()

    def toggle_panel_visibility(self, panel):
        if panel == "objects":
            if self.objects_visible: self.close_panel("objects")
            else: self.restore_panel("objects")
        elif panel == "files":
            if self.files_visible: self.close_panel("files")
            else: self.restore_panel("files")

    def close_panel(self, panel):
        if panel == "objects":
            self.group_objects.pack_forget()
            self.objects_visible = False
        elif panel == "files":
            self.group_files.pack_forget()
            self.files_visible = False
        
        # Remove from footer if it was minimized
        self.remove_minimized_btn(panel)
        
        # Check if we need to hide the whole sidebar
        self.check_sidebar_visibility()

    def minimize_panel(self, panel):
        # Hide content, keep logic active
        self.close_panel(panel) # Temporarily hide
        # But create footer button
        self.create_footer_tab(panel)
        # Mark state as technically "visible" but minimized? 
        # For simplicity, if minimized, it's hidden from sidebar, so visible=False in sidebar context.
        # But users can restore from footer.

    def restore_panel(self, panel):
        # Ensure sidebar is visible first
        self.check_sidebar_visibility(restoring=True)

        if panel == "objects":
            self.objects_visible = True
            # Check if files is visible to determine order
            if self.files_visible:
                self.group_objects.pack(side="top", fill="both", expand=True, padx=5, pady=5, before=self.group_files)
            else:
                self.group_objects.pack(side="top", fill="both", expand=True, padx=5, pady=5)
                
        elif panel == "files":
            self.files_visible = True
            # Files always go below objects if objects are present
            self.group_files.pack(side="top", fill="both", expand=True, padx=5, pady=5)
            
        self.remove_minimized_btn(panel)

    def check_sidebar_visibility(self, restoring=False):
        if restoring:
            # If we are restoring a panel, we MUST show the sidebar if it's currently hidden
            # We check if it's currently in the panes list
            if str(self.frame_right) not in self.paned_window.panes():
                self.paned_window.add(self.frame_right, stretch="never", width=300)
                self.after(100, self.zoom_fit)
        else:
            # If closing/minimizing, check if BOTH panels are hidden
            if not self.objects_visible and not self.files_visible:
                # Force remove sidebar from layout to remove background completely
                self.paned_window.forget(self.frame_right)
                self.after(100, self.zoom_fit)
                
    def create_footer_tab(self, panel):
        if panel in self.minimized_btns: return
        
        lbl = "Objects" if panel == "objects" else "Files"
        
        btn = ctk.CTkButton(self.frame_minimized_tabs, text=lbl, width=80, height=24, 
                            fg_color=PS_GRAY_LIGHT, text_color=PS_TEXT_COLOR,
                            command=lambda: self.restore_panel(panel))
        btn.pack(side="left", padx=2)
        self.minimized_btns[panel] = btn

    def remove_minimized_btn(self, panel):
        if panel in self.minimized_btns:
            self.minimized_btns[panel].destroy()
            del self.minimized_btns[panel]

    # --- Path Helpers ---
    def get_annotation_path(self, img_path):
        """Returns the expected annotation path based on current format."""
        fmt = self.format_var.get()
        if fmt == "Pascal VOC": ext = ".xml"
        elif fmt == "COCO": ext = ".json"
        else: ext = ".txt" # YOLO default
        
        basename = os.path.splitext(os.path.basename(img_path))[0] + ext
        if self.label_dir: return os.path.join(self.label_dir, basename)
        else: return os.path.join(os.path.dirname(img_path), basename)

    # kept for legacy references, but should use get_annotation_path
    def get_txt_path(self, img_path):
        return self.get_annotation_path(img_path)

    def get_classes_file_path(self):
        if self.label_dir: return os.path.join(self.label_dir, "classes.txt")
        elif self.current_dir: return os.path.join(self.current_dir, "classes.txt")
        return None

    # --- Directory Loading ---
    def load_directory(self):
        d = filedialog.askdirectory(title="Select Image Directory")
        if not d: return
        self.current_dir = d
        self.label_dir = None 
        self.load_classes()
        self.image_list = sorted(glob.glob(os.path.join(d, "*.*")))
        self.image_list = [x for x in self.image_list if x.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp'))]
        self.annot_cache = {} # Clear cache on new load
        self.refresh_file_list()
        self.current_index = 0
        self.find_latest_session_and_jump(d)
        if self.image_list: self.load_image_data()
        self.after(200, self.set_label_directory)

    def set_label_directory(self):
        if not self.current_dir: return
        d = filedialog.askdirectory(title="Select Label/Annotation Directory")
        if d:
            self.label_dir = d
            self.load_classes()
            self.annot_cache = {} # Clear cache on label change
            self.find_latest_session_and_jump(d)
            if self.image_list: self.load_image_data()
        else:
            self.find_latest_session_and_jump(self.current_dir)
            if self.image_list: self.load_image_data()

    def find_latest_session_and_jump(self, search_dir):
        if not search_dir or not os.path.exists(search_dir): return
        # Simple heuristic: check for any annotation file
        txt_files = glob.glob(os.path.join(search_dir, "*.txt"))
        xml_files = glob.glob(os.path.join(search_dir, "*.xml"))
        json_files = glob.glob(os.path.join(search_dir, "*.json"))
        
        all_files = txt_files + xml_files + json_files
        all_files = [f for f in all_files if os.path.basename(f) != "classes.txt"]
        
        if not all_files: return
        try:
            latest_file = max(all_files, key=os.path.getmtime)
            latest_base = os.path.splitext(os.path.basename(latest_file))[0]
            for i, img_path in enumerate(self.image_list):
                img_base = os.path.splitext(os.path.basename(img_path))[0]
                if img_base == latest_base:
                    self.current_index = i
                    return
        except: pass

    def load_classes(self):
        cp = self.get_classes_file_path()
        if cp and os.path.exists(cp):
            try:
                with open(cp, "r") as f:
                    lc = [x.strip() for x in f.readlines() if x.strip()]
                    if lc: self.classes = lc; self.refresh_class_list()
            except: pass

    # --- Logic ---
    def reset_class_selection(self):
        self.selected_class_var.set("-1")
        self.refresh_class_list()

    def on_mode_change(self, value):
        self.selected_box_idx = None
        self.canvas.delete("temp_poly")
        self.canvas.delete("rubber_band")
        self.redraw_boxes()

    def _bind_shortcuts(self): self.bind_shortcuts_func()
    def bind_shortcuts_func(self):
        self.bind("w", lambda e: self.set_mode("Rect"))
        self.bind("x", lambda e: self.on_press_x())
        self.bind("s", lambda e: self.save_annotation())
        self.bind("a", lambda e: self.prev_image())
        self.bind("d", lambda e: self.next_image())
        self.bind("f", lambda e: self.zoom_fit()) 
        self.bind("<Control-z>", lambda e: self.undo_last(e))
        self.bind("<Control-y>", lambda e: self.redo_last(e))
        self.bind("<Control-d>", lambda e: self.duplicate_selected_box(e)) # New Binding

    def unbind_shortcuts(self): 
        self.unbind("w"); self.unbind("x"); self.unbind("s"); self.unbind("a"); self.unbind("d"); self.unbind("<Control-z>"); self.unbind("<Control-y>"); self.unbind("f"); self.unbind("<Control-d>")

    def on_press_x(self):
        # Switch to Edit mode
        self.draw_mode_var.set("Edit")
        self.on_mode_change("Edit")
        
        # If box selected, open change class dialog
        if self.selected_box_idx is not None:
            self.is_processing = True 
            self.update()
            dialog = ClassManagerDialog(self, selection_mode=True)
            self.wait_window(dialog)
            
            if dialog.result is not None: 
                self.bboxes[self.selected_box_idx]['class_id'] = dialog.result
                self.redraw_boxes()
                self.update_sidebar_objects()
                self.has_unsaved_changes = True
            
            self.after(200, lambda: setattr(self, 'is_processing', False))

    def duplicate_selected_box(self, event=None):
        if self.selected_box_idx is None or self.selected_box_idx >= len(self.bboxes): return
        box = self.bboxes[self.selected_box_idx].copy()
        
        # Offset slightly
        offset = 15 / self.imscale
        w = self.pil_image.width; h = self.pil_image.height
        box['x1'] = min(box['x1'] + offset, w - 5); box['x2'] = min(box['x2'] + offset, w)
        box['y1'] = min(box['y1'] + offset, h - 5); box['y2'] = min(box['y2'] + offset, h)
        
        self.bboxes.append(box)
        self.selected_box_idx = len(self.bboxes) - 1 # Select new box
        self.redraw_boxes(); self.update_sidebar_objects(); self.has_unsaved_changes = True

    def check_unsaved_changes(self):
        if self.auto_save_var.get():
            self.save_annotation()
            return True
        if self.has_unsaved_changes:
            choice = messagebox.askyesnocancel("Unsaved Changes", "You have unsaved changes.\nSave before continuing?")
            if choice is None: return False
            if choice: self.save_annotation()
        return True

    def undo_last(self, event=None):
        if self.bboxes: 
            box = self.bboxes.pop(); self.redo_stack.append(box); 
            self.redraw_boxes(); self.update_sidebar_objects()
            self.has_unsaved_changes = True

    def redo_last(self, event=None):
        if self.redo_stack:
            box = self.redo_stack.pop(); self.bboxes.append(box); 
            self.redraw_boxes(); self.update_sidebar_objects()
            self.has_unsaved_changes = True

    def clear_redo_stack(self): self.redo_stack = []

    # --- Class & File Mgmt ---
    def sync_classes_file(self):
        cp = self.get_classes_file_path()
        if not cp: return
        try:
            with open(cp, "w") as f:
                for cls in self.classes: f.write(f"{cls}\n")
        except: pass

    def refresh_class_list(self):
        # Update the Manager Window if it's open
        if self.class_manager_window and self.class_manager_window.winfo_exists():
            self.class_manager_window.refresh_list()

    def add_class(self, new_name=None, from_popup=False):
        # Called from Class Manager
        if new_name and new_name not in self.classes:
            self.classes.append(new_name)
            self.refresh_class_list()
            self.sync_classes_file()

    def delete_class(self):
        # Called from Class Manager
        if not self.classes: return
        try: idx = int(self.selected_class_var.get())
        except: return
        if idx < 0 or idx >= len(self.classes): return
        if messagebox.askyesno("Delete", f"Delete '{self.classes[idx]}'?"):
            self.classes.pop(idx); self.selected_class_var.set("-1")
            self.refresh_class_list()
            self.sync_classes_file()
            self.redraw_boxes() # Colors might shift

    # --- OPTIMIZED REFRESH LIST ---
    def refresh_file_list(self, event=None):
        self.file_listbox.delete(0, tk.END)
        self.filtered_indices = [] 

        search_text = self.entry_search.get().lower().strip()
        show_unlabelled = self.show_unlabelled_var.get()
        
        for idx, path in enumerate(self.image_list):
            basename = os.path.basename(path)
            if search_text and search_text not in basename.lower():
                continue

            # Cached check
            if path in self.annot_cache:
                exists = self.annot_cache[path]
            else:
                annot_path = self.get_annotation_path(path)
                exists = os.path.exists(annot_path)
                self.annot_cache[path] = exists

            # Unlabelled filter logic
            if show_unlabelled and exists:
                continue

            prefix = "✔ " if exists else "   "
            display_text = f"{prefix}{basename}"
            
            self.file_listbox.insert(tk.END, display_text)
            self.filtered_indices.append(idx)
            
        self.highlight_current_file()

    def highlight_current_file(self):
        self.file_listbox.selection_clear(0, tk.END)
        
        # Find index in filtered list
        listbox_idx = -1
        try:
            listbox_idx = self.filtered_indices.index(self.current_index)
        except ValueError:
            pass # Current image filtered out
        
        if listbox_idx != -1:
            self.file_listbox.selection_set(listbox_idx)
            self.file_listbox.see(listbox_idx)

    def on_listbox_select(self, event):
        selection = self.file_listbox.curselection()
        if not selection: return
        
        listbox_idx = selection[0]
        real_idx = self.filtered_indices[listbox_idx]
        
        if real_idx != self.current_index:
             self.jump_to_image(real_idx)

    def jump_to_image(self, index):
        if not self.check_unsaved_changes(): 
            self.highlight_current_file() # Revert selection if canceled
            return
        self.current_index = index; self.load_image_data()
    
    def next_image(self):
        if self.current_index < len(self.image_list)-1:
            if not self.check_unsaved_changes(): return
            self.current_index += 1; self.load_image_data()
    def prev_image(self):
        if self.current_index > 0:
            if not self.check_unsaved_changes(): return
            self.current_index -= 1; self.load_image_data()

    def load_image_data(self):
        if not self.image_list: return
        path = self.image_list[self.current_index]
        name = os.path.basename(path)
        self.pil_image = Image.open(path)
        
        count_str = f"[{self.current_index + 1}/{len(self.image_list)}]"
        
        # Reset window title to static
        self.title("Annotamate Pro")
        
        self.bboxes = []
        self.redo_stack = [] 
        
        # Load annotations
        loaded_annot_path = self.load_annotations(path)
        
        if loaded_annot_path:
            annot_file = os.path.basename(loaded_annot_path)
        else:
            annot_file = "No Annotation"

        # Format: face_0002.jpg | Path: C:/... | Loaded: face_0002.txt [1/886]
        # Using centered dot or pipe separator
        info_text = f"{name}  |  Path: {path}  |  Loaded: {annot_file} {count_str}"
        self.lbl_info.configure(text=info_text)

        self.has_unsaved_changes = False
        
        self.zoom_fit() 
        self.highlight_current_file()
        self.update_sidebar_objects() 

    def on_resize_frame(self, event):
        if self.pil_image: self.render_image()

    def render_image(self):
        if not self.pil_image: return
        w, h = self.pil_image.size
        new_w, new_h = int(w * self.imscale), int(h * self.imscale)
        self.tk_image = ImageTk.PhotoImage(self.pil_image.resize((new_w, new_h), Image.Resampling.NEAREST))
        
        if self.lbl_zoom:
            self.lbl_zoom.configure(text=f"{int(self.imscale * 100)}%")

        canvas_w = self.frame_left.winfo_width()
        canvas_h = self.frame_left.winfo_height()
        
        if new_w < canvas_w: self.img_ox = (canvas_w - new_w) // 2
        else: self.img_ox = 0
        if new_h < canvas_h: self.img_oy = (canvas_h - new_h) // 2
        else: self.img_oy = 0

        if new_w > canvas_w: self.h_scroll.grid(row=1, column=0, sticky="ew")
        else: self.h_scroll.grid_remove()
        if new_h > canvas_h: self.v_scroll.grid(row=0, column=1, sticky="ns")
        else: self.v_scroll.grid_remove()

        self.canvas.delete("all")
        self.canvas.config(scrollregion=(0, 0, new_w, new_h)) 
        self.canvas.create_image(self.img_ox, self.img_oy, anchor="nw", image=self.tk_image)
        self.redraw_boxes()

    def get_canvas_coords_raw(self, event):
        return self.canvas.canvasx(event.x), self.canvas.canvasy(event.y)

    def get_image_coords(self, event):
        cx, cy = self.get_canvas_coords_raw(event)
        ix = cx - self.img_ox
        iy = cy - self.img_oy
        w = self.pil_image.width * self.imscale
        h = self.pil_image.height * self.imscale
        ix = max(0, min(ix, w))
        iy = max(0, min(iy, h))
        return ix, iy
    
    # --- ZOOM CONTROLS ---
    def zoom_in(self):
        if not self.pil_image: return
        self.imscale = min(self.imscale * 1.2, 20.0)
        self.render_image()

    def zoom_out(self):
        if not self.pil_image: return
        self.imscale = max(self.imscale * 0.8, 0.1)
        self.render_image()

    def zoom_fit(self):
        if not self.pil_image: return
        frame_h = self.frame_left.winfo_height()
        frame_w = self.frame_left.winfo_width()
        if frame_h < 50: frame_h = 700
        if frame_w < 50: frame_w = 900
        
        w_img, h_img = self.pil_image.size
        safe_h = frame_h - 10
        safe_w = frame_w - 10
        scale_h = safe_h / h_img
        scale_w = safe_w / w_img
        self.imscale = min(scale_h, scale_w)
        self.render_image()

    def on_zoom(self, event):
        if not self.pil_image: return
        
        # 1. Get coordinate of mouse on the image (original scale)
        c_x = self.canvas.canvasx(event.x)
        c_y = self.canvas.canvasy(event.y)
        
        img_x = (c_x - self.img_ox) / self.imscale
        img_y = (c_y - self.img_oy) / self.imscale
        
        # 2. Calculate new scale
        sf = 0.9 if (event.num == 5 or event.delta < 0) else 1.1
        new_scale = max(0.1, min(self.imscale * sf, 20.0))
        
        if new_scale == self.imscale: return
        self.imscale = new_scale
        
        # 3. Render
        self.render_image()
        
        # 4. Scroll to keep point under mouse
        new_c_x = img_x * self.imscale + self.img_ox
        new_c_y = img_y * self.imscale + self.img_oy
        
        target_scroll_x = new_c_x - event.x
        target_scroll_y = new_c_y - event.y
        
        total_w = self.pil_image.width * self.imscale
        total_h = self.pil_image.height * self.imscale
        
        if total_w > self.canvas.winfo_width():
            self.canvas.xview_moveto(max(0, target_scroll_x / total_w))
            
        if total_h > self.canvas.winfo_height():
            self.canvas.yview_moveto(max(0, target_scroll_y / total_h))

    # --- SCROLL INPUT ---
    def on_vertical_scroll(self, event):
        if self.v_scroll.winfo_ismapped():
            if event.delta:
                self.canvas.yview_scroll(int(-1*(event.delta/120)), "units")

    def on_horizontal_scroll(self, event):
        if self.h_scroll.winfo_ismapped():
            if event.delta:
                self.canvas.xview_scroll(int(-1*(event.delta/120)), "units")

    # --- CANVAS INPUT ---
    def draw_crosshair(self, event):
        self.canvas.delete("crosshair")
        if not self.pil_image: return
        x = self.canvas.canvasx(event.x)
        y = self.canvas.canvasy(event.y)
        min_x = self.canvas.canvasx(0)
        min_y = self.canvas.canvasy(0)
        max_x = self.canvas.canvasx(self.canvas.winfo_width())
        max_y = self.canvas.canvasy(self.canvas.winfo_height())
        # Black Background Line for Contrast
        self.canvas.create_line(x, min_y, x, max_y, fill="black", width=3, tags="crosshair")
        self.canvas.create_line(min_x, y, max_x, y, fill="black", width=3, tags="crosshair")
        # White Foreground Line
        self.canvas.create_line(x, min_y, x, max_y, fill="white", width=1, dash=(3, 3), tags="crosshair")
        self.canvas.create_line(min_x, y, max_x, y, fill="white", width=1, dash=(3, 3), tags="crosshair")

    def on_mouse_down(self, event):
        self.focus() # Ensure focus leaves entry widgets
        if not self.pil_image: return
        if self.is_processing: return
        ix, iy = self.get_image_coords(event)
        mode = self.draw_mode_var.get()

        if mode == "Edit":
            if self.selected_box_idx is not None:
                # --- FIX: Validate index before accessing ---
                if self.selected_box_idx >= len(self.bboxes):
                    self.selected_box_idx = None
                else:
                    action = self.check_resize_handles(self.selected_box_idx, ix, iy)
                    if action:
                        self.drawing = True; self.drag_action = action; self.start_x, self.start_y = ix, iy; return
            
            idx = self.find_box_under_mouse(ix, iy)
            if idx is not None:
                self.selected_box_idx = idx; self.drawing = True; self.drag_action = "move"; self.start_x, self.start_y = ix, iy
                self.redraw_boxes() # Will highlight sidebar
            else:
                self.selected_box_idx = None; self.redraw_boxes()
        
        elif mode == "Rect":
            self.drawing = True; self.start_x, self.start_y = ix, iy; self.selected_box_idx = None
            sx, sy = ix + self.img_ox, iy + self.img_oy
            self.current_rect = self.canvas.create_rectangle(sx, sy, sx, sy, outline="#3498db", width=3, dash=(2,2), tags="temp")

    def on_mouse_move(self, event):
        self.draw_crosshair(event)

    def on_mouse_drag(self, event):
        self.draw_crosshair(event)
        if not self.drawing: return
        ix, iy = self.get_image_coords(event)
        mode = self.draw_mode_var.get()

        if mode == "Edit" and self.selected_box_idx is not None:
            # --- FIX: Validate index ---
            if self.selected_box_idx >= len(self.bboxes):
                self.selected_box_idx = None
                return

            box = self.bboxes[self.selected_box_idx]
            dx, dy = (ix - self.start_x)/self.imscale, (iy - self.start_y)/self.imscale
            if self.drag_action == "move":
                box['x1'] += dx; box['x2'] += dx; box['y1'] += dy; box['y2'] += dy
            elif self.drag_action == "tl": box['x1'] += dx; box['y1'] += dy
            elif self.drag_action == "tr": box['x2'] += dx; box['y1'] += dy
            elif self.drag_action == "bl": box['x1'] += dx; box['y2'] += dy
            elif self.drag_action == "br": box['x2'] += dx; box['y2'] += dy
            self.start_x, self.start_y = ix, iy; self.redraw_boxes(); self.has_unsaved_changes = True
        elif mode == "Rect":
            sx, sy = self.start_x + self.img_ox, self.start_y + self.img_oy
            ex, ey = ix + self.img_ox, iy + self.img_oy
            self.canvas.coords(self.current_rect, sx, sy, ex, ey)

    def on_mouse_up(self, event):
        if self.is_processing: return
        self.drawing = False; self.drag_action = None
        mode = self.draw_mode_var.get()
        
        if mode == "Edit":
            if self.selected_box_idx is not None:
                # --- FIX: Validate index ---
                if self.selected_box_idx < len(self.bboxes):
                    b = self.bboxes[self.selected_box_idx]
                    b['x1'], b['x2'] = min(b['x1'], b['x2']), max(b['x1'], b['x2'])
                    b['y1'], b['y2'] = min(b['y1'], b['y2']), max(b['y1'], b['y2'])
                else:
                    self.selected_box_idx = None
                self.redraw_boxes()
            return
            
        if mode == "Rect":
            self.canvas.delete("temp")
            ix, iy = self.get_image_coords(event)
            self.process_new_box(self.start_x, self.start_y, ix, iy)

    def on_right_click(self, event):
        if self.is_processing: return
        self.undo_last(event)

    def process_new_box(self, x1, y1, x2, y2):
        if self.is_processing: return
        
        w_real = self.pil_image.width
        h_real = self.pil_image.height
        real_x1 = max(0, min(x1, x2) / self.imscale)
        real_y1 = max(0, min(y1, y2) / self.imscale)
        real_x2 = min(w_real, max(x1, x2) / self.imscale)
        real_y2 = min(h_real, max(y1, y2) / self.imscale)
        
        if (real_x2 - real_x1) > 5 and (real_y2 - real_y1) > 5:
            class_id = -1
            
            # --- CHECK TOGGLE LOGIC ---
            if self.use_default_class_var.get():
                try:
                    # Attempt to get selected class from radio variable
                    current_sel = int(self.selected_class_var.get())
                    if 0 <= current_sel < len(self.classes):
                        class_id = current_sel
                except:
                    pass # Invalid selection
            
            # If toggle OFF or invalid selection, ask user
            if class_id == -1:
                self.is_processing = True 
                self.update()
                # Explicitly modal selection
                dialog = ClassManagerDialog(self, selection_mode=True)
                self.wait_window(dialog)
                
                if dialog.result is not None: 
                    class_id = dialog.result
                else: 
                    self.after(200, lambda: setattr(self, 'is_processing', False))
                    return 

            self.clear_redo_stack() 
            self.bboxes.append({"class_id": class_id, "x1": real_x1, "y1": real_y1, "x2": real_x2, "y2": real_y2, "visible": True})
            self.has_unsaved_changes = True
            
            # Switch to Edit mode after drawing one box
            self.set_mode("Edit")
            
            self.after(300, lambda: setattr(self, 'is_processing', False))
            
        self.redraw_boxes()
        self.update_sidebar_objects()

    # --- Sidebar Object List & Visibility ---
    def toggle_show_all(self):
        state = self.show_all_var.get()
        for b in self.bboxes:
            b['visible'] = state
        self.redraw_boxes()
        self.update_sidebar_objects()

    def on_single_vis_toggle(self, idx):
        if 0 <= idx < len(self.bboxes):
            self.bboxes[idx]['visible'] = not self.bboxes[idx].get('visible', True)
            self.redraw_boxes()
            # Force sidebar update to toggle the eye icon
            self.update_sidebar_objects()

    def update_sidebar_objects(self):
        for widget in self.scroll_objects.winfo_children(): widget.destroy()
        
        for i, box in enumerate(self.bboxes):
            cid = box['class_id']
            if cid < len(self.classes):
                cls_name = self.classes[cid]
                color = self.get_class_color(cid)
            else:
                cls_name = "Unknown"
                color = "#999999"
            
            row = ctk.CTkFrame(self.scroll_objects, fg_color="transparent")
            row.pack(fill="x", pady=0) # Reduced padding
            
            # --- EYE VISIBILITY TOGGLE ---
            is_vis = box.get('visible', True)
            
            current_icon = self.icon_vis_on if is_vis else self.icon_vis_off
            # Light Theme hover is dimmer than Dark Theme hover, handle dynamically
            hover_color = PS_GRAY_LIGHTER[0] if self.theme_mode == "Light" else PS_GRAY_LIGHTER[1]

            btn_vis = ctk.CTkButton(
                row, 
                text="", 
                image=current_icon, 
                width=20, # Reduced size
                height=20, # Reduced size
                fg_color="transparent", 
                hover_color=hover_color,
                command=lambda idx=i: self.on_single_vis_toggle(idx)
            )
            btn_vis.pack(side="left", padx=(5,0))
            # ------------------------------

            # Indicator - 10x10 Circle (Using CTkFrame for perfect shape)
            ind = ctk.CTkFrame(row, fg_color=color, width=12, height=12, corner_radius=6)
            ind.pack(side="left", padx=(5, 8))
            
            # Selection Button
            text = f"{i+1}: {cls_name}"
            # Highlight if selected
            fg = "transparent"
            tc = "#ddd"
            
            if self.theme_mode == "Light":
                tc = "#111" if i != self.selected_box_idx else "#fff"
            else:
                tc = "#ddd" if i != self.selected_box_idx else "#fff"

            if i == self.selected_box_idx:
                fg = PS_ACTIVE[0] if self.theme_mode == "Light" else "#444"

            btn = ctk.CTkButton(row, text=text, anchor="w", fg_color=fg, 
                                text_color=tc, height=20, # Reduced height
                                command=lambda idx=i: self.select_object_from_sidebar(idx))
            btn.pack(side="left", fill="x", expand=True)

            # --- SEPARATOR ---
            sep_col = "#ccc" if self.theme_mode == "Light" else "#2b2b2b"
            sep = ctk.CTkFrame(self.scroll_objects, height=1, fg_color=sep_col)
            sep.pack(fill="x", pady=0)

    def select_object_from_sidebar(self, idx):
        self.selected_box_idx = idx
        self.redraw_boxes()
        # Also need to refresh sidebar to show selection, but redraw_boxes calls highlight logic?
        # To avoid infinite loop, I won't call update_sidebar_objects in redraw_boxes.
        # But I need to visually update the list.
        self.update_sidebar_objects()

    def redraw_boxes(self):
        self.canvas.delete("box")
        self.box_images = [] # Clear image cache
        
        for i, box in enumerate(self.bboxes):
            # VISIBILITY CHECK
            if not box.get('visible', True):
                continue

            x1 = box['x1'] * self.imscale
            y1 = box['y1'] * self.imscale
            x2 = box['x2'] * self.imscale
            y2 = box['y2'] * self.imscale
            
            sx1, sy1 = x1 + self.img_ox, y1 + self.img_oy
            sx2, sy2 = x2 + self.img_ox, y2 + self.img_oy

            cid = box['class_id']
            # Use Fixed Colors
            hex_c = self.get_class_color(cid)
            
            # --- Smooth Transparent Mask (PIL) ---
            w_box = int(sx2 - sx1)
            h_box = int(sy2 - sy1)
            if w_box > 0 and h_box > 0:
                # Convert hex to rgb
                rgb = tuple(int(hex_c.lstrip('#')[i:i+2], 16) for i in (0, 2, 4))
                # Create semi-transparent image (alpha 64 approx 25%)
                fill_img = Image.new('RGBA', (w_box, h_box), rgb + (64,))
                tk_fill = ImageTk.PhotoImage(fill_img)
                self.box_images.append(tk_fill) # Prevent GC
                self.canvas.create_image(sx1, sy1, image=tk_fill, anchor='nw', tags="box")

            width = 3 if i != self.selected_box_idx else 4
            outline_color = hex_c if i != self.selected_box_idx else "white"
            # In light mode, selected box white outline might be invisible on white background? 
            # Actually white is usually visible on image. But if image is white...
            # Standard interaction: selection is usually white or cyan.
            self.canvas.create_rectangle(sx1, sy1, sx2, sy2, outline=outline_color, width=width, tags="box")
            
            if i == self.selected_box_idx:
                r = 4 # Handle radius
                # Draw visible resize handles (anchors)
                for hx, hy in [(sx1,sy1), (sx2,sy1), (sx1,sy2), (sx2,sy2)]: 
                    self.canvas.create_rectangle(hx-r, hy-r, hx+r, hy+r, fill="white", outline="black", tags="box")
            
            if i != self.selected_box_idx:
                lbl_text = f"{cid}: {self.classes[cid]}" if cid < len(self.classes) else f"{cid}: ?"
                
                # Create text first to get bbox
                # Text color should be contrasting
                t_fill = "white" # Labels usually look best white on colored bg
                t_id = self.canvas.create_text(sx1, sy1-10, text=lbl_text, fill=t_fill, anchor="sw", font=("Arial", 10, "bold"), tags="box")
                bbox = self.canvas.bbox(t_id)
                
                # Add background padding
                if bbox:
                    # expand bbox slightly
                    bg_rect = (bbox[0]-2, bbox[1]-2, bbox[2]+2, bbox[3]+2)
                    r_id = self.canvas.create_rectangle(bg_rect, fill=hex_c, outline=hex_c, tags="box")
                    self.canvas.tag_lower(r_id, t_id) # put bg behind text
        
        # Note: We do NOT call update_sidebar_objects here to avoid drag-lag. 
        # Sidebar updates happen on Add/Delete/Load or specific selection events.

    def find_box_under_mouse(self, ix, iy):
        for i in range(len(self.bboxes)-1, -1, -1):
            # Check visibility before selecting
            if not self.bboxes[i].get('visible', True): continue
            
            b = self.bboxes[i]
            if b['x1']*self.imscale <= ix <= b['x2']*self.imscale and b['y1']*self.imscale <= iy <= b['y2']*self.imscale: return i
        return None

    def check_resize_handles(self, idx, ix, iy):
        # --- FIX: Validate bounds ---
        if idx is None or idx < 0 or idx >= len(self.bboxes):
            return None
            
        b = self.bboxes[idx]; s = self.imscale; r = 8
        coords = {'tl':(b['x1']*s,b['y1']*s), 'tr':(b['x2']*s,b['y1']*s), 'bl':(b['x1']*s,b['y2']*s), 'br':(b['x2']*s,b['y2']*s)}
        for k, v in coords.items():
            if abs(ix-v[0])<r and abs(iy-v[1])<r: return k
        return None

    def save_annotation(self):
        if not self.pil_image: return
        self.sync_classes_file()
        img_path = self.image_list[self.current_index]
        w, h = self.pil_image.size
        
        fmt = self.format_var.get()
        
        try:
            if fmt == "YOLO":
                self.save_yolo(img_path, w, h, self.bboxes)
            elif fmt == "Pascal VOC":
                self.save_voc(img_path, w, h, self.bboxes)
            elif fmt == "COCO":
                self.save_coco(img_path, w, h, self.bboxes)
                
            self.has_unsaved_changes = False
            self.annot_cache[img_path] = True # Mark current as annotated
            self.highlight_current_file()

            # We need to refresh the current listbox item text to show checkmark
            # but that's expensive to find. 
            # Easiest way is just calling refresh_file_list() but that might reset scroll.
            # Efficient update for current item only:
            try:
                listbox_idx = self.filtered_indices.index(self.current_index)
                prefix = "✔ "
                text = f"{prefix}{os.path.basename(img_path)}"
                self.file_listbox.delete(listbox_idx)
                self.file_listbox.insert(listbox_idx, text)
                self.file_listbox.selection_set(listbox_idx)
            except: pass

        except Exception as e: 
            print(f"Error saving: {e}")
            messagebox.showerror("Error", f"Could not save file: {e}")

    def save_yolo(self, img_path, w, h, boxes):
        tp = self.get_annotation_path(img_path)
        with open(tp, 'w') as f:
            for b in boxes:
                # Basic validation
                x1, y1 = max(0, min(b['x1'], w)), max(0, min(b['y1'], h))
                x2, y2 = max(0, min(b['x2'], w)), max(0, min(b['y2'], h))
                if x2 <= x1 or y2 <= y1: continue
                
                bw, bh = x2 - x1, y2 - y1
                cx, cy = x1 + bw/2, y1 + bh/2
                
                # Normalize
                n_cx, n_cy = min(cx/w, 1.0), min(cy/h, 1.0)
                n_w, n_h = min(bw/w, 1.0), min(bh/h, 1.0)
                
                f.write(f"{b['class_id']} {n_cx:.6f} {n_cy:.6f} {n_w:.6f} {n_h:.6f}\n")
        print(f"Saved YOLO: {tp}")

    def save_voc(self, img_path, w, h, boxes):
        # Pascal VOC XML
        root = ET.Element("annotation")
        ET.SubElement(root, "folder").text = os.path.basename(os.path.dirname(img_path))
        ET.SubElement(root, "filename").text = os.path.basename(img_path)
        ET.SubElement(root, "path").text = img_path
        
        source = ET.SubElement(root, "source")
        ET.SubElement(source, "database").text = "Unknown"
        
        size = ET.SubElement(root, "size")
        ET.SubElement(size, "width").text = str(w)
        ET.SubElement(size, "height").text = str(h)
        ET.SubElement(size, "depth").text = "3"
        
        ET.SubElement(root, "segmented").text = "0"
        
        for b in boxes:
            x1, y1 = max(0, min(b['x1'], w)), max(0, min(b['y1'], h))
            x2, y2 = max(0, min(b['x2'], w)), max(0, min(b['y2'], h))
            if x2 <= x1 or y2 <= y1: continue
            
            obj = ET.SubElement(root, "object")
            cid = b['class_id']
            cname = self.classes[cid] if cid < len(self.classes) else "unknown"
            
            ET.SubElement(obj, "name").text = cname
            ET.SubElement(obj, "pose").text = "Unspecified"
            ET.SubElement(obj, "truncated").text = "0"
            ET.SubElement(obj, "difficult").text = "0"
            
            bndbox = ET.SubElement(obj, "bndbox")
            ET.SubElement(bndbox, "xmin").text = str(int(x1))
            ET.SubElement(bndbox, "ymin").text = str(int(y1))
            ET.SubElement(bndbox, "xmax").text = str(int(x2))
            ET.SubElement(bndbox, "ymax").text = str(int(y2))
            
        annot_path = self.get_annotation_path(img_path)
        # Pretty print XML
        xmlstr = minidom.parseString(ET.tostring(root)).toprettyxml(indent="   ")
        with open(annot_path, "w") as f:
            f.write(xmlstr)
        print(f"Saved VOC: {annot_path}")

    def save_coco(self, img_path, w, h, boxes):
        # COCO JSON (Per-image standard structure)
        # Structure: { "images": [...], "annotations": [...], "categories": [...] }
        
        images = [{
            "id": 1, # Arbitrary ID for single-image mode
            "width": w,
            "height": h,
            "file_name": os.path.basename(img_path)
        }]
        
        categories = []
        for i, cls_name in enumerate(self.classes):
            categories.append({
                "id": i + 1, # 1-based index is standard for COCO
                "name": cls_name,
                "supercategory": "none"
            })
            
        annotations = []
        for i, b in enumerate(boxes):
            x1, y1 = max(0, min(b['x1'], w)), max(0, min(b['y1'], h))
            x2, y2 = max(0, min(b['x2'], w)), max(0, min(b['y2'], h))
            if x2 <= x1 or y2 <= y1: continue
            
            width = x2 - x1
            height = y2 - y1
            area = width * height
            
            # COCO bbox is [x_min, y_min, width, height]
            annotations.append({
                "id": i + 1,
                "image_id": 1,
                "category_id": b['class_id'] + 1, # Map to 1-based
                "segmentation": [], # BBox only
                "area": area,
                "bbox": [x1, y1, width, height],
                "iscrowd": 0
            })
            
        data = {
            "images": images,
            "annotations": annotations,
            "categories": categories
        }
            
        annot_path = self.get_annotation_path(img_path)
        with open(annot_path, "w") as f:
            json.dump(data, f, indent=4)
        print(f"Saved COCO: {annot_path}")

    def load_annotations(self, img_path):
        annot_path = self.get_annotation_path(img_path)
        w_img, h_img = self.pil_image.size
        
        if not os.path.exists(annot_path): 
            return None
        
        try:
            print(f"Loading annotations from: {annot_path}")
            ext = os.path.splitext(annot_path)[1].lower()
            
            if ext == ".txt":
                # Load YOLO
                with open(annot_path, 'r') as f:
                    for line in f:
                        p = line.split()
                        if len(p) >= 5:
                            cid = int(p[0])
                            ncx, ncy, nw, nh = map(float, p[1:5])
                            w, h = nw*w_img, nh*h_img
                            cx, cy = ncx*w_img, ncy*h_img
                            self.bboxes.append({"class_id": cid, "x1": cx-w/2, "y1": cy-h/2, "x2": cx+w/2, "y2": cy+h/2, "visible": True})
                            
            elif ext == ".xml":
                # Load VOC
                tree = ET.parse(annot_path)
                root = tree.getroot()
                for obj in root.findall("object"):
                    name = obj.find("name").text
                    bndbox = obj.find("bndbox")
                    xmin = float(bndbox.find("xmin").text)
                    ymin = float(bndbox.find("ymin").text)
                    xmax = float(bndbox.find("xmax").text)
                    ymax = float(bndbox.find("ymax").text)
                    
                    try: cid = self.classes.index(name)
                    except ValueError: 
                        self.classes.append(name)
                        cid = len(self.classes) - 1
                        
                    self.bboxes.append({"class_id": cid, "x1": xmin, "y1": ymin, "x2": xmax, "y2": ymax, "visible": True})
            
            elif ext == ".json":
                # Load COCO
                with open(annot_path, 'r') as f:
                    data = json.load(f)
                    # We need to map category IDs back to internal 0-based index
                    # Create a map first
                    cat_map = {c['id']: c['name'] for c in data.get("categories", [])}
                    
                    for ann in data.get("annotations", []):
                        cat_id = ann['category_id']
                        name = cat_map.get(cat_id, "unknown")
                        
                        # Sync with class list
                        if name not in self.classes:
                            self.classes.append(name)
                        cid = self.classes.index(name)
                        
                        # bbox is [x, y, w, h]
                        x, y, w, h = ann['bbox']
                        self.bboxes.append({"class_id": cid, "x1": x, "y1": y, "x2": x+w, "y2": y+h, "visible": True})
            
            return annot_path

        except Exception as e:
            print(f"Error loading {annot_path}: {e}")
            return None

    def delete_current_image(self):
        if not self.image_list: return
        p = self.image_list[self.current_index]
        if not messagebox.askyesno("Delete", f"Delete {os.path.basename(p)}?"): return
        self.canvas.delete("all"); self.pil_image.close(); self.pil_image = None
        os.remove(p)
        tp = self.get_txt_path(p)
        if os.path.exists(tp): os.remove(tp)
        self.image_list.pop(self.current_index)
        
        # Clear cache for deleted file
        if p in self.annot_cache:
             del self.annot_cache[p]

        self.refresh_file_list()
        if self.image_list:
            if self.current_index >= len(self.image_list): self.current_index = len(self.image_list)-1
            self.load_image_data()
        else: self.title("No Images")

def main():
    app = UltimateAnnotator()
    app.mainloop()

if __name__ == "__main__":
    main()