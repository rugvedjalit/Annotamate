# Annotator guide

This guide is for everyone who works in Annotamate projects: drawing boxes, reviewing, and talking
to the rest of the team. It applies to annotators, reviewers and managers alike; viewers can read
it for the parts about looking around and commenting.

**Contents**

1. [Getting started](#1-getting-started)
2. [The workspace](#2-the-workspace)
3. [Tools and the view](#3-tools-and-the-view)
4. [Drawing and editing boxes](#4-drawing-and-editing-boxes)
5. [Classes and the class picker](#5-classes-and-the-class-picker)
6. [Moving between images](#6-moving-between-images)
7. [Saving, conflicts and locks](#7-saving-conflicts-and-locks)
8. [Submitting and reviews](#8-submitting-and-reviews)
9. [Comments and pins](#9-comments-and-pins)
10. [Chat, direct messages, mentions and notifications](#10-chat-direct-messages-mentions-and-notifications)
11. [Keyboard shortcuts](#11-keyboard-shortcuts)
12. [Preferences](#12-preferences)
13. [Tips for video frames](#13-tips-for-video-frames)
14. [Things that may surprise you](#14-things-that-may-surprise-you)

In this guide **Mod** means `Ctrl` on Windows and Linux and `⌘` on macOS.

---

## 1. Getting started

Open the address your administrator gave you and sign in with your user name and password. You can
change your display name, email and avatar colour (**Profile**) and your password (**Password**) under **Account** in the user menu.

The **projects page** shows a card for every project you are a member of: a progress bar by status,
the number of images assigned to you that are not yet done, unread chat messages, the members and
the label format. Click a card to open the project; the card also has buttons for the project chat
and for the annotator.

The **project overview** shows statistics, progress per member, the class histogram, open
comment threads, recent activity and who is online. **Continue annotating** (viewers see **Open
viewer**) opens the annotator on the first image assigned to you that is *To do*, *In progress* or
*Rejected*; if there is none, on the first *To do* image, and otherwise on the first image.
Reviewers and managers also have a **Review queue** button that opens the annotator on the images
in review.

Your **role** in a project decides what you can do:

| Role | Can |
| --- | --- |
| Viewer | look at everything, chat and comment |
| Annotator | also edit annotations, flag images, resolve comments, submit images, claim unassigned images |
| Reviewer | also approve and reject submitted images |
| Manager | also manage classes, members, assignments, uploads and exports |

## 2. The workspace

The annotator is built around the canvas; everything else can be resized or hidden. Press `\` to
hide and show the side panels.

**Top bar.** The project switcher with the label format, then the image navigator: previous, the
file name with "n / total" for the current filter, next. Click the file name to type a number or a
name and jump there. On the right are the save-state pill, the avatars of the other people in the
project, the chat button with its unread badge, the direct messages button, the notifications bell,
the command palette search box and the user menu.

**Files panel (left).** All images of the project in natural order (`frame2` before `frame10`),
with a search box, a sort menu (*Name (natural)* or *Recently updated*) and filter chips: *All,
Mine, To do, In progress, In review, Rejected, Done*, a flag chip (*Flagged*) and a comment chip
(*Has open comments*). The status chips show how many images are in each status. Each row shows a
status icon, the name, a flag icon, the number of open comments, the avatars of people who have
that image open right now (or the assignee), and the number of boxes. The footer shows how many
images are done. The panel stays fast in projects with 100,000 or more images.

**Tool rail.** Select, Draw box, Pan, Zoom to fit, the label and crosshair toggles, the
comment-pin toggle, undo and redo.

**Canvas.** The image with its boxes. A small toolbar floats next to the selected box (class,
duplicate, lock, delete); a zoom control sits at the bottom centre (−, %, +, Fit, 1:1).

**Inspector (right).** Four tabs:

- **Labels**: the class list with colours, hotkeys and counts for this image; the list of objects
  on this image; and the properties of the selected box.
- **Comments**: the discussion thread of this image.
- **History**: earlier saved versions of this image.
- **Info**: path, size, label file, position, status, assignee, flag and the activity for this image.

**Review bar.** Appears at the bottom of the canvas for editors and reviewers, with the status and
the actions that apply: *Submit for review* (or *Mark done* in projects without review),
*Approve*, *Reject…* or *Reopen*.

**Status bar.** The cursor position in image pixels, the image size, the number of objects, the
label file path, the autosave state, who else is on this image and a *Shortcuts* button.

**Command palette.** `Mod+K` opens a searchable list of actions and places to go. `?` shows the
shortcut sheet.

## 3. Tools and the view

| Tool | Key | Use |
| --- | --- | --- |
| Select | `V` | select, move and resize boxes |
| Box | `W` | draw new boxes |
| Pan | `H`, or hold `Space` with any tool | drag the image around |

Zooming and panning:

- The **mouse wheel zooms** at the cursor. If you prefer the wheel to scroll, set *Mouse wheel* to
  *Scroll* in the preferences; the wheel then pans, and `Ctrl`/`⌘` + wheel or a trackpad pinch
  zooms. `Shift` + wheel pans sideways in both modes.
- Drag with the **middle mouse button**, or hold `Space` and drag, to pan with any tool.
- `F` fits the image to the canvas; `0` shows it at 100 %.
- Above 150 % zoom, pixels are drawn sharp-edged, so you can place box edges exactly.

Display toggles:

- `L` shows or hides the label chips on the boxes.
- `C` shows or hides the crosshair that follows the cursor across the whole canvas, which helps to
  line up box edges with the outline of an object.
- The pin toggle in the tool rail shows or hides comment pins.

## 4. Drawing and editing boxes

### Drawing

Press `W` and drag from one corner of the object to the opposite corner. Hold `Shift` for a square,
`Alt` to draw from the centre. `Escape` cancels a box you are still dragging.

Boxes can be as small as one image pixel, and cannot extend beyond the image: they are clipped to
its edge while you draw.

After you release the mouse, the [class picker](#5-classes-and-the-class-picker) asks for the class
(unless you turned that off). By default the Box tool stays active so you can draw the next box at
once; you can change that in the preferences.

With the Box tool, a plain click on an existing box selects it instead of drawing.

### Selecting

Press `V`.

- Click a box to select it. When boxes overlap, the **smallest** box under the cursor wins, so a
  box inside another one can always be reached.
- `Shift`-click or `Mod`-click adds or removes boxes from the selection.
- Drag on an empty area to select every box the rectangle touches (`Shift` or `Mod` adds to the
  selection).
- `Tab` steps through the boxes one by one (while the focus is on the canvas, not in a panel);
  `Mod+A` selects all; `Escape` clears the selection.
- Clicking a row in the Objects list selects that box (`Shift`/`Mod`-click for several);
  hovering highlights it on the canvas, and double-clicking a row scrolls it into view.

### Moving and resizing

- Drag a selected box to move it; with several selected, they move together.
- Drag one of the eight handles (corners and edges) to resize.
- The **arrow keys** nudge the selection by 1 pixel, `Shift` + arrow by 10 pixels.
- In the **Properties** section of the Labels tab you can type exact X, Y, W and H values in pixels
  for a single selected box.

Boxes always stay inside the image. A moved box stops at the edge instead of being cut off.

### Other operations

| Operation | How |
| --- | --- |
| Delete | `Delete` or `Backspace`, the floating toolbar, or the Objects list; locked boxes are kept |
| Duplicate | `Mod+D`; the copy is offset by 10 pixels |
| Copy and paste | `Mod+C`, `Mod+V`; works across images |
| Paste the previous image's boxes | `Mod+Shift+V` |
| Change class | `1`–`9`, `Q` / `E`, `X`, the floating toolbar or the Properties section |
| Hide or show a box | the eye icon in the Objects list (the list header has *Hide all boxes*) |
| Lock a box | the lock icon in the Objects list or the floating toolbar; a locked box can be selected but not moved, resized, nudged or deleted |

For Pascal VOC projects the Properties section also has the *Difficult* and *Truncated* checkboxes.

### Undo and redo

`Mod+Z` undoes, `Mod+Y` or `Mod+Shift+Z` redoes. Everything can be undone: drawing, moving,
resizing, nudging, class changes, deleting, duplicating, pasting, hiding, locking and edits in the
Properties section. Each image has its own history of up to 200 steps, and it is still there when
you come back to an image you visited recently (the last 20 images). The history lives in your
browser tab and is gone after a reload; for older states use the
[revision history](#revision-history).

## 5. Classes and the class picker

### The active class

The **Classes** list at the top of the Labels tab shows every class with its colour, how often it
occurs on the current image and, for the first nine, its number key. One class is the *active*
class; click a class to make it active.

- `1` … `9` choose one of the first nine classes. With boxes selected, the same keys also change
  the class of those boxes.
- `Q` and `E` move to the previous and next class, and likewise change the class of selected
  boxes.
- The filter field above the list narrows it down. If you are allowed to add classes, typing a new
  name and pressing `Enter` creates the class.

### The class picker

After you draw a box, a small picker opens right next to it:

- Start typing to filter the list; names that start with your text come first.
- `Up` / `Down` move the highlight, `Enter` assigns the highlighted class.
- `1` … `9` pick directly.
- `Escape` (or a click elsewhere) discards the box you just drew.
- If you are allowed to add classes, *Create class "…"* adds what you typed as a new class.

Press `X` with boxes selected to open the picker for them (*Change class*); there `Escape` only
closes it.

**Skipping the picker.** If you label many objects of the same class in a row, turn off *Ask for
class after drawing* (the switch at the bottom of the Classes section, also in the preferences).
New boxes then get the active class immediately, and you switch classes with `1`–`9` or `Q` / `E`.

### Unknown classes

A grey, dashed box whose chip shows a raw label uses a class that is not in the project's class
list, typically because the label file was made elsewhere. The Classes section lists them under
*Unknown labels on this image*. Nothing is lost: saving the image keeps such boxes as they are.
Assign a class to turn one into a regular box, use *Map to class…* to convert all boxes with that
label at once, or *Add class* (if you may add classes) to create a class with that name.

## 6. Moving between images

- `D` or `→` goes to the next image, `A` or `←` to the previous one. (While boxes are selected, the
  arrow keys nudge them instead; `A` and `D` always navigate.)
- Click a row in the files panel, or click the file name in the top bar and type a position or a
  name.
- Navigation follows the **current filter** and sort order of the files panel. With *Mine* and
  *To do* active, "next" means your next open image.
- The address in the browser identifies the project and the image, so you can paste it into chat
  to show someone exactly what you are looking at. Back and forward work as usual.

Before moving on, Annotamate finishes saving the current image. If that save fails, you stay where
you are and a message offers to retry, so work is never left behind unsaved. Submitting or
approving an image also moves on to the next image in the current filter.

## 7. Saving, conflicts and locks

### Autosave

Changes are saved automatically a moment after you stop editing (0.8 seconds by default; the
*Autosave delay* preference allows 0.2 to 10 seconds). The save-state pill in the top bar always
tells you where you stand:

| State | Meaning |
| --- | --- |
| Saved | everything is on the server |
| Unsaved | there are changes that have not been sent yet |
| Saving… | the save is in progress |
| Save failed · Retry | the save failed; your changes are still in the browser, and clicking the pill retries |
| Conflict | the label file changed on the server since you loaded it |
| Unsaved (read-only) | there are changes that cannot be saved right now (for example after a take-over); they stay in the tab |
| Read-only | you cannot edit this image |

After a failed autosave Annotamate retries up to three times by itself (after 2, 5 and 15
seconds). `Mod+S` saves immediately. If you turn autosave off in the preferences, `Mod+S` is how you save.
The browser warns you before closing the tab only when something is still unsaved.

Labels are written directly to the label file of the image on the server, in the project's format.

### Conflicts

If the label file was changed by someone or something else after you opened the image (a script, a
restored revision, a save through another route), your save is not applied blindly. A dialog titled
"Someone else saved this image" offers:

- **Load theirs**: discard your changes and show the current version (undo brings your changes
  back).
- **Keep mine**: overwrite the current version with yours; the other version stays in the
  [revision history](#revision-history). Reviewers and managers, and whoever holds the edit lock,
  can do this.
- **Copy mine**: copy your boxes to the clipboard so you can paste them after loading theirs.

### Edit locks and presence

Only one person edits an image at a time.

- When you open an image and are allowed to edit it, you receive its **edit lock**. This takes a
  fraction of a second, during which the editor is read-only ("Requesting the edit lock…").
- If someone else holds the lock, a banner says so, for example "Alice is editing this image. You
  can view and comment." You see their saved changes as they arrive, and the lock passes on when
  they leave the image.
- The lock is released when you move to another image or close the tab. If your computer goes to
  sleep or loses its connection, the lock expires after about a minute.
- Managers and administrators can **take over** a lock with the *Take over* button in the banner.
  If that happens to you, the editor becomes read-only and a message tells you who took over.
  Changes you had not saved yet stay in your browser; *Copy my boxes* in the banner copies them.
- If the live connection is down for a few seconds, the status bar shows *Live lock unavailable*
  and you can keep editing; the server still refuses a save when someone else holds the lock.
- Opening the same image in a second tab or browser takes the lock over from your first one.

Avatars show where everybody is: in the top bar for the project, on the rows of the files panel for
each image, and in the status bar for the image you are on.

### Read-only images

An image opens read-only, with an explanation, when:

- you are a viewer, or the project restricts editing to assigned images and this one is assigned to
  someone else;
- someone else holds the edit lock;
- you are on a small screen or a touch device (narrower than 1024 px, or without a mouse), which is
  view-only;
- the image itself cannot be decoded;
- the label file contains data Annotamate does not edit, such as segmentation polygons or oriented
  boxes in a YOLO file, or cannot be parsed. The file is protected so that saving can never destroy
  information.

### Revision history

Every save is recorded. The **History** tab lists the last 50 versions of the image with author,
time and number of boxes, marked *Current* or *Latest*. Use **Preview** to look at a version on the
canvas (**Exit preview** or `Escape` leaves it) and **Restore** to make it the current version;
restoring needs edit access and no unsaved changes. Restoring is itself a save, so it can be
reverted in the same way.

## 8. Submitting and reviews

Each image has a status: **To do**, **In progress**, **In review**, **Done** or **Rejected**. The
first save moves an image from *To do* (or *Rejected*) to *In progress*.

**Submitting.** When an image is finished, press `Mod+Enter` or click the submit button in the
review bar. It reads *Submit for review* when the project requires review and *Mark done*
otherwise, and the image becomes *In review* or *Done* accordingly. You can submit images that are
*To do*, *In progress* or *Rejected*. Afterwards the annotator moves on to the next image.

**Images without objects.** If there is nothing to label, submit the image with no boxes. Its status
changes like any other, so it is not mistaken for an image nobody has looked at.

**If your image is rejected**, you get a notification. The image returns with the status *Rejected*
and the reviewer's reason as a comment; the reviewer may also have left pinned comments on the
spots in question. Fix it, resolve the comments and submit again. The *Rejected* filter chip lists
everything waiting for you.

**Reopening.** To change an image that is already *Done* or *In review*, use *Reopen*. It goes back
to *In progress*. Reviewers and managers can reopen any image; an annotator can reopen images
assigned to them or that they submitted.

**For reviewers.** Filter the files panel by *In review* (or use *Review queue* on the project
overview) and step through the images. In the review bar, *Approve* marks an image as done and
moves to the next one; *Reject…* opens a dialog that asks for a reason, which is required, and
adds it to the image's comments. Place pinned comments for specific problems before rejecting, so
the annotator sees exactly what to change. You can also fix small things yourself and approve.

**Flags.** `G` flags or unflags the current image (not available to viewers; the Info tab has a
*Flag for attention* button too). A flag means "someone should look at this": a doubtful case, a
damaged image, a question about the guidelines. Flags are independent of the status; the flag chip
(*Flagged*) in the files panel lists them.

**Assignments.** Images assigned to you appear under the *Mine* filter. In the **Info** tab you can
*Claim this image* when it is unassigned, or *Release* one that is assigned to you; managers pick
the assignee from a list instead. In projects that restrict editing to assigned images, your first
save on an unassigned image claims it for you.

## 9. Comments and pins

Every image has its own comment thread, in the **Comments** tab of the inspector. Use it for
anything about that particular image: questions, review remarks, edge cases worth remembering.

- **Add a comment** by typing in the box at the bottom of the tab and clicking *Comment*. The
  *All* / *Open* switch at the top limits the list to unresolved comments.
- **Pin it** to a spot: click *Add pin*, then click the place on the image. The pin appears as a
  numbered marker on the canvas for everybody. Toggle the markers with the pin button in the tool
  rail.
- **Resolve** a comment when it is dealt with (annotators, reviewers and managers can); resolved
  comments stay in the thread and can be reopened with *Reopen*.
- You can edit and delete your own comments; managers can delete any comment.
- `@username` mentions someone and notifies them.

Images with unresolved comments show their number in the files panel, and the comment chip
(*Has open comments*) lists them. Everyone in the project can comment, including viewers and
including while someone else is editing the image.

## 10. Chat, direct messages, mentions and notifications

### Project chat

Each project has one chat channel. Open it with the chat button in the top bar or `Mod+/`; it
slides in from the right on every page of the project, so you can keep it open while annotating.

- Messages arrive live; the badge counts what you have not read.
- You can edit and delete your own messages; managers can delete any message.
- **Share an image**: click *Share current image* in the message box to attach a link to the image
  you are looking at, and others can open it with one click.
- Use the chat for things that concern the project as a whole (guidelines, class definitions,
  announcements) and image comments for things about one image.

### Direct messages

The **Direct messages** button in the top bar (`/messages`) holds private conversations between two
people. Use *New message* to pick any active user. Unread counts are shown per conversation.

### Mentions

Type `@` followed by a user name in chat, in a comment or in a direct message; a suggestion list
completes the name. The mentioned person gets a notification that leads to the message. In a
project, only members can be mentioned.

### Notifications

The bell in the top bar shows a badge with the number of unread notifications. You are notified when:

- someone mentions you;
- images are assigned to you;
- an image you submitted or that is assigned to you is approved or rejected;
- as a reviewer or manager, when someone submits an image for review;
- someone comments on an image that is assigned to you or that you commented on;
- you receive a direct message;
- you are added to a project.

Click a notification to go to the image or conversation, which also marks it as read; *Mark all
read* clears the badge. The bell menu links to a full list of notifications. A notification sound
can be turned on in the preferences.

## 11. Keyboard shortcuts

These are the defaults. Every shortcut can be changed under **Account → Keyboard shortcuts** (click
*+* next to an action and press the keys; *Reset all* restores the defaults); your bindings are
stored with your account and follow you to any browser. `?` shows the current list inside the app.

**Tools and view**

| Action | Shortcut |
| --- | --- |
| Select tool | `V` |
| Box tool | `W` |
| Pan tool | `H` (or hold `Space`) |
| Fit image to canvas | `F` |
| Actual size (100 %) | `0` |
| Show or hide labels | `L` |
| Show or hide the crosshair | `C` |
| Show or hide the side panels | `\` |

**Classes**

| Action | Shortcut |
| --- | --- |
| Open the class picker for the selection | `X` |
| Previous class | `Q` |
| Next class | `E` |
| Class 1 … 9 | `1` … `9` |

**Boxes and selection**

| Action | Shortcut |
| --- | --- |
| Delete selected boxes | `Delete`, `Backspace` |
| Duplicate | `Mod+D` |
| Copy | `Mod+C` |
| Paste | `Mod+V` |
| Paste the previous image's boxes | `Mod+Shift+V` |
| Select all | `Mod+A` |
| Select none | `Escape` |
| Select the next box | `Tab` |
| Nudge by 1 px / 10 px | arrow keys / `Shift` + arrow keys |
| Undo | `Mod+Z` |
| Redo | `Mod+Y`, `Mod+Shift+Z` |

**Images**

| Action | Shortcut |
| --- | --- |
| Previous image | `A`, `←` |
| Next image | `D`, `→` |
| Submit | `Mod+Enter` |
| Flag or unflag | `G` |
| Save now | `Mod+S` |

**Application**

| Action | Shortcut |
| --- | --- |
| Command palette | `Mod+K` |
| Open or close the chat | `Mod+/` |
| Shortcut help | `?` |

**While drawing or in the class picker**

| Action | Key |
| --- | --- |
| Square box | hold `Shift` while dragging |
| Draw from the centre | hold `Alt` while dragging |
| Cancel the current drag | `Escape` |
| Assign the highlighted class | `Enter` |
| Move the highlight | `↑`, `↓` |
| Discard the new box | `Escape` |

Notes:

- Shortcuts do not fire while you type in a text field, except `Escape` and the command palette.
- With boxes selected, the arrow keys nudge; with nothing selected, `←` and `→` change the image.
- Some combinations belong to the browser and cannot be assigned, for example `Mod+W`, `Mod+T`,
  `Mod+N` and `Mod+Tab`. The shortcut editor warns about these and about conflicts between your
  own bindings.

## 12. Preferences

Under **Account → Preferences** (also in the user menu), each user can set:

| Preference | Default | Meaning |
| --- | --- | --- |
| Theme | Dark | Dark, Light, or System (follow the operating system); also in the user menu |
| Autosave | on | save automatically; when off, use `Mod+S` |
| Autosave delay | 800 ms | wait after the last change before saving (200 ms to 10 s) |
| Ask for class after drawing | on | open the class picker for every new box |
| Tool after drawing | Box tool | stay in the Box tool, or switch to the Select tool after each box |
| Mouse wheel | Zoom | the wheel zooms; with Scroll the wheel pans and `Ctrl`/`⌘` + wheel or a pinch zooms |
| Fill opacity | 16 % | how strongly boxes are tinted (0 to 60 %) |
| Stroke width | 2 px | thickness of box outlines (1 to 6 px) |
| Show labels / Show crosshair | on / on | the starting state of the two toggles |
| Play a sound | off | a short chime for new direct messages and notifications |

Your own keyboard shortcuts are edited under **Account → Keyboard shortcuts**. Preferences and
panel sizes are stored with your account.

## 13. Tips for video frames

Consecutive frames of a video show almost the same scene, and the objects move only a little.
Annotamate has a shortcut for exactly this: **`Mod+Shift+V` pastes the boxes of the previous
image** (the one you were on before this one) into the current one, with their classes.

A fast routine for a sequence:

1. Annotate the first frame completely.
2. Press `D` for the next frame, then `Mod+Shift+V`.
3. Adjust: `Tab` to step from box to box, arrow keys to nudge (`Shift` for 10 px), handles to
   resize, `Delete` for objects that left the picture, `W` for new ones.
4. `Mod+Enter` to submit, which moves on to the next frame; then `Mod+Shift+V`, and so on.

More that helps with sequences:

- Frames are listed in **natural order**: `frame_9` comes before `frame_10`, with no need for
  zero-padded names.
- Turn off *Ask for class after drawing* when most new objects have the same class.
- `Mod+C` / `Mod+V` copy selected boxes to any other image, for example to carry one object across
  a gap of several frames.
- If the pasted boxes need no change, there is nothing else to do: the paste is saved like any
  other edit.
- Used the shortcut on the wrong frame? `Mod+Z` removes the pasted boxes in one step.
- Lock boxes of static objects (a parked car, a traffic sign) after placing them so you do not
  drag them by accident while adjusting the moving ones.
- Managers can distribute a sequence in contiguous runs, so each annotator works on consecutive
  frames (see the [administrator guide](administrator.md#7-assignments)).

## 14. Things that may surprise you

**I cannot edit.** Look for the banner or the read-only notice: someone else is editing, the image
is assigned to another person, your role is viewer, or the label file is protected. See
[read-only images](#read-only-images).

**The arrow keys move a box instead of changing the image.** A box is selected. Press `Escape`
first, or use `A` and `D`.

**A shortcut does nothing.** The cursor is probably in a text field; click the canvas or press
`Escape`. If you changed your bindings, check **Account → Keyboard shortcuts**.

**"Next" skips images.** Navigation follows the filter of the files panel. Choose *All* to step
through every image.

**The picture looks rotated compared with my file viewer.** The project decides how the orientation
tag of photos is treated, and applies it consistently to image and boxes. Ask your manager if it
looks wrong for the whole project.

**The connection dropped.** The app reconnects by itself and reloads what changed in the meantime.
If a save fails while the connection is down, the save-state pill shows *Save failed · Retry*; your
edits stay in the tab and are saved once a retry succeeds. Do not close the tab while it says
*Unsaved* or *Save failed*.
