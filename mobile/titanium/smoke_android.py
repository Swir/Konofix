"""Install and launch the SDK APK on exactly one emulator; never target a phone."""
from __future__ import annotations
import json
import re
import subprocess
import time
from pathlib import Path
from xml.etree import ElementTree as ET

PACKAGE = "info.swirtv.konofix.androidtest"
OUT = Path("out")

def main():
    OUT.mkdir(exist_ok=True)
    candidates = list(OUT.glob("*.apk"))
    if len(candidates) != 1:
        raise RuntimeError("Expected exactly one freshly built APK")
    devices = subprocess.check_output(["adb", "devices"], text=True)
    serials = [line.split()[0] for line in devices.splitlines()
               if line.startswith("emulator-") and line.split()[-1] == "device"]
    if len(serials) != 1:
        raise RuntimeError("This smoke test requires exactly one authorized emulator")
    serial = serials[0]
    def adb(*args, check=True):
        result = subprocess.run(["adb", "-s", serial, *map(str, args)], text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                timeout=90, check=check)
        return result.stdout
    if adb("shell", "getprop", "ro.kernel.qemu").strip() != "1":
        raise RuntimeError("Refusing to install onto a non-emulator device")
    report = {"emulator": serial, "android_api": adb("shell", "getprop", "ro.build.version.sdk").strip(),
              "apk": candidates[0].name, "installed": False, "ui_ready": False,
              "welcome_visible": False, "survives_home": False,
              "launcher_wait_dialogs": 0, "physical_device_test": False,
              "public_relay_messages_sent": False}
    def screenshot(name):
        with (OUT / name).open("wb") as image:
            subprocess.run(["adb", "-s", serial, "exec-out", "screencap", "-p"], stdout=image, timeout=30, check=True)
    def visible_welcome(stage):
        # UIAutomator's first accessibility snapshot may lag behind WebView readiness.
        # Dismiss ONLY the known Pixel Launcher cold-boot ANR from run 2, by its
        # exact title and Wait button. Never suppress an app ANR or arbitrary dialog.
        for attempt in range(5):
            adb("shell", "uiautomator", "dump", "/sdcard/konofix-smoke.xml")
            adb("pull", "/sdcard/konofix-smoke.xml", OUT / "ui.xml")
            tree = ET.parse(OUT / "ui.xml")
            nodes = list(tree.iter("node"))
            text = " ".join(n.get("text", "") + " " + n.get("content-desc", "") for n in nodes)
            if "Połączmy się" in text and any(n.get("package") == PACKAGE for n in nodes):
                screenshot(f"android-{stage}.png")
                return
            screenshot(f"android-{stage}-attempt-{attempt}.png")
            title = next((n.get("text", "") for n in nodes if n.get("resource-id") == "android:id/alertTitle"), "")
            wait = next((n for n in nodes if n.get("resource-id") == "android:id/aerr_wait"), None)
            if title == "Pixel Launcher isn't responding" and wait is not None and report["launcher_wait_dialogs"] < 2:
                bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", wait.get("bounds", ""))
                if not bounds:
                    raise RuntimeError("Pixel Launcher Wait button has invalid bounds")
                x1, y1, x2, y2 = map(int, bounds.groups())
                adb("shell", "input", "tap", (x1+x2)//2, (y1+y2)//2)
                report["launcher_wait_dialogs"] += 1
                time.sleep(8)
                adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
            elif "isn't responding" in title or "keeps stopping" in title:
                raise RuntimeError("Unexpected Android failure dialog: " + title)
            else:
                time.sleep(3)
        raise RuntimeError("The expected welcome screen is missing from the Android UI tree")
    try:
        # Lower only the test emulator's rendering load; do not alter app behavior.
        adb("shell", "wm", "size", "720x1600")
        adb("shell", "wm", "density", "280")
        time.sleep(10)
        install = adb("install", "-r", candidates[0])
        if "Success" not in install:
            raise RuntimeError("APK install did not report Success: " + install)
        if "package:" not in adb("shell", "pm", "path", PACKAGE):
            raise RuntimeError("Installed package was not found")
        report["installed"] = True
        adb("shell", "am", "force-stop", PACKAGE)
        adb("logcat", "-c")
        launch = adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
        (OUT / "launch.txt").write_text(launch, encoding="utf-8")
        deadline = time.monotonic() + 50
        while time.monotonic() < deadline:
            logs = adb("logcat", "-d", "-s", "KonofixAndroid:I", "AndroidRuntime:E", "*:S")
            if any(marker in logs for marker in ("KONOFIX_NATIVE_START_FAILED", "KONOFIX_UI_TIMEOUT", "KONOFIX_RENDERER_GONE", "KONOFIX_WEB_ERROR", "FATAL EXCEPTION")):
                raise RuntimeError("Android startup emitted an error; see logcat.txt")
            if "KONOFIX_UI_READY" in logs:
                report["ui_ready"] = True
                break
            time.sleep(1)
        if not report["ui_ready"]:
            raise RuntimeError("WebView never confirmed initialized UI and persistent identity")
        visible_welcome("start")
        report["welcome_visible"] = True
        adb("shell", "input", "keyevent", "KEYCODE_HOME")
        time.sleep(3)
        adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
        time.sleep(2)
        if not adb("shell", "pidof", PACKAGE).strip():
            raise RuntimeError("Application did not survive background/foreground transition")
        visible_welcome("resumed")
        report["survives_home"] = True
        logs = adb("logcat", "-d", "-s", "KonofixAndroid:I", "AndroidRuntime:E", "*:S")
        if any(marker in logs for marker in ("FATAL EXCEPTION", "KONOFIX_WEB_ERROR", "KONOFIX_RENDERER_GONE")):
            raise RuntimeError("Runtime error after background/foreground transition")
        report["result"] = "PASS"
    except Exception as error:
        report["result"] = "FAIL"
        report["error"] = str(error)
        try:
            screenshot("android-failure.png")
        except Exception:
            pass
        raise
    finally:
        logs = adb("logcat", "-d", "-s", "KonofixAndroid:I", "AndroidRuntime:E", "*:S", check=False)
        (OUT / "logcat.txt").write_text(logs, encoding="utf-8")
        (OUT / "smoke-android.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()
