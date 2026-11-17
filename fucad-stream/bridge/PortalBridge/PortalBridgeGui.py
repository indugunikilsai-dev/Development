# SPDX-License-Identifier: LGPL-2.1-or-later

"""Makes FreeCAD's File menu work with the files on the user's PC instead of the container's disk.

FreeCAD runs inside a container and is streamed to the portal's FreeCAD page. Its own file dialogs
can only show the container's folders, so this module replaces them:

    File > Open / Import      the portal shows the PC's file picker; the chosen file is uploaded
                              and opened (or imported into the active document) here.
    File > Save               saves as usual, then the portal writes the file back to the PC
                              (to the same file it was opened from, when the browser allows it).
    File > Save As            the portal shows the PC's "Save as" dialog.
    File > Save a Copy        same, without changing the document's own file.
    File > Export             asks for the format here, then the portal saves the file on the PC.

The portal and FreeCAD talk through the container's file service (portal-files) and a folder,
PORTAL_BRIDGE_DIR:

    requests/<id>.json    from the file service: {"action": "open" | "save", ...}
    results/<id>.json     the answer: {"ok": true, ...} or {"ok": false, "error": ...}
    events/<seq>.json     from here to the portal: {"type": "pick" | "saved" | "download", ...}
    heartbeat             touched every second: FreeCAD is running
    portal-seen           touched by the file service while a portal page is listening

When no portal page is listening (the stream opened on its own), the File menu keeps FreeCAD's
normal dialogs, so FreeCAD stays usable.

Documents live in PORTAL_WORK_DIR inside the container while they are open: every opened or saved
file gets its own folder there, so a file keeps the name it has on the PC.

Everything runs on the GUI thread (a Qt timer, Qt signals), so it never races the user's own work.
"""

import importlib
import json
import os
import re
import shutil
import time
import uuid

import FreeCAD as App
import FreeCADGui as Gui
from PySide import QtCore, QtWidgets

POLL_MS = 1000
STALE_SECONDS = 120          # requests older than this are dropped (the file service gave up)
PORTAL_SEEN_SECONDS = 60     # the portal long-polls every ~25 s
EVENT_KEEP_SECONDS = 24 * 3600
TEMP_KEEP_SECONDS = 24 * 3600

BRIDGE = os.environ.get("PORTAL_BRIDGE_DIR", "")
WORK = os.environ.get("PORTAL_WORK_DIR", "") or os.path.join(os.path.expanduser("~"), "PortalFiles")
TEMP = os.path.join(WORK, ".downloads")   # Save a Copy / Export results, collected by the portal

# Readable names for the Export format list. Formats not listed here are shown by extension.
FORMAT_NAMES = {
    "step": "STEP", "stp": "STEP", "iges": "IGES", "igs": "IGES", "brep": "BREP", "brp": "BREP",
    "stl": "STL mesh", "obj": "OBJ mesh", "ply": "PLY mesh", "off": "OFF mesh", "amf": "AMF mesh",
    "3mf": "3MF", "dxf": "DXF", "svg": "SVG", "pdf": "PDF", "ifc": "IFC", "dae": "Collada",
    "gltf": "glTF", "glb": "glTF binary", "wrl": "VRML", "vrml": "VRML", "fcstd": "FreeCAD document",
}
PREFERRED_EXPORT = "step"

_timer = None
_observer = None
_guard = None
_quiet = 0           # > 0 while this module saves internally (no "saved" event for those)
_hooked = []         # the QActions taken over, kept so their Python wrappers stay alive
_last_export = PREFERRED_EXPORT


# ---- small helpers ------------------------------------------------------------------------------

def _path(*parts):
    return os.path.join(BRIDGE, *parts)


def _write_json(path, data):
    """Write atomically, so the file service never reads half a file."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _safe_name(name, fallback="Design"):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", name or "").strip(" .")
    return name[:120] or fallback


def _new_folder(parent):
    folder = os.path.join(parent, uuid.uuid4().hex[:12])
    os.makedirs(folder, exist_ok=True)
    return folder


def _main_window():
    return Gui.getMainWindow()


def _status(text, ms=8000):
    try:
        _main_window().statusBar().showMessage(text, ms)
    except Exception:
        pass


def _info(title, text):
    QtWidgets.QMessageBox.information(_main_window(), title, text)


def portal_connected():
    try:
        return time.time() - os.path.getmtime(_path("portal-seen")) < PORTAL_SEEN_SECONDS
    except OSError:
        return False


def _emit(event):
    """Queue an event for the portal page."""
    event = dict(event, id="{:020d}-{}".format(time.time_ns(), uuid.uuid4().hex[:6]))
    _write_json(_path("events", event["id"] + ".json"), event)
    return event["id"]


class _Quiet:
    """Internal saves (copies, exports) must not be reported as the user's own Save."""

    def __enter__(self):
        global _quiet
        _quiet += 1

    def __exit__(self, *exc):
        global _quiet
        _quiet -= 1


# ---- File menu ----------------------------------------------------------------------------------

def _original(command):
    # Gui.runCommand invokes the command itself, not its (taken over) menu action.
    Gui.runCommand(command, 0)


def _ask_portal_for_file(mode):
    """Let the user pick a file on the PC; the portal uploads it and asks us to open it."""
    doc = App.ActiveDocument
    _emit({"type": "pick", "mode": mode, "document": doc.Name if (doc and mode == "import") else ""})
    _status("Choose the file on your PC in the window that opened in the browser.")


def cmd_open():
    if not portal_connected():
        return _original("Std_Open")
    _ask_portal_for_file("open")


def cmd_import():
    if not portal_connected():
        return _original("Std_Import")
    _ask_portal_for_file("import" if App.ActiveDocument else "open")


def cmd_save():
    doc = App.ActiveDocument
    if doc is None:
        return
    if not portal_connected():
        return _original("Std_Save")
    if not doc.FileName:
        return cmd_save_as()
    # A normal save; the document observer tells the portal, which writes the file to the PC.
    _original("Std_Save")


def cmd_save_as():
    doc = App.ActiveDocument
    if doc is None:
        return
    if not portal_connected():
        return _original("Std_SaveAs")
    target = os.path.join(_new_folder(WORK), _safe_name(doc.Label) + ".FCStd")
    doc.saveAs(target)   # the observer reports it; the portal asks where to save it on the PC


def cmd_save_copy():
    doc = App.ActiveDocument
    if doc is None:
        return
    if not portal_connected():
        return _original("Std_SaveCopy")
    target = os.path.join(_new_folder(TEMP), _safe_name(doc.Label) + ".FCStd")
    with _Quiet():
        doc.saveCopy(target)
    _emit({"type": "download", "path": target, "name": os.path.basename(target), "document": doc.Label})
    _status("Choose where to save the copy in the browser window.")


def _export_formats():
    formats = {}
    for ext, modules in (App.getExportType() or {}).items():
        ext = (ext or "").lower()
        if not ext or not modules or ext in ("fcstd", "fcmacro", "py"):
            continue
        formats[ext] = "{} (*.{})".format(FORMAT_NAMES.get(ext, ext.upper()), ext)
    return dict(sorted(formats.items(), key=lambda item: item[1].lower()))


def cmd_export():
    global _last_export
    doc = App.ActiveDocument
    if doc is None:
        return
    if not portal_connected():
        return _original("Std_Export")

    objects = Gui.Selection.getSelection(doc.Name)
    if not objects:
        return _info("Export", "Select the objects to export first.")
    formats = _export_formats()
    if not formats:
        return _info("Export", "No export formats are available.")

    labels = list(formats.values())
    current = labels.index(formats[_last_export]) if _last_export in formats else 0
    label, ok = QtWidgets.QInputDialog.getItem(
        _main_window(), "Export to your PC", "Format:", labels, current, False)
    if not ok:
        return
    ext = next(e for e, text in formats.items() if text == label)
    _last_export = ext

    name = _safe_name(objects[0].Label if len(objects) == 1 else doc.Label) + "." + ext
    target = os.path.join(_new_folder(TEMP), name)
    with _Quiet():
        Gui.export(objects, target)
    if not os.path.isfile(target):
        return _info("Export", "FreeCAD could not export to .{}.".format(ext))
    _emit({"type": "download", "path": target, "name": name, "document": doc.Label})
    _status("Choose where to save {} in the browser window.".format(name))


def _view_to_pdf(view, target):
    """The 3D view as a one-page PDF (what FreeCAD's own Export PDF prints for it): rendered at
    three times its size for sharp print, centred on an A4 page turned to fit."""
    from PySide import QtGui
    width, height = view.getSize()
    image_path = target[:-4] + ".png"
    view.saveImage(image_path, max(width, 1) * 3, max(height, 1) * 3, "Current")
    try:
        image = QtGui.QImage(image_path)
        writer = QtGui.QPdfWriter(target)
        writer.setPageSize(QtGui.QPageSize(QtGui.QPageSize.A4))
        writer.setPageOrientation(
            QtGui.QPageLayout.Landscape if width >= height else QtGui.QPageLayout.Portrait)
        writer.setResolution(300)
        painter = QtGui.QPainter(writer)
        try:
            area = painter.viewport()
            size = image.size().scaled(area.size(), QtCore.Qt.KeepAspectRatio)
            painter.setViewport(area.x() + (area.width() - size.width()) // 2,
                                area.y() + (area.height() - size.height()) // 2,
                                size.width(), size.height())
            painter.setWindow(image.rect())
            painter.drawImage(0, 0, image)
        finally:
            painter.end()
    finally:
        try:
            os.remove(image_path)
        except OSError:
            pass


def cmd_print_pdf():
    """File > Export PDF: the PDF is written here with no FreeCAD dialog or window, then the
    portal saves it on the PC."""
    doc = App.ActiveDocument
    view = Gui.activeView()
    if not portal_connected() or doc is None or view is None:
        return _original("Std_PrintPdf")
    if hasattr(view, "getPage"):                       # a TechDraw drawing page
        page = view.getPage()
        target = os.path.join(_new_folder(TEMP), _safe_name(page.Label) + ".pdf")
        import TechDrawGui
        TechDrawGui.exportPageAsPdf(page, target)
    elif hasattr(view, "saveImage") and hasattr(view, "getSize"):   # the 3D view
        target = os.path.join(_new_folder(TEMP), _safe_name(doc.Label) + ".pdf")
        _view_to_pdf(view, target)
    else:                                              # other views keep FreeCAD's own command
        return _original("Std_PrintPdf")
    if not os.path.isfile(target):
        return _info("Export PDF", "FreeCAD could not create the PDF.")
    name = os.path.basename(target)
    _emit({"type": "download", "path": target, "name": name, "document": doc.Label})
    _status("{} is being saved to your PC.".format(name))


COMMANDS = {
    "Std_Open": cmd_open,
    "Std_Import": cmd_import,
    "Std_Save": cmd_save,
    "Std_SaveAs": cmd_save_as,
    "Std_SaveCopy": cmd_save_copy,
    "Std_Export": cmd_export,
    "Std_PrintPdf": cmd_print_pdf,
}


def _run(handler):
    try:
        handler()
    except Exception as e:
        App.Console.PrintError("PortalBridge: {}\n".format(e))
        _info("FreeCAD", str(e) or e.__class__.__name__)


def _hook_commands():
    """Take over the File menu actions. Actions are created lazily, so this runs on every poll."""
    for name, handler in COMMANDS.items():
        try:
            command = Gui.Command.get(name)
            actions = command.getAction() if command else []
        except Exception:
            continue
        for action in actions:
            if action.property("portalBridge"):
                continue
            try:
                # Drops FreeCAD's own handler (and any other) from the menu item, toolbar button
                # and shortcut, which all share this action.
                action.triggered.disconnect()
            except (RuntimeError, TypeError):
                pass
            action.triggered.connect(lambda *_, h=handler: _run(h))
            action.setProperty("portalBridge", True)
            _hooked.append(action)
    _hide_exit()


def _hide_exit():
    """File > Exit would close FreeCAD and leave the stream on an empty desktop, so it is removed
    (menu item and its Ctrl+Q shortcut)."""
    try:
        command = Gui.Command.get("Std_Quit")
        actions = command.getAction() if command else []
    except Exception:
        return
    for action in actions:
        if action.isVisible() or action.isEnabled():
            action.setVisible(False)
            action.setEnabled(False)


class _DialogGuard(QtCore.QObject):
    """Safety net for file dialogs opened by other routes than the File menu actions: the Start
    page's "Open" button, or "Save changes?" when closing a document that was never saved. Such a
    dialog would show the container's folders, so it is closed and the PC route is used instead."""

    def eventFilter(self, obj, event):
        if event.type() == QtCore.QEvent.Show and isinstance(obj, QtWidgets.QFileDialog) \
                and not obj.property("portalBridgeSeen") and portal_connected():
            obj.setProperty("portalBridgeSeen", True)
            filters = " ".join(obj.nameFilters()).lower()
            if "fcstd" in filters:
                saving = obj.acceptMode() == QtWidgets.QFileDialog.AcceptSave
                QtCore.QTimer.singleShot(0, obj.reject)
                QtCore.QTimer.singleShot(0, lambda: _run(cmd_save_as if saving else cmd_open))
        return False


class _SaveObserver:
    """Every save of a document (menu, shortcut, "Save changes?" on close) is reported to the
    portal, which writes the file to the PC."""

    def slotFinishSaveDocument(self, doc, filename):
        if _quiet or not filename:
            return
        try:
            _emit({"type": "saved", "path": os.path.realpath(filename),
                   "name": os.path.basename(filename), "document": doc.Label})
            _status("Saving {} to your PC…".format(os.path.basename(filename)))
        except Exception as e:
            App.Console.PrintWarning("PortalBridge: {}\n".format(e))


# ---- requests from the file service --------------------------------------------------------------

def _importer(ext):
    modules = App.getImportType(ext) or []
    if isinstance(modules, str):
        modules = [modules]
    modules = sorted(modules, key=lambda m: not m.endswith("Gui"))
    for name in modules:
        try:
            module = importlib.import_module(name)
        except Exception:
            continue
        if hasattr(module, "open") and hasattr(module, "insert"):
            return module
    raise ValueError("FreeCAD cannot open .{} files.".format(ext or "?"))


def _open(request):
    path = os.path.realpath(str(request.get("path", "")))
    if os.path.commonpath([path, os.path.realpath(WORK)]) != os.path.realpath(WORK) or not os.path.isfile(path):
        raise ValueError("The uploaded file was not found.")

    ext = os.path.splitext(path)[1].lstrip(".").lower()
    target = request.get("document") or ""
    if request.get("mode") == "import" and not target and App.ActiveDocument is not None:
        target = App.ActiveDocument.Name   # the portal's own Import button: into the active design
    importing = request.get("mode") == "import" and target in App.listDocuments()

    if ext == "fcstd":
        if importing:
            doc = App.getDocument(target)
            doc.mergeProject(path)
            doc.recompute()
        else:
            doc = App.openDocument(path)
    else:
        # The same importer File > Open / Import would use (the *Gui one first: it keeps colours).
        module = _importer(ext)
        before = set(App.listDocuments())
        if importing:
            module.insert(path, target)
            doc = App.getDocument(target)
        else:
            module.open(path)
            opened = [name for name in App.listDocuments() if name not in before]
            doc = App.getDocument(opened[-1]) if opened else App.ActiveDocument
            if opened and doc is not None:
                # "Unnamed" otherwise; Save As then suggests the PC file's name.
                doc.Label = os.path.splitext(os.path.basename(path))[0]

    if doc is not None:
        Gui.setActiveDocument(doc)
        Gui.SendMsgToActiveView("ViewFit", True)
    _status("Opened {}".format(os.path.basename(path)))
    return {"document": doc.Label if doc is not None else "",
            "file": os.path.realpath(doc.FileName) if (doc is not None and doc.FileName) else ""}


def _save(request):
    if App.ActiveDocument is None:
        raise ValueError("No design is open in FreeCAD.")
    cmd_save_as() if request.get("as") else cmd_save()
    return {}


def _handle(request_file):
    request_id = os.path.splitext(os.path.basename(request_file))[0]
    work = request_file + ".work"
    try:
        os.replace(request_file, work)   # claim it, so it never runs twice
    except OSError:
        return

    result = {}
    try:
        if time.time() - os.path.getmtime(work) > STALE_SECONDS:
            return
        with open(work, encoding="utf-8") as f:
            request = json.load(f)
        action = request.get("action")
        if action == "open":
            result = _open(request)
        elif action == "save":
            result = _save(request)
        else:
            raise ValueError("Unknown request: {}".format(action))
        result["ok"] = True
    except Exception as e:   # report every failure instead of leaving the portal waiting
        App.Console.PrintWarning("PortalBridge: {}\n".format(e))
        result = {"ok": False, "error": str(e) or e.__class__.__name__}
    finally:
        try:
            os.remove(work)
        except OSError:
            pass
        if result:
            _write_json(_path("results", request_id + ".json"), result)


def _prune(folder, max_age, dirs=False):
    cutoff = time.time() - max_age
    for name in os.listdir(folder) if os.path.isdir(folder) else []:
        full = os.path.join(folder, name)
        try:
            if os.path.getmtime(full) < cutoff:
                if os.path.isdir(full):
                    shutil.rmtree(full, ignore_errors=True)
                elif not dirs:
                    os.remove(full)
        except OSError:
            pass


def _poll():
    try:
        with open(_path("heartbeat"), "w") as f:
            f.write(str(int(time.time())))
        _hook_commands()

        # Wait while a modal dialog is open: opening documents behind it would be confusing.
        if QtWidgets.QApplication.activeModalWidget() is not None:
            return
        requests = _path("requests")
        for name in sorted(os.listdir(requests)):
            if name.endswith(".json"):
                _handle(os.path.join(requests, name))
    except Exception as e:
        App.Console.PrintWarning("PortalBridge: {}\n".format(e))


def start():
    """Start the bridge. Does nothing unless FreeCAD runs with PORTAL_BRIDGE_DIR set."""
    global _timer, _observer, _guard
    if not BRIDGE or _timer is not None:
        return
    for sub in ("requests", "results", "events"):
        os.makedirs(_path(sub), exist_ok=True)
    os.makedirs(TEMP, exist_ok=True)
    _prune(_path("events"), EVENT_KEEP_SECONDS)
    _prune(TEMP, TEMP_KEEP_SECONDS, dirs=True)

    _observer = _SaveObserver()
    App.addDocumentObserver(_observer)
    _guard = _DialogGuard()
    QtWidgets.QApplication.instance().installEventFilter(_guard)

    _timer = QtCore.QTimer()
    _timer.timeout.connect(_poll)
    _timer.start(POLL_MS)
    App.Console.PrintLog("PortalBridge: watching {}\n".format(BRIDGE))

