"""Install and launch the SDK APK on exactly one emulator; never target a phone."""
from __future__ import annotations
import json
import subprocess
import time
from pathlib import Path

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
              "survives_home": False, "physical_device_test": False,
              "public_relay_messages_sent": False}
    try:
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
        logs = ""
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
        time.sleep(2)
        adb("shell", "uiautomator", "dump", "/sdcard/konofix-smoke.xml")
        adb("pull", "/sdcard/konofix-smoke.xml", OUT / "ui.xml")
        if "Połączmy się" not in (OUT / "ui.xml").read_text(encoding="utf-8"):
            raise RuntimeError("The expected welcome screen is missing from the Android UI tree")
        with (OUT / "android-start.png").open("wb") as image:
            subprocess.run(["adb", "-s", serial, "exec-out", "screencap", "-p"], stdout=image, timeout=30, check=True)
        adb("shell", "input", "keyevent", "KEYCODE_HOME")
        adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
        time.sleep(2)
        if not adb("shell", "pidof", PACKAGE).strip():
            raise RuntimeError("Application did not survive background/foreground transition")
        report["survives_home"] = True
        logs = adb("logcat", "-d", "-s", "KonofixAndroid:I", "AndroidRuntime:E", "*:S")
        if "FATAL EXCEPTION" in logs or "KONOFIX_WEB_ERROR" in logs:
            raise RuntimeError("Runtime error after background/foreground transition")
        report["result"] = "PASS"
    except Exception as error:
        report["result"] = "FAIL"
        report["error"] = str(error)
        raise
    finally:
        logs = adb("logcat", "-d", "-s", "KonofixAndroid:I", "AndroidRuntime:E", "*:S", check=False)
        (OUT / "logcat.txt").write_text(logs, encoding="utf-8")
        (OUT / "smoke-android.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()
