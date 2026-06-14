#!/usr/bin/env bash
# Trim PySide6 down to what the native window needs (QtWebEngineWidgets + deps).
# The Chromium blob (libQt6WebEngineCore ~195M) is irreducible; everything below
# is verified-safe to drop for our English, no-media, localhost-only UI.
# Re-run of the offscreen self-test after this confirms WebEngine still loads.
set -euo pipefail
APPDIR="$1"
PYSIDE="$(echo "$APPDIR"/opt/python*/lib/python*/site-packages/PySide6)"
[ -d "$PYSIDE" ] || { echo "PySide6 not found under $APPDIR"; exit 1; }
QLIB="$PYSIDE/Qt/lib"
before="$(du -sh "$PYSIDE" | cut -f1)"

# 1. Leaf Qt modules QtWebEngineWidgets never pulls. NOTE: the shared lib drops
#    the leading "Qt" (module QtCharts → libQt6Charts.so), while the Python
#    binding keeps it (QtCharts.abi3.so).
REMOVE=(
  Qt3DAnimation Qt3DCore Qt3DExtras Qt3DInput Qt3DLogic Qt3DRender Qt3DQuick
  QtCharts QtChartsQml QtDataVisualization QtDataVisualizationQml QtGraphs QtGraphsWidgets
  QtMultimedia QtMultimediaWidgets QtMultimediaQuick QtSpatialAudio
  QtQuick3D QtQuick3DAssetImport QtQuick3DAssetUtils QtQuick3DEffects QtQuick3DGlslParser
  QtQuick3DHelpers QtQuick3DIblBaker QtQuick3DParticles QtQuick3DParticleEffects
  QtQuick3DPhysics QtQuick3DPhysicsHelpers QtQuick3DRuntimeRender QtQuick3DUtils QtQuick3DXr
  QtQuickTimeline QtQuickEffectMaker QtQuickShapes
  QtBluetooth QtNfc QtSensors QtSensorsQuick QtSerialBus QtSerialPort
  QtRemoteObjects QtRemoteObjectsQml QtScxml QtStateMachine QtTextToSpeech
  QtDesigner QtDesignerComponents QtUiTools QtHelp QtSql
  QtWebSockets QtHttpServer QtNetworkAuth QtLocation
  QtTest QtChartsQml QtSvgWidgets
)
for m in "${REMOVE[@]}"; do
  rm -f "$PYSIDE/$m.abi3.so" "$PYSIDE/$m.pyi" 2>/dev/null || true   # python binding
  rm -f "$QLIB/libQt6${m#Qt}".so* 2>/dev/null || true               # shared lib (no "Qt")
done

# 2. ffmpeg (HTML5 media) — dlopen'd, not DT_NEEDED. Our UI plays no media.
rm -f "$QLIB"/libav{codec,format,util,filter,device,resample}.so* 2>/dev/null || true
rm -f "$QLIB"/libsw{scale,resample}.so* 2>/dev/null || true

# 3. WebEngine locales: keep only en-US (it falls back to en-US anyway).
LOC="$PYSIDE/Qt/translations/qtwebengine_locales"
if [ -d "$LOC" ]; then
  find "$LOC" -name '*.pak' ! -name 'en-US.pak' -delete 2>/dev/null || true
fi
# Qt's own .qm translations aren't needed for our English UI.
rm -f "$PYSIDE"/Qt/translations/*.qm 2>/dev/null || true

# 4. QML dev metatypes — tooling only, never loaded at runtime.
rm -rf "$PYSIDE/Qt/metatypes" 2>/dev/null || true

# 5. QML import trees for the removed modules.
for d in QtQuick3D Qt3D QtCharts QtDataVisualization QtGraphs QtMultimedia \
         QtTextToSpeech QtBluetooth QtNfc QtSensors QtRemoteObjects QtScxml \
         QtQuick/Timeline QtQuick/Scene3D QtQuick/Particles3D QtLocation QtTest; do
  rm -rf "$PYSIDE/Qt/qml/$d" 2>/dev/null || true
done

# 6. Build/dev tooling never needed at runtime.
rm -rf "$PYSIDE/Qt/bin" 2>/dev/null || true
rm -f "$PYSIDE"/Qt/libexec/Assistant* "$PYSIDE"/Qt/libexec/Designer* \
      "$PYSIDE"/Qt/libexec/linguist* "$PYSIDE"/Qt/libexec/*relform* 2>/dev/null || true

echo "  PySide6 trimmed: $before → $(du -sh "$PYSIDE" | cut -f1)"
