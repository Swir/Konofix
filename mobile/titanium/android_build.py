"""Build Konofix with Swir/Titanium-APK-Bulider and the runner's official SDK.
No custom DEX, manifest encoder, signer, mock toolchain or Windows changes.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PACKAGE = "info.swirtv.konofix.androidtest"
VERSION = "0.1.0-alpha.3-titanium"
ANDROID_NS = "http://schemas.android.com/apk/res/android"
ET.register_namespace("android", ANDROID_NS)

def emit(level, message):
    print(f"[{level}] {message}", flush=True)

class RunnerToolchain:
    def __init__(self):
        sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
        if not sdk:
            raise RuntimeError("ANDROID_HOME is missing; use the GitHub Android workflow")
        self.sdk = Path(sdk)
        self.gradle = shutil.which("gradle")
        self.signer = self.sdk / "build-tools/36.0.0/apksigner"
    def ready(self):
        return bool(self.gradle and shutil.which("java") and self.signer.is_file()
                    and (self.sdk / "platforms/android-36/android.jar").is_file())
    def gradle_exe(self):
        return self.gradle
    def apksigner_exe(self):
        return self.signer
    def env(self):
        return {**os.environ, "ANDROID_HOME": str(self.sdk), "ANDROID_SDK_ROOT": str(self.sdk)}

def write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--titanium-dir", required=True, type=Path)
    args = parser.parse_args()
    tool = args.titanium_dir.resolve()
    if not (tool / "titanium/builder.py").is_file():
        raise RuntimeError("Titanium source checkout is missing")
    sys.path.insert(0, str(tool))
    from titanium.builder import AndroidBuilder
    from titanium import AGP_VERSION, ANDROID_API
    if ANDROID_API != 36:
        raise RuntimeError("Unexpected Titanium API profile")

    class KonofixBuilder(AndroidBuilder):
        def _main_activity(self, c, pkg, start_url, local):
            if pkg != PACKAGE or not local:
                raise ValueError("Only the bundled Konofix Android test application is supported")
            return (HERE / "MainActivity.java").read_text(encoding="utf-8")
        def generate(self, c):
            project = super().generate(c)
            manifest = project / "app/src/main/AndroidManifest.xml"
            tree = ET.parse(manifest)
            application = tree.getroot().find("application")
            for key, value in {"theme": "@style/KonofixTheme", "allowBackup": "false",
                               "fullBackupContent": "false", "dataExtractionRules": "@xml/data_extraction_rules",
                               "icon": "@mipmap/ic_launcher", "roundIcon": "@mipmap/ic_launcher",
                               "usesCleartextTraffic": "false"}.items():
                application.set(f"{{{ANDROID_NS}}}{key}", value)
            activity = application.find("activity")
            activity.set(f"{{{ANDROID_NS}}}windowSoftInputMode", "adjustResize")
            activity.set(f"{{{ANDROID_NS}}}enableOnBackInvokedCallback", "false")
            tree.write(manifest, encoding="utf-8", xml_declaration=True)
            res = project / "app/src/main/res"
            write(res / "values/styles.xml", '''<resources><style name="KonofixTheme" parent="android:style/Theme.Material.NoActionBar"><item name="android:fontFamily">sans</item><item name="android:windowLightStatusBar">false</item><item name="android:windowLightNavigationBar">false</item><item name="android:windowBackground">#101522</item><item name="android:statusBarColor">#101522</item><item name="android:navigationBarColor">#101522</item><item name="android:colorAccent">#65cfff</item></style><color name="icon_background">#101b30</color></resources>''')
            write(res / "values-v31/styles.xml", '''<resources><style name="KonofixTheme" parent="android:style/Theme.Material.NoActionBar"><item name="android:windowSplashScreenBackground">#101522</item><item name="android:windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item><item name="android:windowBackground">#101522</item><item name="android:windowLightStatusBar">false</item><item name="android:windowLightNavigationBar">false</item><item name="android:statusBarColor">#101522</item><item name="android:navigationBarColor">#101522</item><item name="android:colorAccent">#65cfff</item></style></resources>''')
            # Same speech-bubble K paths as the initial mobile icon, not a generic launcher icon.
            write(res / "drawable/ic_foreground.xml", '''<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108"><group android:scaleX="0.145" android:scaleY="0.145" android:translateX="17" android:translateY="17"><path android:fillColor="#25213d" android:pathData="M196,123h178a39,39 0,0 1,39 39v147a39,39 0,0 1,-39 39h-28l-3,49 -63,-49h-84a39,39 0,0 1,-39 -39V162a39,39 0,0 1,39 -39Z"/><path android:fillColor="#13273e" android:strokeColor="#70d7ff" android:strokeWidth="17" android:strokeLineJoin="round" android:pathData="M131,135h216a34,34 0,0 1,34 34v133a34,34 0,0 1,-34 34H217l-69,48v-48h-17a34,34 0,0 1,-34 -34V169a34,34 0,0 1,34 -34Z"/><path android:strokeColor="#a2beff" android:strokeWidth="23" android:strokeLineCap="round" android:strokeLineJoin="round" android:fillColor="#00000000" android:pathData="M192,189v94M291,189l-70,48 73,48"/><path android:fillColor="#6ee9ff" android:pathData="M361,120a19,19 0,1 0,38 0a19,19 0,1 0,-38 0"/></group></vector>''')
            write(res / "mipmap-anydpi-v26/ic_launcher.xml", '''<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/icon_background"/><foreground android:drawable="@drawable/ic_foreground"/></adaptive-icon>''')
            excludes = ''.join(f'<exclude domain="{domain}" path="."/>' for domain in ("root", "file", "database", "sharedpref", "external"))
            write(res / "xml/data_extraction_rules.xml", f'<data-extraction-rules><cloud-backup>{excludes}</cloud-backup><device-transfer>{excludes}</device-transfer></data-extraction-rules>')
            return project

    work = ROOT / ".android-titanium-build"
    work.mkdir(exist_ok=True)
    (work / "workspace").mkdir(exist_ok=True)
    paths = SimpleNamespace(root=work, workspace=work / "workspace")
    config = dict(app_name="Konofix Android", package=PACKAGE, target_sdk=36, min_sdk=26,
                  version_code=3, version_name=VERSION, source_type="Folder",
                  source=str(HERE / "web-dist"), build_mode="Debug", export_format="APK",
                  sign_release=False, keystore="", store_password="", key_alias="", key_password="",
                  camera=False, microphone=False, location=False, orientation="unspecified",
                  output_dir=str(ROOT / "out"))
    artifact = KonofixBuilder(paths, RunnerToolchain(), emit).build(config)
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    write(artifact.with_suffix(".apk.sha256"), f"{digest}  {artifact.name}\n")
    report = {"artifact": artifact.name, "sha256": digest, "bytes": artifact.stat().st_size,
              "application_id": PACKAGE, "version": VERSION, "titanium_commit": "dd71a04df8730283a2823b7d1c639b9f9aafb368",
              "konofix_commit": os.environ.get("GITHUB_SHA", "local"), "agp": AGP_VERSION,
              "sdk_compiled": True, "titanium_signature_validation": "passed",
              "emulator_test": "separate smoke-android.json; not implied by build success",
              "physical_device_test": "not performed", "windows_interop_test": "not performed"}
    write(ROOT / "out/build-report.json", json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()
