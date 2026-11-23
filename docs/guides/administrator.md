# Administrator guide

This guide is for the people who run an Annotamate server and its projects: **administrators**, who
manage accounts and create projects, and **project managers**, who run a project day to day.
Installing the server is covered in the [deployment guide](deployment.md); daily annotation work in
the [annotator guide](annotator.md).

**Contents**

1. [The first administrator](#1-the-first-administrator)
2. [User accounts](#2-user-accounts)
3. [Roles and permissions](#3-roles-and-permissions)
4. [Creating a project](#4-creating-a-project)
5. [Classes](#5-classes)
6. [Members](#6-members)
7. [Assignments](#7-assignments)
8. [Review workflow](#8-review-workflow)
9. [Uploading images](#9-uploading-images)
10. [Rescanning](#10-rescanning)
11. [Exports](#11-exports)
12. [Archiving and deleting projects](#12-archiving-and-deleting-projects)
13. [Following a project](#13-following-a-project)

---

## 1. The first administrator

A new server has no accounts. The first person to open it in a browser sees the **Create the
administrator account** screen and enters a name, a user name and a password (twice). This screen
exists only while there are no users at all; once the first account is created the server refuses
any further setup request. Two requests that arrive at the same moment cannot both create an
administrator.

When the server starts without any account it generates a one-time **setup token** and prints it in its
console and log (`annotamate serve` prints it below the address; with Docker use
`docker compose logs annotamate`, with systemd `journalctl -u annotamate`). Opening the page on the
server machine itself (or through an SSH tunnel) needs no token; from any other machine, and through any
reverse proxy or tunnel service that adds forwarding headers, the screen shows a *Setup token* field and the account is only created when the token matches. This stops a stranger who
finds a freshly started server from becoming its administrator.

Because the first visitor becomes the administrator, create the account immediately after starting
a server that other people can reach. You can also create it before anyone opens the site:

```bash
annotamate user create admin --admin
```

The command asks for the password (at least 8 characters) and asks for it a second time to
confirm. On a systemd or Docker installation, run it as described in the
deployment guide ([systemd](deployment.md#6-systemd-service), [Docker](deployment.md#4-docker)).

## 2. User accounts

Accounts are managed by administrators under **Administration → Users** in the account menu
(`/admin/users`), or on the command line.

### In the browser

- **Create user** takes a name, a user name, an optional e-mail address, a password (with a
  **Generate** button and a copy button) and the **Administrator** switch. Give the password to the
  person through a channel you trust; they can change it under **Account → Password**.
- The actions menu of each row offers **Edit details** (name, e-mail address and administrator
  switch), **Reset password**, **Send a message**, **Make administrator** or **Remove
  administrator**, and **Deactivate** or **Reactivate**. User names cannot be changed.
- **Reset password** signs the user out on every device.
- **Deactivate** an account when someone leaves. Deactivated users cannot sign in and their sessions
  end immediately. Their past work, messages and comments stay. Reactivate the account to give
  access back; the old password works again. Turn on **Show deactivated** to see these accounts.
  You cannot deactivate yourself or remove your own administrator rights, so the server cannot be
  left without an administrator by accident.
- **Remove administrator** keeps the person's project roles but ends their access to user
  management and project creation.

### On the command line

```bash
annotamate user create alice                       # prompts for the password
annotamate user create bob --display-name "Bob K." --admin
annotamate user passwd alice                       # prompts for a new password
annotamate user list
```

- `user create NAME` accepts `--admin`, `--display-name` (default: the user name), `--password` and
  `--data-dir`. Without `--password` it prompts for the password and asks for it twice. A password
  given on the command line can end up in the shell history, so the prompt is the safer choice.
- `user passwd NAME` prompts for the new password and signs the user out everywhere.
- `user list` prints each user name and display name, marked `admin` or `inactive` where it applies.

The commands work on the database in the data folder (`ANNOTAMATE_DATA_DIR` or `--data-dir`), so run
them against the same data folder as the server. The command line is also the way back in when the
only administrator has forgotten the password.

### Rules

- **User names** are 3 to 32 characters from `a–z`, `0–9`, `_`, `.` and `-`. They are stored in
  lower case and must be unique. The user name is what people type in `@mentions`.
- **Passwords** have at least 8 characters. They are stored as argon2id hashes; nobody, including
  administrators, can read a password.
- **Sign-in protection.** After 10 failed attempts for one user name from one address within
  10 minutes, further sign-ins are refused until the oldest of those failures is 10 minutes old.
  A successful sign-in clears the count. The counters are kept in memory and start again when the
  server restarts.
- **Sessions** last 14 days from the last activity by default (`ANNOTAMATE_SESSION_DAYS`). When
  users change their own password, their other sessions are signed out; when an administrator resets
  a password, all of that user's sessions are signed out.

## 3. Roles and permissions

There are two levels.

**Administrator** is a property of the account. Administrators manage users, create and delete
projects, and can open every project with manager rights, whether or not they are a member.

**Project roles** are given per project. A user can be a manager in one project and a viewer in
another, and sees only the projects they are a member of.

| Capability | Viewer | Annotator | Reviewer | Manager | Administrator |
| --- | :-: | :-: | :-: | :-: | :-: |
| See images, labels, statistics, activity and members | ✓ | ✓ | ✓ | ✓ | ✓ |
| Project chat, image comments, @mentions | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit annotations; submit for review or mark done | | ✓ | ✓ | ✓ | ✓ |
| Claim an unassigned image | | ✓ | ✓ | ✓ | ✓ |
| Approve or reject submitted images | | | ✓ | ✓ | ✓ |
| Add classes | | if allowed ¹ | ✓ | ✓ | ✓ |
| Rename, recolour or delete classes | | | | ✓ | ✓ |
| Assign images to others; bulk actions | | | | ✓ | ✓ |
| Members, project settings (including archiving), rescan, upload, export | | | | ✓ | ✓ |
| Create or delete projects; manage users | | | | | ✓ |

¹ Controlled by the project setting **Annotators can add classes** (on by default).

Choosing roles:

- **Viewer** for stakeholders who look at progress and join discussions without changing labels.
- **Annotator** for people who draw boxes.
- **Reviewer** for people who also check the work of others.
- **Manager** for whoever organises the project: classes, members, assignments, exports.

Three project settings (under **Settings → Workflow**, card *Review and permissions*) change what
annotators may do. Changes apply immediately for everyone in the project.

| Setting | Default | Effect |
| --- | --- | --- |
| Require review | off | Submitted images go to *In review* and need a reviewer's approval, instead of going straight to *Done*. |
| Only edit assigned images | off | Annotators can edit only images assigned to them, plus unassigned images, which become theirs on the first save. |
| Annotators can add classes | on | When off, only reviewers and managers can add classes. |

The same tab has an *Images* card with **EXIF orientation** and **Include sub-folders** (see
[section 4](#4-creating-a-project)).

## 4. Creating a project

A project connects an image folder on the server with a label format, a class list and a team.
Only administrators create projects: **New project** on the projects page opens a wizard with four
steps: **Image folder**, **Labels**, **Details** and **Members**.

### Image folder (step 1)

The folder browser shows the **dataset roots** configured for the server (`--root` /
`ANNOTAMATE_ROOTS`) and the folders below them, with the number of images in each. Projects can
only be created inside a root. If the folder you need is missing, it lies outside the roots; ask
whoever operates the server to add it (see the
[deployment guide](deployment.md#10-configuration-reference)).

The images must already be on the server, or you can start with an empty folder and
[upload](#9-uploading-images) them. Annotamate recognises `.jpg`, `.jpeg`, `.png`, `.bmp`, `.webp`,
`.tif` and `.tiff` files; hidden files and folders (names starting with a dot) are ignored.

### Label folder (step 2)

- **Next to the images** (the default): `photo_001.jpg` gets `photo_001.txt` (YOLO), `.xml` (Pascal
  VOC) or `.json` (COCO) beside it.
- **A separate folder**: common for YOLO datasets with `images/` and `labels/` side by side. Choose
  it with the folder browser (**Use for labels**). It must also lie inside a dataset root and is
  created if it does not exist. Existing label files are not moved if the folder is changed later.

`classes.txt` lives in the label folder (or the image folder when there is no separate one) and is
kept in sync for every format. With sub-folders enabled, the label folder mirrors the sub-folder
structure of the images. The label folder is shown, read-only, under **Settings → General**.

### Label format (step 2)

| Format | Files | Notes |
| --- | --- | --- |
| YOLO | one `.txt` per image, `classes.txt` | `class cx cy w h`, normalised to the image size, 6 decimals. The class number is the position of the class in `classes.txt`. |
| Pascal VOC | one `.xml` per image | Pixel coordinates, class names, `difficult` and `truncated` flags. |
| COCO | one `.json` per image | Compatible with the files written by the Annotamate desktop app. A dataset-level `annotations.json` is produced by [export](#11-exports). |

The format is chosen once, when the project is created. Existing label files in that format are
used as they are, so a folder annotated with another tool or with Annotamate 1.x can be opened
directly.

Annotamate edits bounding boxes only. A label file that holds anything it could not write back
without losing information is opened read-only (the annotator shows the reason) and saving never
modifies it:

- YOLO: lines with more than five values (segmentation polygons, oriented boxes) or lines that
  cannot be parsed.
- Pascal VOC: objects with a `polygon` or `segmentation` element or without a usable `bndbox`; files
  that are not valid XML.
- COCO: annotations with a non-empty `segmentation`, files that describe several images, or files
  that are not valid JSON.

Class renames and deletions (see [section 5](#5-classes)) still rewrite such files, changing only
the class values.

### Classes (step 3, Details)

Type the class names, or leave the list empty to take over what is already there: an existing
`classes.txt` is read, and for VOC and COCO the class names found in the label files are collected.
This happens once, when the project is created; a rescan never adds classes. Names you type are
written to `classes.txt` in the label folder. The same step takes the project name (required, up to
100 characters) and an optional description.

### EXIF orientation (step 3, Details)

Photos from phones and cameras often store the pixels in one orientation and a tag that says "show
this rotated". Tools disagree on whether to honour the tag, and boxes drawn in one orientation are
wrong in the other.

- **Apply** (default): the image is shown, measured and annotated as rotated by the tag. This
  matches OpenCV and Ultralytics, so it is the right choice for most training pipelines.
- **Ignore**: the stored pixels are used as they are. Choose this if your training code ignores
  EXIF orientation, or if the folder was annotated with a tool that ignores it, such as Annotamate 1.x.

Decide before annotation starts. The setting can be changed later under **Settings → Workflow**,
but this does not transform or rewrite existing boxes or label files; boxes keep their stored
coordinates and may no longer line up with the image.

### Sub-folders (step 1, Include sub-folders)

Off by default: only images directly in the folder belong to the project. When on, images in all
sub-folders are included and shown with their relative path. Changing the setting later under
**Settings → Workflow** starts a re-index of the folder (see [section 10](#10-rescanning)); images
that fall out of scope are removed from the project together with their status, comments and
history.

### Members (step 4)

You are added as a manager automatically. Tick the people to add and choose a role for each
(annotator by default); members and roles can be changed later ([section 6](#6-members)). The
workflow settings (**Require review**, **Only edit assigned images**, **Annotators can add
classes**) and **EXIF orientation** are offered in step 3.

### After creation

The server indexes the folder in the background; a progress indicator is shown on the project until
it is finished. Large folders take a moment. Images that already have a label file start as
**Done**, all others as **To do**.

## 5. Classes

Classes are managed under **Settings → Classes**. Each class has a name (unique, up to 100
characters), a colour and a position (shown as `#0`, `#1`, ...). The position matters in YOLO
projects, where it is the number written into the label files and the line in `classes.txt`.

| Action | Who | What happens on disk |
| --- | --- | --- |
| Add a class | managers and reviewers; annotators if allowed | Appended at the end; `classes.txt` is updated. No label file changes. |
| Recolour | managers | Nothing on disk. Colours are stored in the database only. |
| Rename | managers | `classes.txt` is updated. YOLO: no label file changes, because label files contain numbers. VOC and COCO: every label file that uses the class is rewritten with the new name, as a background job (refused while the project is being indexed). The rename is recorded until every file is done, so a restart resumes it; meanwhile files that still carry the old name are read as the renamed class and saves write the new name. |
| Delete or merge | managers | Affected label files and `classes.txt` are rewritten before the request returns. See below. |

Colours are assigned from a 20-colour palette when a class is created and can be changed at any time.

### Deleting and merging

Deleting a class is the one operation that can change many label files at once, so the delete
dialog asks what to do with the boxes that use it. It offers three choices:

- **Only if unused** (the default for a class no box uses). The server refuses if any label file
  still uses the class and reports how many images do; nothing is changed.
- **Merge into another class.** Every box of the deleted class becomes a box of the class you
  pick. Use this to fix duplicates such as `car` and `Car`, or to simplify a class list.
- **Delete its boxes.** Every box of that class is removed from all label files. This cannot be
  undone.

What is rewritten:

- **YOLO.** Every class after the deleted one moves up by one position, and every label file that
  uses a later class is rewritten with the new numbers, so each box keeps its meaning. Boxes of the
  deleted class are renumbered to the merge target, or their lines are removed. The rest of each
  line is kept as it was. `classes.txt` is rewritten without the deleted name.
- **Pascal VOC and COCO.** Boxes of the deleted class get the target's name, or are removed. COCO
  category ids are renumbered to follow the class order. `classes.txt` is rewritten as well.

The new file contents are prepared first and then replaced together. Before anything is touched the
server checks that every file (and its folder) is writable, including the Windows read-only
attribute, and it keeps a backup of each original next to it. If one file cannot be replaced, the
files that were already replaced are restored and nothing is changed; the temporary and backup files
are removed. A journal in the data folder makes the same rollback happen at the next start if the
server crashes in the middle; it restores only files that still hold the content of the interrupted rewrite,
so later saves are never overwritten. In the very unlikely case that restoring fails too, the server answers
`migration_incomplete` with the list of affected files and leaves the hidden `.bak` backups next to
them so you can restore them by hand. The dialog shows how many boxes and images use the class before you
confirm, and afterwards how many label files were rewritten. The delete is refused while the project
is being indexed. Saves in the project wait while it runs, and everyone who has the project open
sees the new class list immediately.

The revision history is not rewritten. If someone later restores an old revision that contained
boxes of a deleted class, those boxes come back as unknown labels in VOC and COCO projects, and are
left out in YOLO projects unless a class of that name exists.

Recommendations:

- Back up the label folder before deleting or merging classes in a large project.
- Tell whoever trains on the data: after a deletion in a YOLO project, class numbers have changed,
  and `data.yaml` files or model heads that were built on the old list no longer match.

### Unknown labels

If a label file contains a class the project does not know (a name that is not in the class list,
or a YOLO number beyond the end of `classes.txt`), the box is shown in grey with its raw label. The
class list is never changed behind your back, and saving the image writes such boxes back
unchanged. To make them regular boxes, add the missing class or reassign the boxes.

## 6. Members

Under **Settings → Members**, managers add users to the project and choose their role (**Viewer**,
**Annotator**, **Reviewer** or **Manager**).

- A newly added member receives a notification and finds the project on their projects page.
- Roles can be changed at any time. A project always keeps at least one manager.
- Removing a member clears their assignments in the project; the images they worked on keep their
  labels and status. Members can also leave a project themselves (**Leave project**), unless they
  are its only manager.
- Only existing, active accounts can be added. Accounts are created by an administrator
  ([section 2](#2-user-accounts)).

The members list shows, for each person, how many images are assigned to them and how many they
have submitted or finished.

## 7. Assignments

Every image can have one **assignee**. Assignments tell people what to work on: the project card
shows each person how many of their images are still open, the annotator opens the next of *their*
unfinished images first, and the **Assignee** filter value *Assigned to me* lists them.

### Assigning images

Open **Images** in the project (`/p/<id>/images`). The table lists every image with status, file
name, box count, classes, assignee, flag, comments, last editor and update time. It can be filtered
by file name, status, assignee, flag, class and comments, and sorted by name or by recent updates.
Select rows (or **Select all N matching** to cover everything the filter matches); managers can then:

- **Assign to…** one person. Only members who can annotate (annotators, reviewers, managers) can be
  assignees; viewers cannot.
- **Unassign**.
- **Distribute…** evenly among several people. Images are handed out in file order, so each person
  receives a contiguous run of files, which suits frame sequences; the shares differ by at most one
  image. Annotators are pre-selected. An optional **Limit** distributes only the first N images.
  Existing assignments of the affected images are replaced.
- **Flag** or **Unflag**, or **Set status…** in bulk.

Each assignee receives one notification saying how many images they were given.

A typical start: filter by *To do* and *unassigned*, then distribute among the annotators.

### Claiming

Annotators and reviewers can assign an unassigned image to themselves (**Claim this image** in the
annotator, **Claim N** in the Images table) and can give up an image that is assigned to them. With
**Only edit assigned images** on, an annotator who saves an unassigned image claims it
automatically.

### Restricting

With **Only edit assigned images** off (the default), assignments are guidance: any annotator can
edit any image. With it on, annotators can edit and submit only their own and unassigned images.
Reviewers and managers are not restricted.

## 8. Review workflow

Each image has a status.

| Status | Meaning |
| --- | --- |
| To do | Nobody has worked on it yet. |
| In progress | It has been saved at least once. |
| In review | Submitted and waiting for a reviewer (only with *Require review*). |
| Done | Finished. |
| Rejected | A reviewer sent it back with a reason. |

How an image moves:

| From | Action | To | Who |
| --- | --- | --- | --- |
| To do, Rejected | first save | In progress | anyone who can edit |
| To do, In progress, Rejected | **Submit for review** (**Mark done** when review is not required) | In review if *Require review* is on, otherwise Done | anyone who can edit |
| In review | Approve | Done | reviewers and above |
| In review | Reject, with a reason | Rejected | reviewers and above |
| Done, In review | Reopen | In progress | the annotator who is assigned to the image or finished it, and reviewers and above |

Things worth knowing:

- **Rejecting requires a reason.** It is stored as a comment on the image, and the annotator is
  notified. Comments can also be pinned to the exact spot on the image that needs fixing.
- **Notifications.** Reviewers and managers are told when an image is submitted for review; the
  person who finished the image (or, failing that, its assignee) is told when it is approved or
  rejected.
- **An image without objects** is finished by submitting it with no boxes. Submitting changes the
  status only; a label file is written when the image is saved.
- **Flags** are independent of the status. Anyone who can edit can flag an image to mark it as
  needing attention, for example a blurry frame or an unclear case; filter by *Flagged* to find them.
- **Existing datasets.** Images that had a label file when the project was created start as *Done*.
  To have them checked, select them in the Images table and use **Set status…**.

Turning **Require review** on or off affects images submitted from then on.

## 9. Uploading images

Managers can add images with the **Upload** button on the Images page. They are saved into the
project's image folder on the server and appear in the project at once.

- Accepted types: `.jpg`, `.jpeg`, `.png`, `.bmp`, `.webp`, `.tif`, `.tiff`, and the contents must
  be a valid image. Other files, including GIF, are skipped.
- Each file may be up to 50 MB by default (`ANNOTAMATE_MAX_UPLOAD_MB`) and one upload request up to
  1024 MB in total (`ANNOTAMATE_MAX_UPLOAD_REQUEST_MB`); a reverse proxy in front may impose its own
  limit ([deployment guide](deployment.md#7-https-with-a-reverse-proxy)).
- The browser sends the files in batches of 20.
- File names are cleaned of unsafe characters; names starting with a dot are refused.
- **Existing files are never overwritten.** If a name is taken, the new file gets a suffix
  (`-1`, `-2`, …).
- A file whose name differs from an existing image only by its extension (`a.png` next to `a.jpg`)
  is skipped, because both would share one label file; so is `classes.*` in a YOLO project.
- Images with more than 150 megapixels (`ANNOTAMATE_MAX_IMAGE_MEGAPIXELS`) are skipped.
- New images start as **To do**, or as **Done** if a label file of the same name already exists.
- When the upload ends, a message gives the number of images added and lists the first skipped
  files with the reason.

For large batches, copying the files onto the server and [rescanning](#10-rescanning) is faster
than uploading through the browser.

## 10. Rescanning

The project keeps an index of its image folder. When files are added, removed or labelled outside
Annotamate (copied onto the server, written by a script or a model), use **Rescan folder** under
**Settings → General → Storage** so the index catches up. Progress is shown live on the overview
page; people can keep working meanwhile.

A rescan:

- adds new images (**Done** if they have a label file, otherwise **To do**);
- never changes the status or assignment of an image that is already in the project, even when a
  label file has appeared for it; box counts and per-class counts are refreshed from the label files;
- marks images that are no longer in the folder as **missing**. They disappear from the images list,
  counts, statistics, exports and bulk actions, but their status, comments and revision history are
  kept: if the file comes back (a remounted share, a restored backup) a rescan makes the image
  reappear exactly as it was. If the folder looks completely empty (for example an unmounted
  share), nothing is marked, and nothing under a sub-folder that cannot be read is marked either;
- does not add classes. Add them under **Settings → Classes**.

**Removing missing images for good.** When a project has missing images, **Settings → Danger zone**
shows how many and offers **Remove missing images**. After you confirm, those images are deleted from
the project together with their status, comments and revision history. This cannot be undone;
it does not touch any file on disk.

**Images that share a label file.** Label files are named after the image, so `a.jpg` and `a.png`
in the same folder would both use `a.txt` (the comparison ignores upper and lower case). The first
image in natural order owns the label file; the others are read-only, and the annotator shows which
image owns it. Rename one of the images to give each its own labels. In YOLO projects an image named
`classes` (`classes.jpg`) is read-only, because `classes.txt` is the class list. Uploads of such
files are skipped with the reason.

The server also re-indexes the project when **Include sub-folders** is switched on or off.

## 11. Exports

Annotamate writes label files continuously, so for many pipelines there is nothing to export:
train directly on the project's folders. **Export** (managers, on the Images page) is for handing a
dataset over as one archive, or for getting dataset-level files.

Options:

| Option | Choices |
| --- | --- |
| Format | YOLO, Pascal VOC or COCO; preselected with the project's own format, but any can be chosen |
| Images | **All images** (every image that has a label file) or **Done only** (every image with status *Done*) |
| Include the image files | off (labels only) or on |

The download is a ZIP archive named `<project>-<format>.zip`. Paths inside follow the image's path
relative to the image folder:

| Format | Contents |
| --- | --- |
| YOLO | `labels/<path>.txt`, `classes.txt`, `data.yaml` (`path`, `train`, `val`, `nc`, `names`) |
| Pascal VOC | `Annotations/<path>.xml` |
| COCO | one dataset-level `annotations.json` with `images`, `annotations` and `categories`; ids start at 1, category ids follow the class order, boxes are `[x, y, width, height]` in pixels, `segmentation` is empty |
| with images | additionally `images/<path>` |

Details:

- When the export format equals the project's format, existing label files are copied unchanged
  (except in COCO, which is always rebuilt as one file). Otherwise the boxes are converted: polygon
  or oriented-box content is reduced to boxes, and boxes whose class is not in the class list are
  dropped when converting between YOLO (numbers) and VOC or COCO (names).
- `data.yaml` points `train` and `val` at `images`. Without **Include the image files** a comment in
  the file tells you to copy the images into `./images`.
- Images that cannot be read are exported without labels (COCO leaves them out).

Exporting only *Done* images is the usual way to train on reviewed data while annotation continues.
Exports of large datasets with images take a while and produce large files.

## 12. Archiving and deleting projects

**Archive project** (managers, under **Settings → Danger zone**) takes a finished project off the
projects page for everyone. It only hides the project: files, labels, history and conversations stay
as they are, and nothing on disk is changed. Members and administrators find it again with **Show
archived** on the projects page, and **Restore project** (in the same Danger zone tab) brings it
back.

**Delete project** (administrators only, under **Settings → Danger zone**; you confirm by typing the
project name) removes it from Annotamate: its membership, statuses, assignments, chat, comments,
activity and revision history. **Files on disk are not touched**: images, label files and
`classes.txt` remain exactly as they are. Creating a new project on the same folder later picks the
labels up again, but not the deleted history.

## 13. Following a project

- **Project overview** (`/p/<id>`): counts per status, a 30-day activity chart, team progress, a
  histogram of boxes per class, the members with their presence, open comment threads and the
  activity feed. The buttons at the top lead to the **Review queue** (reviewers and above) and to
  **Continue annotating**.
- **Activity feed**: saves (several saves of one image by one person within ten minutes are shown
  as one entry), status changes, assignments, class changes, membership changes, uploads and rescans.
- **Presence**: who is online and which image each person has open.
- **Edit locks**: one person edits an image at a time; others see it read-only. Managers and
  administrators can **take over** a lock, for example when someone left an image open and went
  home. The previous holder is notified and drops to read-only. A lock also expires by itself about
  a minute after its holder's browser stops responding.
- **Revisions**: the last 50 saves of every image are kept with author and time and can be restored
  from the History tab in the annotator.
- **Project chat and comments**: managers can delete any chat message or comment in their project.
