# SPDX-License-Identifier: LGPL-2.1-or-later

"""PortalBridge: File > Open / Import / Save work with the files on the user's own PC.

Active only inside the streaming container (PORTAL_BRIDGE_DIR is set there). A normal desktop
FreeCAD / FuCad loads this file and does nothing else.
"""

import os

if os.environ.get("PORTAL_BRIDGE_DIR"):
    import PortalBridgeGui

    PortalBridgeGui.start()
